package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Error codes of the API (docs/helper-protocol.md, "Errors").
const (
	codeBadRequest     = "bad_request"
	codeNotFound       = "not_found"
	codeNotADirectory  = "not_a_directory"
	codeScanRunning    = "scan_running"
	codeBusy           = "busy" // a folder dialog is already open
	codeInternal       = "internal"
	codeForbidden      = "forbidden" // 403 only; the website never sees it
	maxRequestBodySize = 64 << 10
	maxRejectionLogs   = 20
)

var (
	errElevationCancelled   = errors.New("the user declined the administrator prompt")
	errElevationUnsupported = errors.New("restarting with administrator rights is not supported on this system")
)

// system is what the server needs from the operating system. platformSystem
// is the real one; tests use a fake.
type system interface {
	elevated() bool
	// restartElevated starts the helper again with administrator rights and
	// args. It returns errElevationCancelled if the user declined.
	restartElevated(args []string) error
	drives() []drive
	// unregister removes the diskatlas-helper:// link registration.
	unregister() error
}

type platformSystem struct{}

func (platformSystem) elevated() bool                      { return isElevated() }
func (platformSystem) restartElevated(args []string) error { return restartElevated(args) }
func (platformSystem) drives() []drive                     { return listDrives() }
func (platformSystem) unregister() error                   { return unregisterProtocol() }

// drive is one entry of GET /v1/drives.
type drive struct {
	Path         string `json:"path"`
	Label        string `json:"label"`
	FileSystem   string `json:"fileSystem"`
	Type         string `json:"type"`
	Ready        bool   `json:"ready"`
	TotalBytes   uint64 `json:"totalBytes"`
	FreeBytes    uint64 `json:"freeBytes"`
	ClusterBytes uint64 `json:"clusterBytes"`
}

type serverConfig struct {
	version     string
	port        int      // the port the helper listens on; the Host header must name it
	origins     []string // allowed origins, normalized
	idle        time.Duration
	logger      *log.Logger
	sys         system
	list        listFunc
	workers     int
	elevateArgs []string     // arguments for the elevated instance
	exit        func(string) // asks the helper to shut down, with a reason for the log
	// linkChanged: this run created or changed the diskatlas-helper:// link,
	// so browsers that were already running can't open it before a restart.
	linkChanged bool
	// cleanup (recycle and delete) and reveal are the clean-up actions; nil
	// where the system has none (then /v1/info doesn't list them and their
	// endpoints are unknown).
	cleanup cleanupSystem
	reveal  func(path string) error
	// pick shows the folder dialog and returns the chosen folder, or
	// cancelled; nil where there is none.
	pick func(title, startPath string) (path string, cancelled bool, err error)
}

// server implements the helper's HTTP API.
type server struct {
	serverConfig
	allowed map[string]bool

	activity atomic.Int64 // UnixNano of the last allowed request or scan end
	inFlight atomic.Int32 // allowed requests being answered
	rejected atomic.Int32 // rejected requests logged so far

	mu     sync.Mutex
	nextID int
	cur    *scan // the only scan; nil before the first one

	elevateMu   sync.Mutex
	cleanupMu   sync.Mutex   // one recycle or delete request at a time
	cleanupBusy atomic.Int32 // recycle or delete requests running or waiting
	picking     atomic.Bool  // a folder dialog is open
}

func newServer(cfg serverConfig) *server {
	if cfg.logger == nil {
		cfg.logger = log.New(io.Discard, "", 0)
	}
	if cfg.sys == nil {
		cfg.sys = platformSystem{}
	}
	if cfg.list == nil {
		cfg.list = listDir
	}
	if cfg.workers <= 0 {
		cfg.workers = defaultWorkers()
	}
	if cfg.exit == nil {
		cfg.exit = func(string) {}
	}
	s := &server{serverConfig: cfg, allowed: make(map[string]bool)}
	for _, o := range cfg.origins {
		s.allowed[o] = true
	}
	s.touch()
	return s
}

func (s *server) touch() { s.activity.Store(time.Now().UnixNano()) }

