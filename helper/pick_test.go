package main

import (
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"sync"
	"testing"
	"time"
)

// fakePicker plays the folder dialog.
type fakePicker struct {
	mu        sync.Mutex
	path      string
	cancelled bool
	err       error
	asked     [][2]string // title, startPath
	started   chan struct{}
	release   chan struct{} // if set, the dialog stays open until it closes
}

func (f *fakePicker) pick(title, startPath string) (string, bool, error) {
	f.mu.Lock()
	f.asked = append(f.asked, [2]string{title, startPath})
	started, release := f.started, f.release
	path, cancelled, err := f.path, f.cancelled, f.err
	f.mu.Unlock()
	if started != nil {
		started <- struct{}{}
	}
	if release != nil {
		<-release
	}
	return path, cancelled, err
}

func (f *fakePicker) set(change func(f *fakePicker)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

func TestPickFolder(t *testing.T) {
	p := &fakePicker{}
	h := newTestHelper(t, serverConfig{pick: p.pick})
	for raw, want := range map[string]string{
		`c:\Users\Ann\`:     `{"path":"C:\\Users\\Ann"}`,
		`d:`:                `{"path":"D:\\"}`,
		`C:\`:               `{"path":"C:\\"}`,
		`\\?\e:\Old`:        `{"path":"E:\\Old"}`,
		`\\server\share\x\`: `{"path":"\\\\server\\share\\x"}`,
		`\\server\share`:    `{"path":"\\\\server\\share\\"}`,
	} {
		p.set(func(f *fakePicker) { f.path = raw })
		if v := h.call("POST", "/v1/pick-folder", "", http.StatusOK); jsonString(v) != want {
			t.Errorf("dialog %q: %s, want %s", raw, jsonString(v), want)
		}
	}
	p.set(func(f *fakePicker) { f.cancelled = true })
	if v := h.call("POST", "/v1/pick-folder", "{}", http.StatusOK); jsonString(v) != `{"cancelled":true}` {
		t.Errorf("cancelled: %v", v)
	}
	p.set(func(f *fakePicker) { f.cancelled, f.err = false, errors.New("no COM") })
	h.wantError("POST", "/v1/pick-folder", "", http.StatusInternalServerError, codeInternal)
	p.set(func(f *fakePicker) { f.err, f.path = nil, `Users\Ann` })
	h.wantError("POST", "/v1/pick-folder", "", http.StatusInternalServerError, codeInternal)
	for _, b := range []string{"{", `{"title": 5}`, `{"startPath": ["C:\\"]}`} {
		h.wantError("POST", "/v1/pick-folder", b, http.StatusBadRequest, codeBadRequest)
	}

	// The title as it is; the start folder cleaned, or left out if it isn't valid.
	p.set(func(f *fakePicker) { f.path, f.asked = `C:\`, nil })
	for _, b := range []string{
		`{"title": "Ordner wählen", "startPath": "c:/users/"}`,
		`{"startPath": "relative\\path"}`,
		`{"startPath": "\\\\.\\pipe\\x"}`,
	} {
		h.call("POST", "/v1/pick-folder", b, http.StatusOK)
	}
	p.set(func(f *fakePicker) {
		want := [][2]string{{"Ordner wählen", `C:\users`}, {"", ""}, {"", ""}}
		if fmt.Sprint(f.asked) != fmt.Sprint(want) {
			t.Errorf("asked %q, want %q", f.asked, want)
		}
	})

	plain := newTestHelper(t, serverConfig{})
	plain.wantError("POST", "/v1/pick-folder", "", http.StatusNotFound, codeNotFound)
}

func TestPickFolderBusyAndIdle(t *testing.T) {
	p := &fakePicker{path: `C:\Data`, started: make(chan struct{}, 1), release: make(chan struct{})}
	h := newTestHelper(t, serverConfig{pick: p.pick, idle: time.Minute})
	first := make(chan map[string]any, 1)
	go func() { first <- h.call("POST", "/v1/pick-folder", "", http.StatusOK) }()
	<-p.started

	// One dialog at a time.
	h.wantError("POST", "/v1/pick-folder", "", http.StatusConflict, codeBusy)
	// The idle exit waits, however long the user takes.
	h.srv.activity.Store(time.Now().Add(-time.Hour).UnixNano())
	if h.srv.idleExpired(time.Now().Add(time.Hour)) {
		t.Error("the idle exit would fire while the dialog is open")
	}

	p.set(func(f *fakePicker) { f.started = nil })
	close(p.release)
	if v := <-first; jsonString(v) != `{"path":"C:\\Data"}` {
		t.Errorf("first: %v", v)
	}
	// The dialog's end counts as activity; then a new dialog may open.
	if h.srv.idleExpired(time.Now()) || !h.srv.idleExpired(time.Now().Add(2*time.Minute)) {
		t.Error("the idle time should start when the dialog closes")
	}
	if v := h.call("POST", "/v1/pick-folder", "", http.StatusOK); jsonString(v) != `{"path":"C:\\Data"}` {
		t.Errorf("after the first: %v", v)
	}
}

func TestPickFeature(t *testing.T) {
	p := &fakePicker{}
	full := newTestHelper(t, serverConfig{pick: p.pick, reveal: func(string) error { return nil }, cleanup: newFakeRecycle()})
	if v := full.call("GET", "/v1/info", "", http.StatusOK); fmt.Sprint(v["features"]) != "[scan pick reveal recycle delete]" {
		t.Errorf("features %v", v["features"])
	}
	if (platformPick() != nil) != (runtime.GOOS == "windows") {
		t.Errorf("pick on %s: %t", runtime.GOOS, platformPick() != nil)
	}
}
