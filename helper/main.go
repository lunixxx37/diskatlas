// Command DiskAtlas-Helper lets the DiskAtlas website survey what the browser
// can't open: whole drives such as C:\, system folders, and the space files
// take up on disk. It has no window, only reads, and never changes or deletes
// anything. The website talks to it over HTTP on 127.0.0.1; the contract is
// docs/helper-protocol.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"
)

// Build-time settings: go build -ldflags "-X main.version=0.1.0".
var (
	version    = "dev"
	siteURL    = "https://lunixxx37.github.io/diskatlas/"
	siteOrigin = "https://lunixxx37.github.io"
)

const (
	appName         = "diskatlas-helper"
	protocolVersion = 1
	protocolScheme  = "diskatlas-helper"
	devSiteURL      = "http://localhost:5173/"
	defaultIdle     = 10 * time.Minute
	takeoverTimeout = 15 * time.Second
)

var (
	defaultPorts = []int{41417, 41418, 41419}
	devOrigins   = []string{"http://localhost:5173", "http://127.0.0.1:5173"}
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	opts, err := parseArgs(args)
	if errors.Is(err, flag.ErrHelp) {
		attachConsole()
		fmt.Print(usage)
		return 0
	}
	if err != nil {
		attachConsole()
		fmt.Fprintf(os.Stderr, "DiskAtlas-Helper: %v\n\n%s", err, usage)
		logger, closeLog := openLog()
		logger.Printf("bad command line: %v", err)
		closeLog()
		return 2
	}
	if opts.version {
		attachConsole()
		fmt.Printf("%s %s\n", appName, version)
		return 0
	}

	logger, closeLog := openLog()
	defer closeLog()
	if opts.uninstall {
		attachConsole()
		if err := unregisterProtocol(); err != nil {
			logger.Printf("error: could not remove the %s:// link: %v", protocolScheme, err)
			fmt.Fprintf(os.Stderr, "Could not remove the %s:// link: %v\n", protocolScheme, err)
			return 1
		}
		logger.Printf("removed the %s:// link", protocolScheme)
		fmt.Printf("Removed the %s:// link.\n", protocolScheme)
		return 0
	}
	return serve(opts, logger)
}

// How the helper was started.
const (
	modeDoubleClick = "double-click" // no link: register, listen, open the website
	modeLink        = "link"         // started from diskatlas-helper://: register, listen
	modeServe       = "serve"        // --serve: listen only
)

func serve(opts options, logger *log.Logger) int {
	mode := modeDoubleClick
	switch {
	case opts.serve:
		mode = modeServe
	case opts.launchURL != "":
		mode = modeLink
	}
	elevated := isElevated()
	logger.Printf("start: version %s, pid %d, %s/%s, mode %s, elevated %t",
		version, os.Getpid(), runtime.GOOS, runtime.GOARCH, mode, elevated)
	if opts.ignored > 0 {
		logger.Printf("ignored %d unexpected argument(s)", opts.ignored)
	}
	origins := allowedOrigins(opts, logger)

	var ln net.Listener
	var err error
	if opts.takeover {
		// Started by /v1/elevate: the old instance frees the port as it exits.
		ln, err = listenRetry(opts.port, takeoverTimeout)
	} else {
		ports := defaultPorts
		if opts.port != 0 {
			ports = []int{opts.port}
		}
		var existing int
		ln, existing, err = acquirePort(ports, probeHelper)
		if existing != 0 {
			logger.Printf("a helper is already running on port %d", existing)
			if mode == modeDoubleClick && !opts.noOpen {
				openWebsite(opts, logger)
			}
			logger.Printf("stop: already running")
			return 0
		}
	}
	if err != nil {
		logger.Printf("error: could not listen: %v", err)
		logger.Printf("stop: no port")
		return 1
	}
	port := ln.Addr().(*net.TCPAddr).Port
	// Only programs of the helper's own user may connect.
	owners, self := platformOwners(), selfSID()
	if owners != nil && self == "" {
		logger.Printf("error: the helper's own user is unknown, so every connection will be refused")
	}
	ln = requireSameUser(ln, owners, self, logger)

	if mode != modeServe {
		changed, err := registerLink(opts)
		if err != nil {
			logger.Printf("error: could not register the %s:// link: %v", protocolScheme, err)
		} else if changed {
			logger.Printf("registered the %s:// link (new or changed)", protocolScheme)
		} else {
			logger.Printf("registered the %s:// link", protocolScheme)
		}
	}
	if elevated {
		// FindFirstFileExW opens folders with backup intent, so with this
		// privilege it can list folders whose permissions deny even
		// administrators. It grants reading only.
		if err := enableBackupPrivilege(); err != nil {
			logger.Printf("could not enable SeBackupPrivilege: %v", err)
		}
	}

	exitCh := make(chan string, 1)
	srv := newServer(serverConfig{
		version:     version,
		port:        port,
		origins:     origins,
		idle:        opts.idle,
		logger:      logger,
		elevateArgs: elevatedArgs(opts, port),
		cleanup:     platformCleanup(),
		pick:        platformPick(),
		reveal:      platformReveal(),
		exit: func(reason string) {
			select {
			case exitCh <- reason:
			default:
			}
		},
	})
	httpSrv := &http.Server{
		Handler:                      srv,
		ReadHeaderTimeout:            10 * time.Second,
		IdleTimeout:                  2 * time.Minute,
		MaxHeaderBytes:               32 << 10,
		ErrorLog:                     log.New(logger.Writer(), logger.Prefix()+"http: ", logger.Flags()),
		DisableGeneralOptionsHandler: true, // "OPTIONS *" goes through the checks too
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpSrv.Serve(ln) }()
	logger.Printf("listening on 127.0.0.1:%d", port)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.watchIdle(ctx.Done())
	if mode == modeDoubleClick && !opts.noOpen {
		openWebsite(opts, logger)
	}

	var reason string
	select {
	case reason = <-exitCh:
	case <-ctx.Done():
		reason = "signal"
	case err := <-serveErr:
		reason = "server error: " + err.Error()
	}
	stop()
	srv.stopScan()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		httpSrv.Close()
	}
	cancel()
	// A deletion the user confirmed is finished rather than cut off.
	if !srv.waitCleanup(2 * time.Minute) {
		logger.Printf("error: stopping while a recycle or delete is still running")
	}
	logger.Printf("stop: %s", reason)
	return 0
}

// allowedOrigins lists the origins the helper answers: the production site,
// the dev server with --dev, and every --origin.
func allowedOrigins(opts options, logger *log.Logger) []string {
	site, err := normalizeOrigin(siteOrigin)
	if err != nil {
		logger.Printf("error: the built-in site origin %q is not valid: %v", siteOrigin, err)
		site = siteOrigin
	}
	origins := []string{site}
	if opts.dev {
		origins = append(origins, devOrigins...)
	}
	return append(origins, opts.origins...)
}

func openWebsite(opts options, logger *log.Logger) {
	u := siteURL
	if opts.dev {
		u = devSiteURL
	}
	if err := openURL(u); err != nil {
		logger.Printf("error: could not open the website: %v", err)
		return
	}
	logger.Printf("opened %s", u)
}

// registerLink registers the diskatlas-helper:// link for this program,
// keeping this run's --dev and --origin flags. changed reports whether the
// registration was new or different before.
func registerLink(opts options) (changed bool, err error) {
	exe, err := os.Executable()
	if err != nil {
		return false, err
	}
	return registerProtocol(protocolCommand(exe, opts))
}