// ServeHTTP checks every request (OPTIONS included) before anything else:
// the Host header must name this helper on the loopback interface (against
// DNS rebinding), and the Origin must be an allowed one.
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	if !s.hostAllowed(r.Host) {
		s.reject(w, r, "host")
		return
	}
	origins := r.Header.Values("Origin")
	if len(origins) != 1 || !s.allowed[origins[0]] {
		s.reject(w, r, "origin")
		return
	}
	h.Set("Access-Control-Allow-Origin", origins[0])
	h.Set("Vary", "Origin")
	// A long request (a result download, the UAC prompt) keeps the helper
	// busy until it ends.
	s.touch()
	s.inFlight.Add(1)
	defer func() {
		s.touch()
		s.inFlight.Add(-1)
	}()

	if r.Method == http.MethodOptions {
		h.Set("Access-Control-Allow-Methods", "GET, POST")
		h.Set("Access-Control-Allow-Headers", "Content-Type")
		h.Set("Access-Control-Max-Age", "600")
		if asciiEqualFold(r.Header.Get("Access-Control-Request-Private-Network"), "true") {
			h.Set("Access-Control-Allow-Private-Network", "true")
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.route(w, r)
}

func (s *server) hostAllowed(host string) bool {
	name, port, err := net.SplitHostPort(host)
	if err != nil || port != strconv.Itoa(s.port) {
		return false
	}
	return name == "127.0.0.1" || asciiEqualFold(name, "localhost")
}

// asciiEqualFold compares case-insensitively, but only for ASCII letters:
// strings.EqualFold would also match Unicode look-alikes such as "ſ" for "s".
func asciiEqualFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		if lowerASCII(a[i]) != lowerASCII(b[i]) {
			return false
		}
	}
	return true
}

func lowerASCII(c byte) byte {
	if 'A' <= c && c <= 'Z' {
		return c + 'a' - 'A'
	}
	return c
}

// reject answers 403 without CORS headers, so a browser page can't read it.
func (s *server) reject(w http.ResponseWriter, r *http.Request, what string) {
	if s.rejected.Add(1) <= maxRejectionLogs {
		s.logger.Printf("rejected a request: bad %s (host %.100q, origin %.100q)", what, r.Host, r.Header.Get("Origin"))
	}
	writeError(w, http.StatusForbidden, codeForbidden, "this "+what+" is not allowed")
}

// route dispatches by method and path. An endpoint is a method and a path,
// so a known path with another method is an unknown endpoint too.
func (s *server) route(w http.ResponseWriter, r *http.Request) {
	rest, ok := strings.CutPrefix(r.URL.Path, "/v1/")
	if !ok {
		s.notFound(w)
		return
	}
	seg := strings.Split(rest, "/")
	get, post := r.Method == http.MethodGet, r.Method == http.MethodPost
	switch {
	case len(seg) == 1 && seg[0] == "info" && get:
		s.handleInfo(w)
	case len(seg) == 1 && seg[0] == "drives" && get:
		s.handleDrives(w)
	case len(seg) == 1 && seg[0] == "scans" && post:
		s.handleStartScan(w, r)
	case len(seg) == 2 && seg[0] == "scans" && get:
		s.handleProgress(w, seg[1])
	case len(seg) == 3 && seg[0] == "scans" && seg[2] == "result" && get:
		s.handleResult(w, seg[1])
	case len(seg) == 3 && seg[0] == "scans" && seg[2] == "cancel" && post:
		s.handleCancel(w, r, seg[1])
	case len(seg) == 1 && seg[0] == "pick-folder" && post && s.pick != nil:
		s.handlePickFolder(w, r)
	case len(seg) == 1 && seg[0] == "reveal" && post && s.reveal != nil:
		s.handleReveal(w, r)
	case len(seg) == 1 && seg[0] == "recycle" && post && s.cleanup != nil:
		s.handleRecycle(w, r)
	case len(seg) == 1 && seg[0] == "delete" && post && s.cleanup != nil:
		s.handleDelete(w, r)
	case len(seg) == 1 && seg[0] == "elevate" && post:
		s.handleElevate(w, r)
	case len(seg) == 1 && seg[0] == "shutdown" && post:
		s.handleShutdown(w, r)
	case len(seg) == 1 && seg[0] == "uninstall" && post:
		s.handleUninstall(w, r)
	default:
		s.notFound(w)
	}
}

func (s *server) notFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, codeNotFound, "unknown endpoint")
}

