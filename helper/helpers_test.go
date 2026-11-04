package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testOrigin = "https://lunixxx37.github.io"

// fakeSystem stands in for elevation, drives and the link registration.
type fakeSystem struct {
	mu            sync.Mutex
	isElevated    bool
	restartErr    error
	restartArgs   [][]string
	unregisterErr error
	unregistered  int
	driveList     []drive
}

func (f *fakeSystem) elevated() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.isElevated
}

func (f *fakeSystem) restartElevated(args []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restartArgs = append(f.restartArgs, args)
	return f.restartErr
}

func (f *fakeSystem) drives() []drive {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.driveList
}

// set changes the fake's settings under its lock.
func (f *fakeSystem) set(change func(f *fakeSystem)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

func (f *fakeSystem) unregister() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unregistered++
	return f.unregisterErr
}

// testHelper is a server on an httptest listener, as the helper runs it.
type testHelper struct {
	t     *testing.T
	srv   *server
	ts    *httptest.Server
	sys   *fakeSystem
	exits chan string
}

func newTestHelper(t *testing.T, cfg serverConfig) *testHelper {
	t.Helper()
	h := &testHelper{t: t, exits: make(chan string, 8)}
	if cfg.sys == nil {
		h.sys = &fakeSystem{}
		cfg.sys = h.sys
	}
	if cfg.origins == nil {
		cfg.origins = []string{testOrigin}
	}
	if cfg.version == "" {
		cfg.version = "0.1.0-test"
	}
	if cfg.idle == 0 {
		cfg.idle = defaultIdle
	}
	cfg.exit = func(reason string) { h.exits <- reason }
	h.srv = newServer(cfg)
	h.ts = httptest.NewUnstartedServer(h.srv)
	h.srv.port = h.ts.Listener.Addr().(*net.TCPAddr).Port
	h.ts.Start()
	t.Cleanup(func() {
		h.srv.stopScan()
		h.ts.Close()
	})
	return h
}

// request sends a request with the allowed test origin; header pairs after
// the body override or add headers ("Origin", "" removes it).
func (h *testHelper) request(method, path, body string, header ...string) *http.Response {
	h.t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, h.ts.URL+path, r)
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Origin", testOrigin)
	if body != "" {
		req.Header.Set("Content-Type", "text/plain;charset=UTF-8") // what the website sends
	}
	for i := 0; i+1 < len(header); i += 2 {
		switch k, v := header[i], header[i+1]; {
		case k == "Host":
			req.Host = v
		case v == "":
			req.Header.Del(k)
		default:
			req.Header.Add(k, v)
		}
	}
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// call sends a request and decodes a JSON answer, checking its status.
func (h *testHelper) call(method, path, body string, wantStatus int) map[string]any {
	h.t.Helper()
	resp := h.request(method, path, body)
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	if resp.StatusCode != wantStatus {
		h.t.Fatalf("%s %s: status %d, want %d: %s", method, path, resp.StatusCode, wantStatus, data)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		h.t.Fatalf("%s %s: Content-Type %q", method, path, ct)
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		h.t.Fatalf("%s %s: %v: %s", method, path, err, data)
	}
	return v
}

// wantError checks an error answer's status and code.
func (h *testHelper) wantError(method, path, body string, status int, code string) {
	h.t.Helper()
	v := h.call(method, path, body, status)
	e, _ := v["error"].(map[string]any)
	if e == nil || e["code"] != code || e["message"] == "" {
		h.t.Fatalf("%s %s %s: error body %v, want code %q", method, path, body, v, code)
	}
}

// waitDone polls a scan until it has ended, like the website does.
func (h *testHelper) waitDone(id string) map[string]any {
	h.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		p := h.call("GET", "/v1/scans/"+id, "", http.StatusOK)
		if p["state"] != stateRunning {
			return p
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("scan %s still running: %v", id, p)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// fetchResult downloads and decodes a scan's result.
func (h *testHelper) fetchResult(id string) (decoded, []byte) {
	h.t.Helper()
	resp := h.request("GET", "/v1/scans/"+id+"/result", "")
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("result: status %d: %s", resp.StatusCode, data)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/octet-stream" {
		h.t.Fatalf("result Content-Type %q", ct)
	}
	if cl := resp.Header.Get("Content-Length"); cl == "" {
		h.t.Fatalf("result without Content-Length")
	}
	return decodeResult(h.t, data), data
}

func jsonString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
