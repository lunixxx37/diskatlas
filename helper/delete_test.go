package main

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// The delete checks are the recycle checks, with two differences: local
// removable drives are allowed, and long paths are.
func TestDeleteChecks(t *testing.T) {
	f := newFakeRecycle()
	cases := recycleCases()
	var items []recycleItem
	for _, c := range cases {
		if c.setup != nil {
			c.setup(f)
		}
		items = append(items, c.item)
	}
	results, err := runDelete(f, items, true)
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		want := c.status
		switch c.item.Path {
		case `E:\Movies\film.mkv`: // a removable drive
			want = statusOK
		default:
			if strings.Contains(c.inMsg, "259") { // a long path
				want = statusOK
			}
		}
		r := results[i]
		if r.Path != c.item.Path || r.Status != want || r.DeletedFiles != 0 || r.DeletedFolders != 0 || r.FailedEntries != 0 {
			t.Errorf("item %d %q: %+v, want %s", i, c.item.Path, r, want)
		}
		if want == c.status && !strings.Contains(r.Message, strings.ReplaceAll(c.inMsg, "local fixed drive", "local fixed or removable drive")) {
			t.Errorf("item %d %q: message %q, want %q", i, c.item.Path, r.Message, c.inMsg)
		}
	}
	if calls := f.deleteCalls(); len(calls) != 0 {
		t.Errorf("a dry run deleted %q", calls)
	}
}

func TestDeleteDriveRules(t *testing.T) {
	f := newFakeRecycle()
	for _, p := range []string{`C:\data\a.txt`, `E:\stick\a.txt`, `F:\disc\a.txt`, `Z:\share\a.txt`, `\\server\share\a.txt`, `Q:\nowhere\a.txt`} {
		f.file(p, 1, 1)
	}
	items := []recycleItem{
		fileItem(`C:\data\a.txt`, 1, 1), fileItem(`E:\stick\a.txt`, 1, 1), fileItem(`F:\disc\a.txt`, 1, 1),
		fileItem(`Z:\share\a.txt`, 1, 1), fileItem(`\\server\share\a.txt`, 1, 1), fileItem(`Q:\nowhere\a.txt`, 1, 1),
	}
	del, _ := runDelete(f, items, true)
	rec, _ := runRecycle(f, items, true)
	wantDel := []string{statusOK, statusOK, statusUnsupported, statusUnsupported, statusUnsupported, statusUnsupported}
	wantRec := []string{statusOK, statusUnsupported, statusUnsupported, statusUnsupported, statusUnsupported, statusUnsupported}
	for i := range items {
		if del[i].Status != wantDel[i] || rec[i].Status != wantRec[i] {
			t.Errorf("%s: delete %s, recycle %s; want %s, %s", items[i].Path, del[i].Status, rec[i].Status, wantDel[i], wantRec[i])
		}
	}
	if !strings.Contains(del[3].Message, "network shares") {
		t.Errorf("network message %q", del[3].Message)
	}
}

