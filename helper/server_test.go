package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// corsHeaders are the headers only an allowed request may get.
var corsHeaders = []string{
	"Access-Control-Allow-Origin", "Vary", "Access-Control-Allow-Methods",
	"Access-Control-Allow-Headers", "Access-Control-Max-Age", "Access-Control-Allow-Private-Network",
}

func wantForbidden(t *testing.T, resp *http.Response, what string) {
	t.Helper()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("%s: status %d, want 403", what, resp.StatusCode)
	}
	for _, h := range corsHeaders {
		if v := resp.Header.Get(h); v != "" {
			t.Errorf("%s: 403 has %s: %s", what, h, v)
		}
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("%s: Cache-Control %q", what, cc)
	}
}

func wantAllowed(t *testing.T, resp *http.Response, origin, what string) {
	t.Helper()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("%s: status %d: %s", what, resp.StatusCode, body)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != origin {
		t.Errorf("%s: Access-Control-Allow-Origin %q, want %q", what, got, origin)
	}
	if got := resp.Header.Get("Vary"); got != "Origin" {
		t.Errorf("%s: Vary %q", what, got)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("%s: Cache-Control %q", what, cc)
	}
}

func TestHostCheck(t *testing.T) {
	h := newTestHelper(t, serverConfig{})
	port := strconv.Itoa(h.srv.port)
	wantAllowed(t, h.request("GET", "/v1/info", ""), testOrigin, "127.0.0.1")
	wantAllowed(t, h.request("GET", "/v1/info", "", "Host", "localhost:"+port), testOrigin, "localhost")
	wantAllowed(t, h.request("GET", "/v1/info", "", "Host", "LocalHost:"+port), testOrigin, "LocalHost")
	for _, host := range []string{
		"evil.example:" + port, // DNS rebinding
		"evil.example",
		"127.0.0.1",
		"localhost",
		"127.0.0.1:1" + port,
		"127.0.0.1:0" + port,
		"[::1]:" + port,
		"0.0.0.0:" + port,
		"127.0.0.2:" + port,
		"localhost.:" + port,
		"LOCALHOST.evil.example:" + port,
	} {
		wantForbidden(t, h.request("GET", "/v1/info", "", "Host", host), "Host "+host)
		wantForbidden(t, h.request("OPTIONS", "/v1/info", "", "Host", host), "OPTIONS with Host "+host)
	}
}

func TestASCIIEqualFold(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"localhost", "localhost", true},
		{"LocalHost", "localhost", true},
		{"TRUE", "true", true},
		{"localhoſt", "localhost", false}, // strings.EqualFold says true
		{"localhos", "localhost", false},
		{"locaIhost", "localhost", false},
	} {
		if got := asciiEqualFold(c.a, c.b); got != c.want {
			t.Errorf("asciiEqualFold(%q, %q) = %t", c.a, c.b, got)
		}
	}
}

func TestOriginCheck(t *testing.T) {
	h := newTestHelper(t, serverConfig{})
	wantForbidden(t, h.request("GET", "/v1/info", "", "Origin", ""), "no Origin")
	wantForbidden(t, h.request("POST", "/v1/shutdown", "{}", "Origin", ""), "POST without Origin")
	for _, origin := range []string{
		"null",
		"https://evil.example",
		"https://lunixxx37.github.io/",
		"http://lunixxx37.github.io",
		"https://lunixxx37.github.io:443",
		"https://LUNIXXX37.github.io",
		"https://lunixxx37.github.io.evil.example",
		"http://localhost:5173", // only with --dev
	} {
		wantForbidden(t, h.request("GET", "/v1/info", "", "Origin", "", "Origin", origin), "Origin "+origin)
		wantForbidden(t, h.request("POST", "/v1/shutdown", "{}", "Origin", "", "Origin", origin), "POST with Origin "+origin)
	}
	// Two Origin headers are refused too.
	wantForbidden(t, h.request("GET", "/v1/info", "", "Origin", "https://evil.example"), "two Origins")
	select {
	case reason := <-h.exits:
		t.Fatalf("a refused shutdown request was carried out: %s", reason)
	default:
	}
}

