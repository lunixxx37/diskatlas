package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// blockingList lists like listDir, but first waits until release closes or
// the scan is cancelled. Every folder it starts on is counted in started.
func blockingList(release <-chan struct{}, started *atomic.Int32) listFunc {
	return func(ctx context.Context, dir dirPath, opt listOptions, b *batch) error {
		if started != nil {
			started.Add(1)
		}
		select {
		case <-release:
		case <-ctx.Done():
			return ctx.Err()
		}
		return listDir(ctx, dir, opt, b)
	}
}

var testTime = time.Date(2021, 3, 4, 5, 6, 7, 0, time.UTC)

func writeTestFile(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), size), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, testTime, testTime); err != nil {
		t.Fatal(err)
	}
}

// testTree creates files with known sizes and returns their sizes by path
// relative to dir.
func testTree(t *testing.T, dir string) map[string]int {
	t.Helper()
	files := map[string]int{
		"a.txt":              10,
		"sub/b.bin":          5000,
		"sub/deeper/c.txt":   0,
		"sub/deeper/d.txt":   4097,
		"sub/deeper/Ä日😀.txt": 3,
	}
	for name, size := range files {
		writeTestFile(t, filepath.Join(dir, filepath.FromSlash(name)), size)
	}
	if err := os.Mkdir(filepath.Join(dir, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	return files
}

func cleaned(t *testing.T, p string) string {
	t.Helper()
	c, err := cleanPath(p)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestScanAPI(t *testing.T) {
	dir := t.TempDir()
	files := testTree(t, dir)
	root := cleaned(t, dir)
	info, err := openRoot(root)
	if err != nil {
		t.Fatal(err)
	}

	h := newTestHelper(t, serverConfig{workers: 4})
	v := h.call("POST", "/v1/scans", `{"path": `+jsonString(dir)+`, "allocated": true}`, http.StatusAccepted)
	if jsonString(v) != `{"id":"s1"}` {
		t.Fatalf("start: %v", v)
	}
	p := h.waitDone("s1")
	wantProgress := map[string]any{
		"id": "s1", "state": "done", "path": root,
		"entries": float64(9), // the root, 3 folders and 5 files
		"files":   float64(5), "dirs": float64(3), "bytes": float64(10 + 5000 + 0 + 4097 + 3),
		"errors": float64(0), "currentPath": "", "error": "",
	}
	for k, want := range wantProgress {
		if p[k] != want {
			t.Errorf("progress %s = %v, want %v", k, p[k], want)
		}
	}
	if ms, ok := p["elapsedMs"].(float64); !ok || ms < 0 {
		t.Errorf("elapsedMs = %v", p["elapsedMs"])
	}

	d, data := h.fetchResult("s1")
	if d.count != 9 || !d.allocated {
		t.Fatalf("result: %d entries, allocated %t", d.count, d.allocated)
	}
	if d.names[0] != info.name {
		t.Errorf("root name %q, want %q", d.names[0], info.name)
	}
	if d.kind[0] != kindFolder {
		t.Errorf("root kind %d", d.kind[0])
	}
	idx := d.byPath(t)
	for _, folder := range []string{"empty", "sub", "sub/deeper"} {
		i, ok := idx[folder]
		if !ok || d.kind[i] != kindFolder || d.size[i] != 0 || d.alloc[i] != 0 {
			t.Errorf("folder %s: found %t, kind %d", folder, ok, d.kind[i])
		}
		if d.mtime[i] <= 0 {
			t.Errorf("folder %s has no last write time", folder)
		}
	}
	for name, size := range files {
		i, ok := idx[name]
		if !ok {
			t.Errorf("%s is missing from %v", name, d.names)
			continue
		}
		if d.kind[i] != 0 || d.size[i] != float64(size) || d.mtime[i] != float64(testTime.UnixMilli()) {
			t.Errorf("%s: kind %d, size %v, mtime %v; want 0, %d, %d", name, d.kind[i], d.size[i], d.mtime[i], size, testTime.UnixMilli())
		}
		if want := float64(roundUp(uint64(size), info.cluster)); d.alloc[i] != want {
			t.Errorf("%s: size on disk %v, want %v (cluster %d)", name, d.alloc[i], want, info.cluster)
		}
	}

	// The result can be fetched again, byte for byte.
	if _, again := h.fetchResult("s1"); !bytes.Equal(data, again) {
		t.Error("the second download differs")
	}

	// A new scan replaces it; this one skips the size on disk.
	h.call("POST", "/v1/scans", `{"path": `+jsonString(strings.ReplaceAll(dir, `\`, "/"))+`, "allocated": false}`, http.StatusAccepted)
	h.wantError("GET", "/v1/scans/s1", "", http.StatusNotFound, codeNotFound)
	h.wantError("GET", "/v1/scans/s1/result", "", http.StatusNotFound, codeNotFound)
	if p := h.waitDone("s2"); p["state"] != stateDone || p["path"] != root {
		t.Fatalf("s2: %v", p)
	}
	d2, _ := h.fetchResult("s2")
	if d2.allocated || d2.count != 9 {
		t.Errorf("s2: allocated %t, %d entries", d2.allocated, d2.count)
	}
}

func TestResultWhileRunningAndCancel(t *testing.T) {
	dir := t.TempDir()
	testTree(t, dir)
	release := make(chan struct{})
	defer close(release)
	var started atomic.Int32
	h := newTestHelper(t, serverConfig{list: blockingList(release, &started)})

	h.call("POST", "/v1/scans", `{"path": `+jsonString(dir)+`}`, http.StatusAccepted)
	for started.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	h.wantError("GET", "/v1/scans/s1/result", "", http.StatusConflict, codeScanRunning)
	p := h.call("GET", "/v1/scans/s1", "", http.StatusOK)
	if p["state"] != stateRunning || p["currentPath"] != cleaned(t, dir) || p["entries"] != float64(1) {
		t.Fatalf("running: %v", p)
	}

	p = h.call("POST", "/v1/scans/s1/cancel", "", http.StatusAccepted)
	if p["state"] != stateCancelled || p["id"] != "s1" {
		t.Fatalf("cancel: %v", p)
	}
	// The partial result: the root, whose listing was cut short.
	d, _ := h.fetchResult("s1")
	if d.count != 1 || d.parent[0] != -1 || !d.allocated {
		t.Fatalf("partial result: %+v", d)
	}
	if p := h.call("GET", "/v1/scans/s1", "", http.StatusOK); p["state"] != stateCancelled || p["currentPath"] != "" {
		t.Errorf("after cancel: %v", p)
	}
	// Cancelling again changes nothing.
	if p := h.call("POST", "/v1/scans/s1/cancel", "{}", http.StatusAccepted); p["state"] != stateCancelled {
		t.Errorf("second cancel: %v", p)
	}
}

func TestNewScanCancelsPrevious(t *testing.T) {
	dir := t.TempDir()
	testTree(t, dir)
	release := make(chan struct{})
	var started atomic.Int32
	h := newTestHelper(t, serverConfig{list: blockingList(release, &started)})
	h.call("POST", "/v1/scans", `{"path": `+jsonString(dir)+`}`, http.StatusAccepted)
	for started.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	first := h.srv.lookup("s1")
	h.call("POST", "/v1/scans", `{"path": `+jsonString(dir)+`}`, http.StatusAccepted)
	if _, state, _ := first.snapshot(); state != stateCancelled {
		t.Errorf("the first scan is %s", state)
	}
	h.wantError("GET", "/v1/scans/s1", "", http.StatusNotFound, codeNotFound)
	close(release)
	if p := h.waitDone("s2"); p["state"] != stateDone || p["entries"] != float64(9) {
		t.Errorf("s2: %v", p)
	}
}

// syntheticList makes up a tree without touching the disk: every folder
// above depth 4 holds 5 folders and 10 files.
func syntheticList(ctx context.Context, dir dirPath, opt listOptions, b *batch) error {
	p := displayPath(dir)
	depth := strings.Count(p, "/")
	if depth >= 4 {
		return nil
	}
	for i := range 10 {
		b.names = append(b.names, fmt.Sprintf("f%d", i)...)
		b.add(0, uint64(i), 1, roundUp(uint64(i), opt.cluster))
	}
	for i := range 5 {
		name := fmt.Sprintf("d%d", i)
		b.names = append(b.names, name...)
		pos := b.add(kindFolder, 0, 0, 0)
		child, _ := makeDirPath(p + "/" + name)
		b.subdirs = append(b.subdirs, subdir{pos: pos, path: child})
	}
	return nil
}

func runScan(t *testing.T, list listFunc, workers int, allocated bool) (*scan, decoded) {
	t.Helper()
	dir, _ := makeDirPath("root")
	root := rootInfo{dir: dir, name: "root", kind: kindFolder, cluster: 4096}
	sc := newScan("s1", "root", allocated, root, list, workers)
	sc.run(root)
	res, state, failure := sc.snapshot()
	if state != stateDone && state != stateCancelled {
		t.Fatalf("state %s: %s", state, failure)
	}
	var buf bytes.Buffer
	if err := writeResult(&buf, res); err != nil {
		t.Fatal(err)
	}
	return sc, decodeResult(t, buf.Bytes())
}

func TestWorkerPool(t *testing.T) {
	// 1 + 5 + 25 + 125 + 625 folders, 10 files in each of the first 156.
	const folders, files = 5 + 25 + 125 + 625, 10 * (1 + 5 + 25 + 125)
	for _, workers := range []int{1, 3, 16} {
		sc, d := runScan(t, syntheticList, workers, true)
		if d.count != 1+folders+files {
			t.Fatalf("%d workers: %d entries", workers, d.count)
		}
		p := sc.progress()
		if p.Entries != uint64(d.count) || p.Dirs != folders || p.Files != files || p.Errors != 0 || p.Bytes != 45*156 {
			t.Errorf("%d workers: progress %+v", workers, p)
		}
		// Every folder above depth 4 got all its children, and only once.
		idx := d.byPath(t)
		children := make([]int, d.count)
		for i := 1; i < d.count; i++ {
			children[d.parent[i]]++
		}
		for path, i := range idx {
			want := 0
			if d.kind[i]&kindFolder != 0 && strings.Count(path, "/") < 3 {
				want = 15
			}
			if children[i] != want {
				t.Fatalf("%d workers: %q has %d children, want %d", workers, path, children[i], want)
			}
		}
	}
}

func TestCancelMidScan(t *testing.T) {
	var sc *scan
	var listed atomic.Int32
	list := func(ctx context.Context, dir dirPath, opt listOptions, b *batch) error {
		if listed.Add(1) == 50 {
			sc.finish(stateCancelled, "")
		}
		return syntheticList(ctx, dir, opt, b)
	}
	dir, _ := makeDirPath("root")
	root := rootInfo{dir: dir, name: "root", kind: kindFolder, cluster: 4096}
	sc = newScan("s1", "root", true, root, list, 8)
	done := make(chan struct{})
	go func() { sc.run(root); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the workers didn't stop")
	}
	res, state, _ := sc.snapshot()
	if state != stateCancelled {
		t.Fatalf("state %s", state)
	}
	var buf bytes.Buffer
	writeResult(&buf, res)
	d := decodeResult(t, buf.Bytes())
	if d.count >= 1+780+1560 || d.count < 1 {
		t.Errorf("a cancelled scan has %d entries", d.count)
	}
	if p := sc.progress(); p.Entries != uint64(d.count) || p.Files+p.Dirs+1 != p.Entries {
		t.Errorf("progress %+v doesn't match the %d entries", p, d.count)
	}
	// The result stays as it was.
	time.Sleep(50 * time.Millisecond)
	if again, _, _ := sc.snapshot(); again.count() != d.count {
		t.Errorf("the result changed after the cancel: %d, then %d entries", d.count, again.count())
	}
}

func TestListErrorMarksFolderUnreadable(t *testing.T) {
	list := func(ctx context.Context, dir dirPath, opt listOptions, b *batch) error {
		p := displayPath(dir)
		if strings.HasSuffix(p, "/d1") || strings.HasSuffix(p, "/d2") {
			// d1 can't be listed at all; d2 breaks off after one entry.
			if strings.HasSuffix(p, "/d2") {
				b.names = append(b.names, "partial"...)
				b.add(0, 7, 0, 4096)
			}
			return fmt.Errorf("access denied")
		}
		if strings.Count(p, "/") >= 1 {
			return nil
		}
		return syntheticList(ctx, dir, opt, b)
	}
	sc, d := runScan(t, list, 4, true)
	idx := d.byPath(t)
	for path, want := range map[string]uint8{"d0": kindFolder, "d1": kindFolder | kindUnreadable, "d2": kindFolder | kindUnreadable, "d2/partial": 0} {
		if i, ok := idx[path]; !ok || d.kind[i] != want {
			t.Errorf("%s: found %t, kind %d, want %d", path, ok, d.kind[i], want)
		}
	}
	if p := sc.progress(); p.Errors != 2 || p.State != stateDone {
		t.Errorf("progress %+v, want 2 errors", p)
	}
}

func TestPanicFailsScan(t *testing.T) {
	list := func(ctx context.Context, dir dirPath, opt listOptions, b *batch) error {
		if strings.Count(displayPath(dir), "/") == 2 {
			panic("lister bug")
		}
		return syntheticList(ctx, dir, opt, b)
	}
	dir, _ := makeDirPath("root")
	root := rootInfo{dir: dir, name: "root", kind: kindFolder, cluster: 4096}
	sc := newScan("s1", "root", false, root, list, 4)
	sc.run(root)
	if p := sc.progress(); p.State != stateFailed || !strings.Contains(p.Error, "lister bug") {
		t.Errorf("progress %+v", p)
	}
	h := newTestHelper(t, serverConfig{})
	h.srv.cur = sc
	h.wantError("GET", "/v1/scans/s1/result", "", http.StatusInternalServerError, codeInternal)
	if p := h.call("GET", "/v1/scans/s1", "", http.StatusOK); p["state"] != stateFailed || p["error"] == "" {
		t.Errorf("progress %v", p)
	}
}

func TestWalkTempTree(t *testing.T) {
	// The platform's listDir on a real tree, a few levels deep.
	dir := t.TempDir()
	want := map[string]int{}
	for i := range 4 {
		for j := range 4 {
			for k := range 3 {
				name := fmt.Sprintf("d%d/e%d/f%d.txt", i, j, k)
				want[name] = i*100 + j*10 + k
				writeTestFile(t, filepath.Join(dir, filepath.FromSlash(name)), want[name])
			}
		}
	}
	h := newTestHelper(t, serverConfig{workers: 8})
	h.call("POST", "/v1/scans", `{"path": `+jsonString(dir)+`}`, http.StatusAccepted)
	if p := h.waitDone("s1"); p["entries"] != float64(1+4+16+48) || p["errors"] != float64(0) {
		t.Fatalf("progress %v", p)
	}
	d, _ := h.fetchResult("s1")
	idx := d.byPath(t)
	for name, size := range want {
		if i, ok := idx[name]; !ok || d.size[i] != float64(size) {
			t.Errorf("%s: found %t, size %v, want %d", name, ok, d.size[i], size)
		}
	}
}