func TestDeleteForReal(t *testing.T) {
	f := newFakeRecycle()
	f.file(`C:\Users\Ann\a.txt`, 1, 1)
	f.dir(`D:\Old\Backup`)
	f.dir(`D:\Old\Locked`)
	f.file(`D:\Old\inuse.db`, 5, 5)
	f.file(`D:\Old\ghost.txt`, 6, 6)
	f.dir(`C:\Users\Ann\Downloads`)
	f.deletes[`D:\Old\Backup`] = deleteCounts{files: 812, folders: 40}
	f.deletes[`D:\Old\Locked`] = deleteCounts{files: 10, folders: 2, failed: 3, firstPath: `D:\Old\Locked\data\db.lock`, firstErr: errors.New("in use by another process")}
	f.deletes[`D:\Old\inuse.db`] = deleteCounts{failed: 1, firstPath: `D:\Old\inuse.db`, firstErr: errors.New("in use by another process")}
	f.stays[`D:\Old\ghost.txt`] = true
	items := []recycleItem{
		fileItem(`C:\Users\Ann\a.txt`, 1, 1),
		dirItem(`D:\Old\Backup`),
		dirItem(`D:\Old\Locked`),
		fileItem(`D:\Old\inuse.db`, 5, 5),
		fileItem(`D:\Old\ghost.txt`, 6, 6),
		dirItem(`C:\Users\Ann\Downloads`), // protected: never deleted
	}
	results, err := runDelete(f, items, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []deleteResult{
		{Path: `C:\Users\Ann\a.txt`, Status: statusDeleted, DeletedFiles: 1},
		{Path: `D:\Old\Backup`, Status: statusDeleted, DeletedFiles: 812, DeletedFolders: 40},
		{Path: `D:\Old\Locked`, Status: statusPartial, DeletedFiles: 10, DeletedFolders: 2, FailedEntries: 3,
			Message: `3 entries could not be deleted, first: D:\Old\Locked\data\db.lock: in use by another process`},
		{Path: `D:\Old\inuse.db`, Status: statusFailed, FailedEntries: 1, Message: `1 entry could not be deleted: D:\Old\inuse.db: in use by another process`},
		{Path: `D:\Old\ghost.txt`, Status: statusFailed, Message: "Windows reported success, but the item is still there"},
		{Path: `C:\Users\Ann\Downloads`, Status: statusProtected, Message: results[5].Message},
	}
	for i := range want {
		if results[i] != want[i] {
			t.Errorf("item %d:\n got %+v\nwant %+v", i, results[i], want[i])
		}
	}
	if !strings.Contains(results[5].Message, "protected") {
		t.Errorf("protected message %q", results[5].Message)
	}
	wantCalls := []string{`C:\Users\Ann\a.txt`, `D:\Old\Backup`, `D:\Old\Locked`, `D:\Old\inuse.db`, `D:\Old\ghost.txt`}
	if calls := f.deleteCalls(); !reflect.DeepEqual(calls, wantCalls) {
		t.Errorf("deleted %q, want %q", calls, wantCalls)
	}
}

func TestDeleteEndpoint(t *testing.T) {
	f := newFakeRecycle()
	f.file(`D:\Old\a.txt`, 10, 1000)
	f.dir(`D:\Old\Backup`)
	f.dir(`D:\`)
	var logs bytes.Buffer
	h := newTestHelper(t, serverConfig{cleanup: f, logger: log.New(&logs, "", 0)})
	item := `{"path": "D:\\Old\\a.txt", "isDir": false, "size": 10, "mtime": 1000}`

	// Malformed requests, as for /v1/recycle.
	for _, b := range []string{"", "{", `{"items": [], "dryRun": true}`, `{"items": [{"path": "D:\\Old\\a.txt"}], "dryRun": true}`, `{"items": [` + item + `], "dryRun": true, "confirm": 1}`} {
		h.wantError("POST", "/v1/delete", b, http.StatusBadRequest, codeBadRequest)
	}
	// A real deletion needs confirm: "permanent", exactly.
	for _, b := range []string{
		`{"items": [` + item + `]}`,
		`{"items": [` + item + `], "dryRun": false}`,
		`{"items": [` + item + `], "dryRun": false, "confirm": "yes"}`,
		`{"items": [` + item + `], "dryRun": false, "confirm": "Permanent"}`,
		`{"items": [` + item + `], "dryRun": false, "confirm": ""}`,
	} {
		h.wantError("POST", "/v1/delete", b, http.StatusBadRequest, codeBadRequest)
	}
	if calls := f.deleteCalls(); len(calls) != 0 {
		t.Fatalf("deleted without confirmation: %q", calls)
	}

	// A dry run needs no confirmation and changes nothing.
	v := h.call("POST", "/v1/delete", `{"items": [`+item+`, {"path": "D:\\Old\\Backup", "isDir": true}, {"path": "D:\\", "isDir": true}], "dryRun": true}`, http.StatusOK)
	want := `{"results":[{"deletedFiles":0,"deletedFolders":0,"failedEntries":0,"message":"","path":"D:\\Old\\a.txt","status":"ok"},` +
		`{"deletedFiles":0,"deletedFolders":0,"failedEntries":0,"message":"","path":"D:\\Old\\Backup","status":"ok"},` +
		`{"deletedFiles":0,"deletedFolders":0,"failedEntries":0,"message":"a drive root is protected","path":"D:\\","status":"protected"}]}`
	if got := jsonString(v); got != want {
		t.Errorf("dry run:\n got %s\nwant %s", got, want)
	}
	if calls := f.deleteCalls(); len(calls) != 0 {
		t.Fatalf("the dry run deleted %q", calls)
	}

	v = h.call("POST", "/v1/delete", `{"items": [`+item+`, {"path": "D:\\Old\\Backup", "isDir": true}], "dryRun": false, "confirm": "permanent"}`, http.StatusOK)
	want = `{"results":[{"deletedFiles":1,"deletedFolders":0,"failedEntries":0,"message":"","path":"D:\\Old\\a.txt","status":"deleted"},` +
		`{"deletedFiles":0,"deletedFolders":1,"failedEntries":0,"message":"","path":"D:\\Old\\Backup","status":"deleted"}]}`
	if got := jsonString(v); got != want {
		t.Errorf("delete:\n got %s\nwant %s", got, want)
	}
	// Every real deletion is logged with path, status and counts.
	text := logs.String()
	for _, line := range []string{
		`delete D:\Old\a.txt (file, 10 bytes): deleted: 1 files and 0 folders deleted, 0 failed`,
		`delete D:\Old\Backup (folder): deleted: 0 files and 1 folders deleted, 0 failed`,
		`delete check (dry run): 2 ok, 1 protected`,
	} {
		if !strings.Contains(text, line) {
			t.Errorf("the log lacks %q:\n%s", line, text)
		}
	}

	plain := newTestHelper(t, serverConfig{})
	plain.wantError("POST", "/v1/delete", `{"items": [`+item+`], "dryRun": true}`, http.StatusNotFound, codeNotFound)
}

// blockingCleanup is a fake whose deletions wait until release closes.
type blockingCleanup struct {
	*fakeRecycle
	started chan string
	release chan struct{}
}

func (b *blockingCleanup) deleteItem(p string, isDir bool) deleteCounts {
	b.started <- p
	<-b.release
	return b.fakeRecycle.deleteItem(p, isDir)
}

func (b *blockingCleanup) recycle(p string) error {
	b.started <- "recycle " + p
	return b.fakeRecycle.recycle(p)
}

func TestDeleteRunsAloneAndKeepsTheHelperAlive(t *testing.T) {
	f := newFakeRecycle()
	f.dir(`D:\Big`)
	f.file(`D:\x.txt`, 1, 1)
	b := &blockingCleanup{fakeRecycle: f, started: make(chan string, 4), release: make(chan struct{})}
	h := newTestHelper(t, serverConfig{cleanup: b, idle: time.Minute})

	deleted := make(chan map[string]any, 1)
	go func() {
		deleted <- h.call("POST", "/v1/delete", `{"items": [{"path": "D:\\Big", "isDir": true}], "confirm": "permanent"}`, http.StatusOK)
	}()
	if p := <-b.started; p != `D:\Big` {
		t.Fatalf("started %q", p)
	}
	// While it deletes, the idle time can't run out.
	h.srv.activity.Store(time.Now().Add(-time.Hour).UnixNano())
	if h.srv.idleExpired(time.Now()) {
		t.Error("the idle timer would fire in the middle of a deletion")
	}
	// A recycle request waits until the deletion is done.
	recycled := make(chan map[string]any, 1)
	go func() {
		recycled <- h.call("POST", "/v1/recycle", `{"items": [{"path": "D:\\x.txt", "isDir": false, "size": 1, "mtime": 1}]}`, http.StatusOK)
	}()
	select {
	case p := <-b.started:
		t.Fatalf("%s ran during the deletion", p)
	case <-time.After(200 * time.Millisecond):
	}
	close(b.release)
	if v := <-deleted; !strings.Contains(jsonString(v), `"status":"deleted"`) {
		t.Errorf("delete: %v", v)
	}
	if p := <-b.started; p != `recycle D:\x.txt` {
		t.Errorf("then %q", p)
	}
	if v := <-recycled; !strings.Contains(jsonString(v), `"status":"recycled"`) {
		t.Errorf("recycle: %v", v)
	}
	if !h.srv.waitCleanup(time.Second) {
		t.Error("still busy afterwards")
	}
}

func TestDeleteFinishesWhenTheWebsiteLeaves(t *testing.T) {
	f := newFakeRecycle()
	f.dir(`D:\Big`)
	b := &blockingCleanup{fakeRecycle: f, started: make(chan string, 1), release: make(chan struct{})}
	var mu sync.Mutex
	var logs bytes.Buffer
	h := newTestHelper(t, serverConfig{cleanup: b, logger: log.New(lockedWriter{&mu, &logs}, "", 0)})

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", h.ts.URL+"/v1/delete", strings.NewReader(`{"items": [{"path": "D:\\Big", "isDir": true}], "confirm": "permanent"}`))
	req.Header.Set("Origin", testOrigin)
	errc := make(chan error, 1)
	go func() {
		resp, err := h.ts.Client().Do(req)
		if err == nil {
			resp.Body.Close()
		}
		errc <- err
	}()
	<-b.started
	cancel() // the tab was closed
	if err := <-errc; err == nil {
		t.Fatal("the request didn't end with the website")
	}
	close(b.release)
	if !h.srv.waitCleanup(5 * time.Second) {
		t.Fatal("the deletion didn't finish")
	}
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(logs.String(), `delete D:\Big (folder): deleted`) {
		t.Errorf("the deletion wasn't finished and logged:\n%s", logs.String())
	}
}

type lockedWriter struct {
	mu *sync.Mutex
	w  *bytes.Buffer
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}