func TestAllowedOrigins(t *testing.T) {
	discard := log.New(io.Discard, "", 0)
	dev := options{dev: true, origins: []string{"http://localhost:3000"}}
	origins := allowedOrigins(dev, discard)
	want := []string{"https://lunixxx37.github.io", "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"}
	if !reflect.DeepEqual(origins, want) {
		t.Fatalf("allowedOrigins = %q, want %q", origins, want)
	}
	h := newTestHelper(t, serverConfig{origins: origins})
	for _, o := range want {
		wantAllowed(t, h.request("GET", "/v1/info", "", "Origin", "", "Origin", o), o, "Origin "+o)
	}
	if got := allowedOrigins(options{}, discard); !reflect.DeepEqual(got, want[:1]) {
		t.Errorf("without --dev: %q", got)
	}
}

func TestOptions(t *testing.T) {
	h := newTestHelper(t, serverConfig{})
	for _, path := range []string{"/v1/scans", "/v1/info", "/v1/elsewhere"} {
		resp := h.request("OPTIONS", path, "", "Access-Control-Request-Method", "POST", "Access-Control-Request-Headers", "content-type")
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("OPTIONS %s: status %d", path, resp.StatusCode)
		}
		wantAllowed(t, resp, testOrigin, "OPTIONS "+path)
		for k, v := range map[string]string{
			"Access-Control-Allow-Methods": "GET, POST",
			"Access-Control-Allow-Headers": "Content-Type",
			"Access-Control-Max-Age":       "600",
		} {
			if got := resp.Header.Get(k); got != v {
				t.Errorf("OPTIONS %s: %s = %q, want %q", path, k, got, v)
			}
		}
		if got := resp.Header.Get("Access-Control-Allow-Private-Network"); got != "" {
			t.Errorf("Access-Control-Allow-Private-Network without the request header: %q", got)
		}
	}
	resp := h.request("OPTIONS", "/v1/info", "", "Access-Control-Request-Private-Network", "true")
	if got := resp.Header.Get("Access-Control-Allow-Private-Network"); resp.StatusCode != http.StatusNoContent || got != "true" {
		t.Errorf("private network preflight: status %d, header %q", resp.StatusCode, got)
	}
	wantForbidden(t, h.request("OPTIONS", "/v1/info", "", "Origin", "", "Access-Control-Request-Private-Network", "true"), "OPTIONS without Origin")
	wantForbidden(t, h.request("OPTIONS", "/v1/info", "", "Origin", "", "Origin", "https://evil.example"), "OPTIONS from another origin")
}

func TestRoutingAndErrors(t *testing.T) {
	h := newTestHelper(t, serverConfig{})
	for _, c := range []struct{ method, path string }{
		{"GET", "/"},
		{"GET", "/v1"},
		{"GET", "/v1/"},
		{"GET", "/v1/nope"},
		{"GET", "/v2/info"},
		{"POST", "/v1/info"}, // wrong method: an unknown endpoint
		{"GET", "/v1/scans"},
		{"GET", "/v1/shutdown"},
		{"PUT", "/v1/scans"},
		{"DELETE", "/v1/scans/s1"},
		{"GET", "/v1/info/"},
		{"GET", "/v1/scans/s1/"},
		{"GET", "/v1/scans/s1/result/x"},
		{"GET", "/v1/scans/s1"}, // no such scan
		{"GET", "/v1/scans/s1/result"},
		{"POST", "/v1/scans/s1/cancel"},
	} {
		resp := h.request(c.method, c.path, "")
		wantAllowedHeaders(t, resp, c.method+" "+c.path)
		h.wantError(c.method, c.path, "", http.StatusNotFound, codeNotFound)
	}

	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		body   string
		status int
		code   string
	}{
		{"{", http.StatusBadRequest, codeBadRequest},
		{"not json", http.StatusBadRequest, codeBadRequest},
		{"[]", http.StatusBadRequest, codeBadRequest},
		{`{"path": 5}`, http.StatusBadRequest, codeBadRequest},
		{"", http.StatusBadRequest, codeBadRequest}, // {}: no path
		{"null", http.StatusBadRequest, codeBadRequest},
		{`{"path": ""}`, http.StatusBadRequest, codeBadRequest},
		{`{"path": "relative/dir"}`, http.StatusBadRequest, codeBadRequest},
		{`{"path": ` + jsonString(filepath.Join(dir, "missing")) + `}`, http.StatusNotFound, codeNotFound},
		{`{"path": ` + jsonString(filepath.Join(dir, "missing", "deeper")) + `}`, http.StatusNotFound, codeNotFound},
		{`{"path": ` + jsonString(file) + `}`, http.StatusConflict, codeNotADirectory},
	} {
		h.wantError("POST", "/v1/scans", c.body, c.status, c.code)
	}
	for _, path := range []string{"/v1/shutdown", "/v1/uninstall", "/v1/elevate"} {
		h.wantError("POST", path, "{nope", http.StatusBadRequest, codeBadRequest)
	}
	select {
	case reason := <-h.exits:
		t.Fatalf("an invalid request made the helper exit: %s", reason)
	default:
	}
}

