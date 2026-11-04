package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const usage = `Usage: DiskAtlas-Helper [options]

Without options the helper registers the diskatlas-helper:// link for the
current user, listens on 127.0.0.1 and opens the DiskAtlas website.

Options:
  --dev              also allow the dev server (http://localhost:5173 and
                     http://127.0.0.1:5173) and open it instead of the website
  --origin <origin>  allow one more website origin (repeatable)
  --port <n>         listen on this port only (default: the first free one
                     of 41417, 41418, 41419)
  --idle <duration>  exit after this long without requests, e.g. 30m or 90s
                     (default 10m; 0 never exits)
  --serve            listen only: don't register the link or open the website
  --no-open          don't open the website
  --uninstall        remove the diskatlas-helper:// link and exit
  --version          print the version and exit
`

// options are the parsed command line.
type options struct {
	dev       bool
	origins   []string // normalized
	port      int      // 0: the default ports
	idle      time.Duration
	serve     bool
	noOpen    bool
	uninstall bool
	version   bool
	// takeover is internal, for /v1/elevate: wait up to 15 s for --port to
	// become free instead of looking for a running helper.
	takeover  bool
	launchURL string // the diskatlas-helper:// link the helper was started with
	ignored   int    // other positional arguments
}

// parseArgs parses the command line. When Windows starts the helper from the
// link, the link is the last argument, after the registered flags. Flag
// parsing stops at it, so nothing in a link can act as a flag.
func parseArgs(args []string) (options, error) {
	opts := options{idle: defaultIdle}
	fs := flag.NewFlagSet("DiskAtlas-Helper", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.BoolVar(&opts.dev, "dev", false, "")
	fs.Var((*originsFlag)(&opts.origins), "origin", "")
	fs.IntVar(&opts.port, "port", 0, "")
	fs.Var((*idleFlag)(&opts.idle), "idle", "")
	fs.BoolVar(&opts.serve, "serve", false, "")
	fs.BoolVar(&opts.noOpen, "no-open", false, "")
	fs.BoolVar(&opts.uninstall, "uninstall", false, "")
	fs.BoolVar(&opts.version, "version", false, "")
	fs.BoolVar(&opts.takeover, "takeover", false, "")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	for _, a := range fs.Args() {
		if opts.launchURL == "" && isLaunchURL(a) {
			opts.launchURL = a
		} else {
			opts.ignored++
		}
	}
	if opts.port < 0 || opts.port > 65535 {
		return opts, fmt.Errorf("invalid port %d", opts.port)
	}
	if opts.takeover && opts.port == 0 {
		return opts, errors.New("--takeover needs --port")
	}
	return opts, nil
}

func isLaunchURL(s string) bool {
	return len(s) > len(protocolScheme) && strings.EqualFold(s[:len(protocolScheme)+1], protocolScheme+":")
}

type originsFlag []string

func (f *originsFlag) String() string { return strings.Join(*f, ",") }

func (f *originsFlag) Set(v string) error {
	o, err := normalizeOrigin(v)
	if err != nil {
		return err
	}
	*f = append(*f, o)
	return nil
}

type idleFlag time.Duration

func (f *idleFlag) String() string { return time.Duration(*f).String() }

// Set accepts a Go duration ("10m", "90s") or a number of seconds.
func (f *idleFlag) Set(v string) error {
	if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 && n <= int64(time.Duration(1<<63-1)/time.Second) {
		*f = idleFlag(time.Duration(n) * time.Second)
		return nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		return fmt.Errorf("invalid duration %q", v)
	}
	*f = idleFlag(d)
	return nil
}

// normalizeOrigin returns an origin the way browsers send it in the Origin
// header: lower-case scheme and host, no default port, no path.
func normalizeOrigin(s string) (string, error) {
	u, err := url.Parse(s)
	if err != nil {
		return "", fmt.Errorf("invalid origin %q", s)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" || u.Host == "" || u.Opaque != "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return "", fmt.Errorf("invalid origin %q: use the form https://example.com or http://localhost:3000", s)
	}
	host := strings.ToLower(u.Host)
	if scheme == "http" {
		host = strings.TrimSuffix(host, ":80")
	} else {
		host = strings.TrimSuffix(host, ":443")
	}
	return scheme + "://" + host, nil
}

// protocolCommand is the command Windows runs for a diskatlas-helper:// link.
// It keeps --dev and --origin of the run that registers it, so a helper
// started from the website allows the same origins.
func protocolCommand(exe string, opts options) string {
	var b strings.Builder
	b.WriteString(`"` + exe + `"`)
	if opts.dev {
		b.WriteString(" --dev")
	}
	for _, o := range opts.origins {
		b.WriteString(" --origin " + quoteWindowsArg(o))
	}
	b.WriteString(` "%1"`)
	return b.String()
}

// elevatedArgs are the arguments of the instance /v1/elevate starts: it only
// listens (the link is registered and the website is open already), takes
// over this port, and keeps the origins and the idle time.
func elevatedArgs(opts options, port int) []string {
	args := []string{"--serve", "--takeover", "--port", strconv.Itoa(port), "--idle", opts.idle.String()}
	if opts.dev {
		args = append(args, "--dev")
	}
	for _, o := range opts.origins {
		args = append(args, "--origin", o)
	}
	return args
}

// quoteWindowsArg quotes s for a Windows command line, following the rules of
// CommandLineToArgvW (backslashes are only special before a quote).
func quoteWindowsArg(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\n\v\"") {
		return s
	}
	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '\\':
			slashes++
			continue
		case '"':
			b.WriteString(strings.Repeat(`\`, 2*slashes+1))
		default:
			b.WriteString(strings.Repeat(`\`, slashes))
		}
		slashes = 0
		b.WriteByte(s[i])
	}
	b.WriteString(strings.Repeat(`\`, 2*slashes))
	b.WriteByte('"')
	return b.String()
}

// joinWindowsArgs builds a Windows command line from separate arguments.
func joinWindowsArgs(args []string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = quoteWindowsArg(a)
	}
	return strings.Join(quoted, " ")
}
