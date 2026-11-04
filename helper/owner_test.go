package main

import (
	"bytes"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
)

const testSID = "S-1-5-21-1-2-3-1001"

// fakeOwners answers owner lookups as scripted.
type fakeOwners struct {
	mu      sync.Mutex
	pidErr  error
	sid     string
	image   string
	userErr error
	asked   []netip.AddrPort // the client side of each lookup
}

func (f *fakeOwners) pid(client, server netip.AddrPort) (uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, client, server)
	return 4242, f.pidErr
}

func (f *fakeOwners) user(pid uint32) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sid, f.image, f.userErr
}

func (f *fakeOwners) set(change func(f *fakeOwners)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

func TestSameUserListener(t *testing.T) {
	owners := &fakeOwners{sid: testSID, image: "chrome.exe"}
	var mu sync.Mutex
	var logs bytes.Buffer
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("hello"))
	}))
	ts.Listener = requireSameUser(ts.Listener, owners, testSID, log.New(lockedWriter{&mu, &logs}, "", 0))
	ts.Start()
	defer ts.Close()
	// A new connection for every request, so each one is checked.
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	get := func() error {
		resp, err := client.Get(ts.URL)
		if err != nil {
			return err
		}
		resp.Body.Close()
		return nil
	}

	if err := get(); err != nil {
		t.Fatalf("the same user was refused: %v", err)
	}
	// The lookup got the client's end and the helper's end of the connection.
	owners.set(func(f *fakeOwners) {
		server := ts.Listener.Addr().(*net.TCPAddr).AddrPort()
		if len(f.asked) != 2 || f.asked[1] != server || f.asked[0].Addr() != netip.MustParseAddr("127.0.0.1") || f.asked[0].Port() == server.Port() {
			t.Errorf("looked up %v (server %v)", f.asked, server)
		}
	})

	for _, c := range []struct {
		name   string
		change func(f *fakeOwners)
		inLog  string
	}{
		{"another user", func(f *fakeOwners) { f.sid = "S-1-5-21-9-9-9-1002" }, "chrome.exe (pid 4242) runs as another user"},
		{"no SID", func(f *fakeOwners) { f.sid = "" }, "runs as another user"},
		{"lookup failure", func(f *fakeOwners) { f.sid = testSID; f.pidErr = errors.New("not in the table") }, "could not find the program behind port"},
		{"open failure", func(f *fakeOwners) { f.pidErr = nil; f.userErr = errors.New("access denied") }, "could not identify chrome.exe (pid 4242): access denied"},
		{"open failure without a name", func(f *fakeOwners) { f.image = "" }, "could not identify a program (pid 4242)"},
	} {
		owners.set(c.change)
		if err := get(); err == nil {
			t.Errorf("%s: the connection was served", c.name)
		}
		mu.Lock()
		if !strings.Contains(logs.String(), c.inLog) {
			t.Errorf("%s: the log lacks %q:\n%s", c.name, c.inLog, logs.String())
		}
		mu.Unlock()
	}
	// Refused connections don't stop the listener.
	owners.set(func(f *fakeOwners) { f.userErr = nil; f.image = "msedge.exe" })
	if err := get(); err != nil {
		t.Errorf("after the refusals: %v", err)
	}
}

func TestSameUserListenerOff(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if got := requireSameUser(ln, nil, "", nil); got != ln {
		t.Error("without a lookup the listener should stay as it is")
	}
}

func TestCleanupRefusedWithoutUserRights(t *testing.T) {
	f := newFakeRecycle()
	f.file(`D:\Old\a.txt`, 1, 1)
	f.dir(`D:\Old\Backup`)
	items := []recycleItem{fileItem(`D:\Old\a.txt`, 1, 1), dirItem(`D:\Old\Backup`)}

	// The rights can't be dropped at all: nothing is checked or changed.
	f.dropErr = errors.New("no linked token")
	rec, err, dropErr := recycleAsUser(f, items, false)
	del, err2, dropErr2 := deleteAsUser(f, items, false)
	if err != nil || err2 != nil || dropErr == nil || dropErr2 == nil {
		t.Fatalf("errors %v %v %v %v", err, err2, dropErr, dropErr2)
	}
	for i := range items {
		if rec[i].Status != statusFailed || rec[i].Message != msgNoUserRights || del[i].Status != statusFailed || del[i].Message != msgNoUserRights {
			t.Errorf("item %d: %+v, %+v", i, rec[i], del[i])
		}
	}
	// Recycling asks for the shell thread, deleting doesn't.
	if want := []bool{true, false}; len(f.asUserRuns) != 2 || f.asUserRuns[0] != want[0] || f.asUserRuns[1] != want[1] {
		t.Errorf("asUser calls %v", f.asUserRuns)
	}

	// The check before each item fails: the item is refused, not touched.
	f.dropErr = nil
	f.rightsErr = errors.New("the thread doesn't impersonate")
	del, _, _ = deleteAsUser(f, items, false)
	rec, _, _ = recycleAsUser(f, items, false)
	for i := range items {
		if del[i].Status != statusFailed || del[i].Message != msgNoUserRights || rec[i].Status != statusFailed {
			t.Errorf("item %d: %+v, %+v", i, del[i], rec[i])
		}
	}
	if len(f.deleteCalls()) != 0 || len(f.calls()) != 0 {
		t.Errorf("changed without the user's rights: %q, %q", f.deleteCalls(), f.calls())
	}

	// Through the API: 200, with every item failed.
	h := newTestHelper(t, serverConfig{cleanup: f})
	v := h.call("POST", "/v1/delete", `{"items": [{"path": "D:\\Old\\Backup", "isDir": true}], "confirm": "permanent"}`, http.StatusOK)
	if got := jsonString(v); !strings.Contains(got, `"status":"failed"`) || !strings.Contains(got, msgNoUserRights) {
		t.Errorf("delete: %s", got)
	}
}