func wantAllowedHeaders(t *testing.T, resp *http.Response, what string) {
	t.Helper()
	if resp.Header.Get("Access-Control-Allow-Origin") != testOrigin || resp.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("%s: headers %v", what, resp.Header)
	}
}

func TestInfo(t *testing.T) {
	h := newTestHelper(t, serverConfig{})
	v := h.call("GET", "/v1/info", "", http.StatusOK)
	want := map[string]any{
		"app":                "diskatlas-helper",
		"version":            "0.1.0-test",
		"protocol":           float64(1),
		"os":                 runtime.GOOS,
		"arch":               runtime.GOARCH,
		"elevated":           false,
		"pid":                float64(os.Getpid()),
		"idleTimeoutSeconds": float64(600),
		"features":           []any{"scan"}, // no clean-up actions configured
	}
	if !reflect.DeepEqual(v, want) {
		t.Errorf("info = %v\nwant %v", v, want)
	}
	h.sys.set(func(f *fakeSystem) { f.isElevated = true })
	if v := h.call("GET", "/v1/info", "", http.StatusOK); v["elevated"] != true {
		t.Errorf("elevated: %v", v)
	}
}

func TestDrivesEndpoint(t *testing.T) {
	h := newTestHelper(t, serverConfig{})
	v := h.call("GET", "/v1/drives", "", http.StatusOK)
	if fmt.Sprint(v["drives"]) != "[]" {
		t.Errorf("no drives: %v", v)
	}
	h.sys.set(func(f *fakeSystem) {
		f.driveList = []drive{
			{Path: `C:\`, Label: "Windows", FileSystem: "NTFS", Type: "fixed", Ready: true, TotalBytes: 511101161472, FreeBytes: 102030405060, ClusterBytes: 4096},
			{Path: `E:\`, Type: "removable"},
		}
	})
	v = h.call("GET", "/v1/drives", "", http.StatusOK)
	want := `{"drives":[{"clusterBytes":4096,"fileSystem":"NTFS","freeBytes":102030405060,"label":"Windows","path":"C:\\","ready":true,"totalBytes":511101161472,"type":"fixed"},` +
		`{"clusterBytes":0,"fileSystem":"","freeBytes":0,"label":"","path":"E:\\","ready":false,"totalBytes":0,"type":"removable"}]}`
	if got := jsonString(v); got != want {
		t.Errorf("drives = %s\nwant %s", got, want)
	}
}

func TestElevate(t *testing.T) {
	args := []string{"--serve", "--takeover", "--port", "41417", "--idle", "10m0s"}

	h := newTestHelper(t, serverConfig{elevateArgs: args})
	h.sys.set(func(f *fakeSystem) { f.isElevated = true })
	if v := h.call("POST", "/v1/elevate", "", http.StatusOK); jsonString(v) != `{"elevated":true}` {
		t.Errorf("already elevated: %v", v)
	}
	h.sys.set(func(f *fakeSystem) {
		if len(f.restartArgs) != 0 {
			t.Errorf("restarted although elevated")
		}
	})

	h = newTestHelper(t, serverConfig{elevateArgs: args})
	h.sys.set(func(f *fakeSystem) { f.restartErr = errElevationCancelled })
	if v := h.call("POST", "/v1/elevate", "{}", http.StatusOK); jsonString(v) != `{"cancelled":true,"elevated":false}` {
		t.Errorf("declined: %v", v)
	}
	h.sys.set(func(f *fakeSystem) {
		if !reflect.DeepEqual(f.restartArgs, [][]string{args}) {
			t.Errorf("restart args %q", f.restartArgs)
		}
		f.restartErr = errors.New("boom")
	})
	h.wantError("POST", "/v1/elevate", "", http.StatusInternalServerError, codeInternal)

	h.sys.set(func(f *fakeSystem) { f.restartErr = nil })
	select {
	case reason := <-h.exits:
		t.Fatalf("exited before a successful restart: %s", reason)
	default:
	}
	if v := h.call("POST", "/v1/elevate", "", http.StatusAccepted); jsonString(v) != `{"restarting":true}` {
		t.Errorf("accepted: %v", v)
	}
	select {
	case reason := <-h.exits:
		t.Logf("exit: %s", reason)
	case <-time.After(5 * time.Second):
		t.Fatal("the helper didn't exit after restarting elevated")
	}
	if len(h.exits) != 0 {
		t.Errorf("more exits: %d", len(h.exits))
	}
}

func TestShutdownAndUninstall(t *testing.T) {
	h := newTestHelper(t, serverConfig{})
	if v := h.call("POST", "/v1/shutdown", "", http.StatusAccepted); jsonString(v) != "{}" {
		t.Errorf("shutdown: %v", v)
	}
	if reason := <-h.exits; reason != "shutdown requested" {
		t.Errorf("exit reason %q", reason)
	}

	h = newTestHelper(t, serverConfig{})
	h.sys.set(func(f *fakeSystem) { f.unregisterErr = errors.New("access denied") })
	h.wantError("POST", "/v1/uninstall", "", http.StatusInternalServerError, codeInternal)
	if len(h.exits) != 0 {
		t.Fatalf("exited although the uninstall failed")
	}
	h.sys.set(func(f *fakeSystem) { f.unregisterErr = nil })
	if v := h.call("POST", "/v1/uninstall", "{}", http.StatusOK); jsonString(v) != "{}" {
		t.Errorf("uninstall: %v", v)
	}
	if reason := <-h.exits; reason != "uninstall requested" {
		t.Errorf("exit reason %q", reason)
	}
	h.sys.set(func(f *fakeSystem) {
		if f.unregistered != 2 {
			t.Errorf("unregistered %d times, want 2", f.unregistered)
		}
	})
}

func TestIdleExpired(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	h := newTestHelper(t, serverConfig{idle: time.Minute, list: blockingList(release, nil)})
	s := h.srv
	now := time.Now()
	s.activity.Store(now.Add(-59 * time.Second).UnixNano())
	if s.idleExpired(now) {
		t.Error("expired after 59 s")
	}
	s.activity.Store(now.Add(-61 * time.Second).UnixNano())
	if !s.idleExpired(now) {
		t.Error("not expired after 61 s")
	}
	// Not while a request is being answered, such as a UAC prompt left open.
	s.inFlight.Add(1)
	if s.idleExpired(now) {
		t.Error("expired during a request")
	}
	s.inFlight.Add(-1)

	// Not while a scan runs, however long ago the last request was.
	h.call("POST", "/v1/scans", `{"path": `+jsonString(t.TempDir())+`}`, http.StatusAccepted)
	s.activity.Store(now.Add(-time.Hour).UnixNano())
	if s.idleExpired(now) {
		t.Error("expired while a scan runs")
	}
	// The end of a scan counts as activity.
	h.call("POST", "/v1/scans/s1/cancel", "", http.StatusAccepted)
	if s.idleExpired(time.Now()) {
		t.Error("expired right after the scan ended")
	}
	if !s.idleExpired(time.Now().Add(61 * time.Second)) {
		t.Error("not expired a minute after the scan ended")
	}

	s.idle = 0 // --idle 0: never
	if s.idleExpired(time.Now().Add(1000 * time.Hour)) {
		t.Error("expired with --idle 0")
	}
}

func TestWatchIdle(t *testing.T) {
	// The idle time is far longer than the gaps between requests, so a slow
	// CI machine doesn't exit early.
	h := newTestHelper(t, serverConfig{idle: 600 * time.Millisecond})
	done := make(chan struct{})
	defer close(done)
	start := time.Now()
	go h.srv.watchIdle(done)
	// Requests keep it alive.
	for time.Since(start) < 1200*time.Millisecond {
		h.call("GET", "/v1/info", "", http.StatusOK)
		time.Sleep(30 * time.Millisecond)
	}
	select {
	case reason := <-h.exits:
		t.Fatalf("exited while busy: %s", reason)
	default:
	}
	select {
	case reason := <-h.exits:
		t.Logf("exit after %v: %s", time.Since(start), reason)
	case <-time.After(5 * time.Second):
		t.Fatal("no idle exit")
	}
}
