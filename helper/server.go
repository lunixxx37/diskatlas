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

	elevateMu sync.Mutex
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
	App                string `json:"app"`
	Version            string `json:"version"`
	Protocol           int    `json:"protocol"`
	OS                 string `json:"os"`
	Arch               string `json:"arch"`
	Elevated           bool   `json:"elevated"`
	PID                int    `json:"pid"`
	IdleTimeoutSeconds int64  `json:"idleTimeoutSeconds"`
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
	})
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
	if s.idle <= 0 || s.inFlight.Load() > 0 || s.scanRunning() {
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