type infoJSON struct {
	App                string   `json:"app"`
	Version            string   `json:"version"`
	Protocol           int      `json:"protocol"`
	OS                 string   `json:"os"`
	Arch               string   `json:"arch"`
	Elevated           bool     `json:"elevated"`
	PID                int      `json:"pid"`
	IdleTimeoutSeconds int64    `json:"idleTimeoutSeconds"`
	Features           []string `json:"features"`
	LinkChanged        bool     `json:"linkChanged"`
}

func (s *server) handleInfo(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, infoJSON{
		App:                appName,
		Version:            s.version,
		Protocol:           protocolVersion,
		OS:                 runtime.GOOS,
		Arch:               runtime.GOARCH,
		Elevated:           s.sys.elevated(),
		PID:                os.Getpid(),
		IdleTimeoutSeconds: int64(s.idle / time.Second),
		Features:           s.features(),
		LinkChanged:        s.linkChanged,
	})
}

// features lists the actions this helper offers; the website offers only these.
func (s *server) features() []string {
	f := []string{"scan"}
	if s.pick != nil {
		f = append(f, "pick")
	}
	if s.reveal != nil {
		f = append(f, "reveal")
	}
	if s.cleanup != nil {
		f = append(f, "recycle", "delete")
	}
	return f
}

// handlePickFolder shows Windows' folder dialog (POST /v1/pick-folder). One
// dialog at a time; the request stays open until the user decides, and the
// idle exit waits for it.
func (s *server) handlePickFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title     *string `json:"title"`
		StartPath *string `json:"startPath"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	var title, start string
	if req.Title != nil {
		title = *req.Title
	}
	if req.StartPath != nil {
		if c, err := cleanWindowsPath(*req.StartPath); err == nil {
			start = c // a path that isn't valid is ignored, like one that doesn't exist
		}
	}
	if !s.picking.CompareAndSwap(false, true) {
		writeError(w, http.StatusConflict, codeBusy, "a folder dialog is already open")
		return
	}
	defer s.picking.Store(false)
	defer s.touch() // the idle time starts when the dialog closes

	raw, cancelled, err := s.pick(title, start)
	switch {
	case err != nil:
		s.logger.Printf("error: the folder dialog failed: %v", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "the folder dialog failed: "+err.Error())
	case cancelled:
		writeJSON(w, http.StatusOK, map[string]bool{"cancelled": true})
	default:
		p, err := cleanWindowsPath(raw)
		if err != nil {
			s.logger.Printf("error: the folder dialog returned an unusable path: %v", err)
			writeError(w, http.StatusInternalServerError, codeInternal, "the folder dialog returned a path the helper can't use")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"path": p})
	}
}

// handleReveal opens File Explorer with the item selected.
func (s *server) handleReveal(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path *string `json:"path"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Path == nil || *req.Path == "" {
		writeError(w, http.StatusBadRequest, codeBadRequest, "the path is missing")
		return
	}
	p, err := cleanWindowsPath(*req.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
		return
	}
	switch err := s.reveal(p); {
	case err == nil:
		writeJSON(w, http.StatusOK, struct{}{})
	case errors.Is(err, errPathNotFound):
		writeError(w, http.StatusNotFound, codeNotFound, "the item does not exist: "+p)
	case errors.Is(err, errPathInvalid):
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
	default:
		s.logger.Printf("error: could not show an item in File Explorer: %v", err)
		writeError(w, http.StatusInternalServerError, codeInternal, err.Error())
	}
}

// cleanupItemsError checks the items of a recycle or delete request; "" if
// they are fine.
func cleanupItemsError(items []recycleItem) string {
	if n := len(items); n < 1 || n > maxRecycleItems {
		return fmt.Sprintf("items must hold 1 to %d entries, not %d", maxRecycleItems, n)
	}
	for i, it := range items {
		if it.IsDir == nil || (!*it.IsDir && (it.Size == nil || it.Mtime == nil)) {
			return fmt.Sprintf("item %d needs isDir, and for a file also size and mtime", i)
		}
	}
	return ""
}

// runCleanup runs one recycle or delete request off the HTTP goroutine, one
// at a time. The work goes on to the end even if the website stops waiting
// (it logs its own results), and the helper doesn't exit while it runs. It
// returns false if the website went away first.
func (s *server) runCleanup(r *http.Request, work func()) bool {
	s.cleanupBusy.Add(1)
	done := make(chan struct{})
	go func() {
		defer s.cleanupBusy.Add(-1)
		defer close(done)
		s.cleanupMu.Lock()
		defer s.cleanupMu.Unlock()
		work()
	}()
	select {
	case <-done:
		return true
	case <-r.Context().Done():
		return false
	}
}

// waitCleanup waits until no recycle or delete runs any more, at most for
// timeout, so the helper doesn't exit in the middle of one.
func (s *server) waitCleanup(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for s.cleanupBusy.Load() > 0 {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

// handleRecycle checks items and moves those that pass to the Recycle Bin
// (docs/helper-protocol.md, POST /v1/recycle).
func (s *server) handleRecycle(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Items  []recycleItem `json:"items"`
		DryRun bool          `json:"dryRun"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if msg := cleanupItemsError(req.Items); msg != "" {
		writeError(w, http.StatusBadRequest, codeBadRequest, msg)
		return
	}
	var results []recycleResult
	var err error
	if !s.runCleanup(r, func() {
		var dropErr error
		results, err, dropErr = recycleAsUser(s.cleanup, req.Items, req.DryRun)
		if dropErr != nil {
			s.logger.Printf("error: recycle refused: %v", dropErr)
		}
		if err != nil {
			s.logger.Printf("error: recycle: %v", err)
			return
		}
		s.logCleanup("recycle", req.Items, req.DryRun, len(results), func(i int) (string, string) {
			return results[i].Status, results[i].Message
		})
	}) {
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Results []recycleResult `json:"results"`
	}{results})
}

// handleDelete checks items like handleRecycle and deletes those that pass
// permanently (docs/helper-protocol.md, POST /v1/delete). Unless it is a dry
// run, the request must say confirm: "permanent".
func (s *server) handleDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Items   []recycleItem `json:"items"`
		DryRun  bool          `json:"dryRun"`
		Confirm *string       `json:"confirm"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if msg := cleanupItemsError(req.Items); msg != "" {
		writeError(w, http.StatusBadRequest, codeBadRequest, msg)
		return
	}
	if !req.DryRun && (req.Confirm == nil || *req.Confirm != confirmPermanent) {
		writeError(w, http.StatusBadRequest, codeBadRequest, `deleting permanently needs "confirm": "permanent"`)
		return
	}
	var results []deleteResult
	var err error
	if !s.runCleanup(r, func() {
		var dropErr error
		results, err, dropErr = deleteAsUser(s.cleanup, req.Items, req.DryRun)
		if dropErr != nil {
			s.logger.Printf("error: delete refused: %v", dropErr)
		}
		if err != nil {
			s.logger.Printf("error: delete: %v", err)
			return
		}
		s.logCleanup("delete", req.Items, req.DryRun, len(results), func(i int) (string, string) {
			res := results[i]
			counts := fmt.Sprintf("%d files and %d folders deleted, %d failed", res.DeletedFiles, res.DeletedFolders, res.FailedEntries)
			if res.Message != "" {
				counts += ": " + res.Message
			}
			return res.Status, counts
		})
	}) {
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Results []deleteResult `json:"results"`
	}{results})
}

// logCleanup logs every item of a real recycle or delete with its path,
// status and size or counts; the user picked these paths. A dry run gets
// one line of counts per status.
func (s *server) logCleanup(action string, items []recycleItem, dryRun bool, n int, result func(int) (status, detail string)) {
	if dryRun {
		counts := map[string]int{}
		var order []string
		for i := range n {
			st, _ := result(i)
			if counts[st] == 0 {
				order = append(order, st)
			}
			counts[st]++
		}
		parts := make([]string, len(order))
		for i, st := range order {
			parts[i] = fmt.Sprintf("%d %s", counts[st], st)
		}
		s.logger.Printf("%s check (dry run): %s", action, strings.Join(parts, ", "))
		return
	}
	for i := range n {
		what := "file"
		if *items[i].IsDir {
			what = "folder"
		}
		if items[i].Size != nil {
			what += fmt.Sprintf(", %.0f bytes", *items[i].Size)
		}
		st, detail := result(i)
		if detail != "" {
			detail = ": " + detail
		}
		s.logger.Printf("%s %s (%s): %s%s", action, items[i].Path, what, st, detail)
	}
}

func (s *server) handleDrives(w http.ResponseWriter) {
	drives := s.sys.drives()
	if drives == nil {
		drives = []drive{}
	}
	writeJSON(w, http.StatusOK, struct {
		Drives []drive `json:"drives"`
	}{drives})
}

func (s *server) handleStartScan(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path      *string `json:"path"`
		Allocated *bool   `json:"allocated"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Path == nil || *req.Path == "" {
		writeError(w, http.StatusBadRequest, codeBadRequest, "the path is missing")
		return
	}
	allocated := req.Allocated == nil || *req.Allocated
	sc, err := s.startScan(*req.Path, allocated)
	switch {
	case err == nil:
		writeJSON(w, http.StatusAccepted, map[string]string{"id": sc.id})
	case errors.Is(err, errPathRelative), errors.Is(err, errPathInvalid):
		writeError(w, http.StatusBadRequest, codeBadRequest, err.Error())
	case errors.Is(err, errPathNotFound):
		writeError(w, http.StatusNotFound, codeNotFound, err.Error())
	case errors.Is(err, errNotDirectory):
		writeError(w, http.StatusConflict, codeNotADirectory, err.Error())
	default:
		s.logger.Printf("error: could not start a scan: %v", err)
		writeError(w, http.StatusInternalServerError, codeInternal, err.Error())
	}
}

// startScan cleans and checks the path, cancels and discards the previous
// scan, and starts a new one in the background.
func (s *server) startScan(raw string, allocated bool) (*scan, error) {
	p, err := cleanPath(raw)
	if err != nil {
		return nil, err
	}
	root, err := openRoot(p)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.cur != nil {
		s.cur.finish(stateCancelled, "")
	}
	s.nextID++
	sc := newScan("s"+strconv.Itoa(s.nextID), p, allocated, root, s.list, s.workers)
	sc.onEnd = s.scanEnded
	s.cur = sc
	s.mu.Unlock()
	s.logger.Printf("scan %s started: %s (size on disk: %t)", sc.id, p, allocated)
	go sc.run(root)
	return sc, nil
}

// scanEnded logs a finished scan's totals; never names, only numbers.
func (s *server) scanEnded(sc *scan) {
	s.touch()
	p := sc.progress()
	msg := fmt.Sprintf("scan %s %s after %.1f s: %d entries (%d files, %d folders), %d bytes, %d errors",
		sc.id, p.State, float64(p.ElapsedMs)/1000, p.Entries, p.Files, p.Dirs, p.Bytes, p.Errors)
	if p.Error != "" {
		msg += ": " + p.Error
	}
	s.logger.Print(msg)
	// A large scan leaves much garbage behind (grown columns, folder paths);
	// give it back to the system instead of keeping it while the helper waits.
	go debug.FreeOSMemory()
}

func (s *server) lookup(id string) *scan {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != nil && s.cur.id == id {
		return s.cur
	}
	return nil
}

func (s *server) unknownScan(w http.ResponseWriter, id string) {
	writeError(w, http.StatusNotFound, codeNotFound, fmt.Sprintf("unknown scan %q", id))
}

func (s *server) handleProgress(w http.ResponseWriter, id string) {
	sc := s.lookup(id)
	if sc == nil {
		s.unknownScan(w, id)
		return
	}
	writeJSON(w, http.StatusOK, sc.progress())
}

func (s *server) handleResult(w http.ResponseWriter, id string) {
	sc := s.lookup(id)
	if sc == nil {
		s.unknownScan(w, id)
		return
	}
	res, state, failure := sc.snapshot()
	switch state {
	case stateRunning:
		writeError(w, http.StatusConflict, codeScanRunning, "the scan is still running")
		return
	case stateFailed:
		writeError(w, http.StatusInternalServerError, codeInternal, "the scan failed: "+failure)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.FormatInt(res.encodedLen(), 10))
	w.WriteHeader(http.StatusOK)
	writeResult(w, res) // an error means the client went away
}

func (s *server) handleCancel(w http.ResponseWriter, r *http.Request, id string) {
	if !readJSON(w, r, nil) {
		return
	}
	sc := s.lookup(id)
	if sc == nil {
		s.unknownScan(w, id)
		return
	}
	sc.finish(stateCancelled, "")
	writeJSON(w, http.StatusAccepted, sc.progress())
}

// stopScan cancels a running scan, for shutting down.
func (s *server) stopScan() {
	s.mu.Lock()
	sc := s.cur
	s.mu.Unlock()
	if sc != nil {
		sc.finish(stateCancelled, "")
	}
}

func (s *server) scanRunning() bool {
	s.mu.Lock()
	sc := s.cur
	s.mu.Unlock()
	return sc != nil && sc.running()
}

func (s *server) handleElevate(w http.ResponseWriter, r *http.Request) {
	if !readJSON(w, r, nil) {
		return
	}
	s.elevateMu.Lock()
	defer s.elevateMu.Unlock()
	if s.sys.elevated() {
		writeJSON(w, http.StatusOK, map[string]bool{"elevated": true})
		return
	}
	s.logger.Printf("asking for administrator rights")
	// This waits until the user has answered the UAC prompt.
	err := s.sys.restartElevated(s.elevateArgs)
	switch {
	case errors.Is(err, errElevationCancelled):
		s.logger.Printf("the user declined administrator rights")
		writeJSON(w, http.StatusOK, map[string]bool{"elevated": false, "cancelled": true})
	case err != nil:
		s.logger.Printf("error: could not restart with administrator rights: %v", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not restart with administrator rights: "+err.Error())
	default:
		s.logger.Printf("restarting with administrator rights")
		writeJSON(w, http.StatusAccepted, map[string]bool{"restarting": true})
		s.exitAfter(w, "restarting with administrator rights")
	}
}

func (s *server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if !readJSON(w, r, nil) {
		return
	}
	writeJSON(w, http.StatusAccepted, struct{}{})
	s.exitAfter(w, "shutdown requested")
}

func (s *server) handleUninstall(w http.ResponseWriter, r *http.Request) {
	if !readJSON(w, r, nil) {
		return
	}
	if err := s.sys.unregister(); err != nil {
		s.logger.Printf("error: could not remove the %s:// link: %v", protocolScheme, err)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not remove the link registration: "+err.Error())
		return
	}
	s.logger.Printf("removed the %s:// link", protocolScheme)
	writeJSON(w, http.StatusOK, struct{}{})
	s.exitAfter(w, "uninstall requested")
}

// exitAfter sends the response written so far, then asks the helper to shut
// down. The shutdown closes the listener at once and waits for this request.
func (s *server) exitAfter(w http.ResponseWriter, reason string) {
	http.NewResponseController(w).Flush()
	s.exit(reason)
}

// idleExpired reports whether the helper has been idle long enough to exit:
// no request for the idle time while no scan was running.
func (s *server) idleExpired(now time.Time) bool {
	if s.idle <= 0 || s.inFlight.Load() > 0 || s.cleanupBusy.Load() > 0 || s.picking.Load() || s.scanRunning() {
		return false
	}
	return now.Sub(time.Unix(0, s.activity.Load())) >= s.idle
}

// watchIdle asks the helper to exit once it has been idle, until done closes.
func (s *server) watchIdle(done <-chan struct{}) {
	if s.idle <= 0 {
		return
	}
	t := time.NewTicker(min(max(s.idle/8, 50*time.Millisecond), 15*time.Second))
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case now := <-t.C:
			// A scan's end counts as activity (scanEnded), so the idle time
			// starts when the last request or scan ended.
			if s.idleExpired(now) {
				s.exit(fmt.Sprintf("idle for %s", s.idle))
				return
			}
		}
	}
}

// readJSON reads a POST body as JSON, whatever its content type; an empty
// body counts as {}. v may be nil to only check the syntax. It answers 400
// and returns false if the body is not valid.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBodySize))
	if err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "could not read the request body: "+err.Error())
		return false
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		body = []byte("{}")
	}
	if v == nil {
		if !json.Valid(body) {
			writeError(w, http.StatusBadRequest, codeBadRequest, "the request body is not valid JSON")
			return false
		}
		return true
	}
	if err := json.Unmarshal(body, v); err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest, "the request body is not valid JSON: "+err.Error())
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		status = http.StatusInternalServerError
		buf.Reset()
		buf.WriteString(`{"error":{"code":"internal","message":"could not encode the response"}}` + "\n")
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Content-Length", strconv.Itoa(buf.Len()))
	w.WriteHeader(status)
	w.Write(buf.Bytes())
}

type errorJSON struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var body errorJSON
	body.Error.Code = code
	body.Error.Message = message
	writeJSON(w, status, body)
}
