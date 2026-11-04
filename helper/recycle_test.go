package main

import (
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// fakeRecycle is a cleanupSystem over a made-up set of items.
type fakeRecycle struct {
	mu         sync.Mutex
	items      map[string]itemInfo // by path; finalPath "" means "leads to itself"
	unknown    map[string]bool     // inspect can't tell where the path leads
	openErr    map[string]error    // inspect fails like this
	loc        knownLocations
	locErr     error
	drives     map[string]string // drive root → type; others are "unknown"
	win32      map[string]string // names Win32 rewrites
	recycleErr map[string]error
	stays      map[string]bool // recycling or deleting reports success, but the item stays
	recycled   []string
	deletes    map[string]deleteCounts // what deleting an item does; the default deletes it
	deleted    []string
	dropErr    error  // asUser fails: the rights can't be dropped
	rightsErr  error  // rightsCheck fails
	asUserRuns []bool // the shell argument of each asUser call
}

func (f *fakeRecycle) asUser(shell bool, run func()) error {
	f.mu.Lock()
	f.asUserRuns = append(f.asUserRuns, shell)
	err := f.dropErr
	f.mu.Unlock()
	if err != nil {
		return err
	}
	run()
	return nil
}

func (f *fakeRecycle) rightsCheck() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rightsErr
}

func newFakeRecycle() *fakeRecycle {
	return &fakeRecycle{
		items:      map[string]itemInfo{},
		unknown:    map[string]bool{},
		openErr:    map[string]error{},
		loc:        testLocations(),
		drives:     map[string]string{`C:\`: "fixed", `D:\`: "fixed", `E:\`: "removable", `F:\`: "cdrom", `Z:\`: "network"},
		win32:      map[string]string{},
		recycleErr: map[string]error{},
		stays:      map[string]bool{},
		deletes:    map[string]deleteCounts{},
	}
}

func (f *fakeRecycle) driveType(p string) string {
	if len(p) >= 3 && p[1] == ':' {
		if t, ok := f.drives[p[:3]]; ok {
			return t
		}
		return "unknown"
	}
	return "network"
}

// deleteItem plays a deletion: the scripted counts, or one deleted entry.
// The item goes away unless entries failed or it is set to stay.
func (f *fakeRecycle) deleteItem(p string, isDir bool) deleteCounts {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, p)
	c, scripted := f.deletes[p]
	if !scripted {
		if isDir {
			c.folders = 1
		} else {
			c.files = 1
		}
	}
	if c.failed == 0 && !f.stays[p] {
		delete(f.items, p)
	}
	return c
}

func (f *fakeRecycle) deleteCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.deleted...)
}

func (f *fakeRecycle) file(p string, size uint64, mtime float64) {
	f.items[p] = itemInfo{size: size, mtime: mtime}
}

func (f *fakeRecycle) dir(p string) { f.items[p] = itemInfo{isDir: true, mtime: 1} }

func (f *fakeRecycle) inspect(p string) (itemInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err, ok := f.openErr[p]; ok {
		return itemInfo{}, err
	}
	info, ok := f.items[p]
	if !ok {
		return itemInfo{}, errPathNotFound
	}
	if info.finalPath == "" && !f.unknown[p] {
		info.finalPath = p
	}
	return info, nil
}

func (f *fakeRecycle) locations() (knownLocations, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.loc, f.locErr
}

func (f *fakeRecycle) win32Path(p string) (string, error) {
	if w, ok := f.win32[p]; ok {
		return w, nil
	}
	return p, nil
}

func (f *fakeRecycle) recycle(p string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recycled = append(f.recycled, p)
	if err := f.recycleErr[p]; err != nil {
		return err
	}
	if !f.stays[p] {
		delete(f.items, p)
	}
	return nil
}

func (f *fakeRecycle) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.recycled...)
}

// testLocations are made-up known folders: Ann's Documents are redirected
// to D:\Docs, and the helper runs from D:\Tools\DiskAtlas.
func testLocations() knownLocations {
	return knownLocations{
		windows:      `C:\Windows`,
		programFiles: []string{`C:\Program Files`, `C:\Program Files (x86)`, "", `C:\Program Files`},
		programData:  `C:\ProgramData`,
		userProfiles: `C:\Users`,
		profiles:     []string{`C:\Users\Ann`, `C:\Users\Public`, `C:\Users\All Users`, `C:\Users\Ann`},
		userFolders:  []string{`D:\Docs`, `C:\Users\Ann\Desktop`, ""},
		exe:          `D:\Tools\DiskAtlas\DiskAtlas-Helper.exe`,
	}
}

func ptr[T any](v T) *T { return &v }

func fileItem(p string, size, mtime float64) recycleItem {
	return recycleItem{Path: p, IsDir: ptr(false), Size: ptr(size), Mtime: ptr(mtime)}
}

func dirItem(p string) recycleItem { return recycleItem{Path: p, IsDir: ptr(true)} }

func TestProtection(t *testing.T) {
	prot := newProtection(testLocations())
	protected := []string{
		`C:\`, `D:\`, `Z:\`, `\\server\share\`, // drive roots
		`C:\$Recycle.Bin`, `C:\$RECYCLE.BIN\S-1-5-21\$R1.txt`, `D:\$Recycle.Bin\x`,
		`C:\System Volume Information`, `E:\System Volume Information\x\y`,
		`C:\pagefile.sys`, `D:\HIBERFIL.SYS`, `C:\swapfile.sys`, `C:\DumpStack.log.tmp`,
		`C:\Windows`, `C:\Windows\System32\kernel32.dll`, `c:\windows\temp`, `C:\WINDOWS\SysWOW64`,
		`C:\wındows\x`, // dotless ı: NTFS upper-cases it to I
		`C:\Program Files`, `C:\Program Files\App\app.exe`, `C:\Program Files (x86)\Steam`,
		`C:\ProgramData`, `C:\Users`, `C:\Users\Ann`, `C:\Users\Public`, `C:\Users\All Users`,
		`C:\Users\Ann\AppData`, `C:\Users\Ann\AppData\Local`, `C:\Users\Ann\AppData\Roaming`,
		`C:\Users\Ann\Desktop`, `C:\Users\Ann\Documents`, `C:\Users\Ann\Downloads`, `C:\Users\Ann\Pictures`,
		`C:\Users\Ann\Music`, `C:\Users\Ann\Videos`, `C:\Users\Public\Documents`, `C:\USERS\ANN\DOWNLOADS`,
		`D:\Docs`, // Ann's redirected Documents
		`D:\Tools\DiskAtlas\DiskAtlas-Helper.exe`, `D:\Tools\DiskAtlas`, `D:\Tools`,
		`not a path`,
	}
	for _, p := range protected {
		if why, ok := prot.check(p); !ok || why == "" {
			t.Errorf("%s is not protected", p)
		}
	}
	allowed := []string{
		`C:\Users\Ann\Downloads\big.iso`, `C:\Users\Ann\AppData\Local\Temp`, `C:\Users\Ann\AppData\Local\Temp\x.tmp`,
		`C:\Users\Ann\AppData\LocalLow`, `C:\Users\Ann\Videos\trip.mkv`, `C:\Users\Ann\OneDrive`,
		`C:\ProgramData\Cache`, `C:\Users\Public\Documents\shared.txt`, `D:\Docs\letter.txt`,
		`D:\Tools\other.exe`, `D:\Tools\DiskAtlas\notes.txt`, `C:\Windows.old`, `C:\Program Files Backup`,
		`C:\Games\pagefile.sys`, `C:\Games\$Recycle.Bin`, `C:\WindowsApps`, `E:\Movies`,
	}
	for _, p := range allowed {
		if why, ok := prot.check(p); ok {
			t.Errorf("%s is protected: %s", p, why)
		}
	}
	if why, _ := prot.check(`C:\ProgramData`); !strings.Contains(why, "but not what is inside it") {
		t.Errorf("reason for ProgramData: %q", why)
	}
}

func TestSplitVolume(t *testing.T) {
	for in, want := range map[string][2]string{
		`C:\`:              {`C:\`, ""},
		`C:\Users\Ann`:     {`C:\`, `Users\Ann`},
		`\\server\share\`:  {`\\server\share\`, ""},
		`\\server\share\x`: {`\\server\share\`, `x`},
	} {
		if root, rest := splitVolume(in); root != want[0] || rest != want[1] {
			t.Errorf("splitVolume(%q) = %q, %q", in, root, rest)
		}
	}
}

// recycleCase is one item with what the fake finds at its path.
type recycleCase struct {
	item   recycleItem
	setup  func(f *fakeRecycle)
	status string
	inMsg  string // part of the message
}

func recycleCases() []recycleCase {
	long := `C:\Users\Ann\` + strings.Repeat("x", 250) // 263 characters
	return []recycleCase{
		{item: fileItem("", 1, 1), status: statusInvalid, inMsg: "missing"},
		{item: fileItem(`Users\Ann\x.txt`, 1, 1), status: statusInvalid, inMsg: "absolute"},
		{item: fileItem(`C:\Users\Ann\..\Bob\x.txt`, 1, 1), status: statusInvalid, inMsg: `C:\Users\Bob\x.txt`},
		{item: dirItem(`C:\Users\Ann\Stuff\`), status: statusInvalid},
		{item: fileItem(`c:\Users\Ann\x.txt`, 1, 1), status: statusInvalid},
		{item: fileItem(`C:/Users/Ann/x.txt`, 1, 1), status: statusInvalid},
		{item: fileItem(`\\?\C:\Users\Ann\x.txt`, 1, 1), status: statusInvalid},
		{item: fileItem(`\\.\C:\Users\Ann\x.txt`, 1, 1), status: statusInvalid},
		{item: fileItem(`\\?\Volume{12345678-1234-1234-1234-123456789abc}\x.txt`, 1, 1), status: statusInvalid},
		{item: fileItem(`C:\Users\Ann\*.txt`, 1, 1), status: statusInvalid},
		{item: fileItem(`C:`, 1, 1), status: statusInvalid},

		{item: fileItem(`C:\Users\Ann\gone.txt`, 1, 1), status: statusNotFound},

		{item: fileItem(`C:\Users\Ann\nowdir`, 0, 0), setup: func(f *fakeRecycle) { f.dir(`C:\Users\Ann\nowdir`) }, status: statusChanged, inMsg: "folder now"},
		{item: dirItem(`C:\Users\Ann\nowfile`), setup: func(f *fakeRecycle) { f.file(`C:\Users\Ann\nowfile`, 5, 1000) }, status: statusChanged, inMsg: "file now"},
		{item: fileItem(`C:\Users\Ann\grew.bin`, 100, 5000), setup: func(f *fakeRecycle) { f.file(`C:\Users\Ann\grew.bin`, 101, 5000) }, status: statusChanged, inMsg: "size"},
		{item: fileItem(`C:\Users\Ann\touched.txt`, 100, 5000), setup: func(f *fakeRecycle) { f.file(`C:\Users\Ann\touched.txt`, 100, 7001) }, status: statusChanged, inMsg: "modified"},
		{item: fileItem(`C:\Users\Ann\older.txt`, 100, 5000), setup: func(f *fakeRecycle) { f.file(`C:\Users\Ann\older.txt`, 100, 2999) }, status: statusChanged},

		{item: dirItem(`C:\`), setup: func(f *fakeRecycle) { f.dir(`C:\`) }, status: statusProtected, inMsg: "drive root"},
		{item: dirItem(`C:\Windows\System32`), setup: func(f *fakeRecycle) { f.dir(`C:\Windows\System32`) }, status: statusProtected},
		{item: dirItem(`C:\Users\Ann\Downloads`), setup: func(f *fakeRecycle) { f.dir(`C:\Users\Ann\Downloads`) }, status: statusProtected},
		{item: fileItem(`C:\$Recycle.Bin\S-1\$R1.txt`, 1, 1), setup: func(f *fakeRecycle) { f.file(`C:\$Recycle.Bin\S-1\$R1.txt`, 1, 1) }, status: statusProtected},
		// pagefile.sys can't even be opened for its attributes.
		{item: fileItem(`C:\pagefile.sys`, 1<<30, 1), setup: func(f *fakeRecycle) { f.openErr[`C:\pagefile.sys`] = errors.New("sharing violation") }, status: statusProtected},
		// A path whose final path is protected, although it isn't itself.
		{item: dirItem(`C:\Users\Ann\winlink\System32`), setup: func(f *fakeRecycle) {
			f.items[`C:\Users\Ann\winlink\System32`] = itemInfo{isDir: true, finalPath: `C:\Windows\System32`}
		}, status: statusProtected, inMsg: `leads to C:\Windows\System32`},

		{item: fileItem(`C:\Users\Ann\locked.txt`, 1, 1), setup: func(f *fakeRecycle) { f.openErr[`C:\Users\Ann\locked.txt`] = errors.New("access denied") }, status: statusFailed, inMsg: "could not check"},

		{item: fileItem(`E:\Movies\film.mkv`, 9, 9), setup: func(f *fakeRecycle) { f.file(`E:\Movies\film.mkv`, 9, 9) }, status: statusUnsupported, inMsg: "local fixed drive"},
		{item: fileItem(`\\server\share\x.txt`, 9, 9), setup: func(f *fakeRecycle) { f.file(`\\server\share\x.txt`, 9, 9) }, status: statusUnsupported, inMsg: "local fixed drive"},
		{item: fileItem(long, 9, 9), setup: func(f *fakeRecycle) { f.file(long, 9, 9) }, status: statusUnsupported, inMsg: "259"},
		{item: dirItem(`C:\Users\Ann\junction`), setup: func(f *fakeRecycle) {
			f.items[`C:\Users\Ann\junction`] = itemInfo{isDir: true, link: true}
		}, status: statusUnsupported, inMsg: "is a link"},
		{item: fileItem(`C:\Users\Ann\filelink.txt`, 0, 3), setup: func(f *fakeRecycle) {
			f.items[`C:\Users\Ann\filelink.txt`] = itemInfo{size: 0, mtime: 3, link: true}
		}, status: statusUnsupported, inMsg: "is a link"},
		{item: fileItem(`C:\Users\Ann\junction\inside.txt`, 7, 7), setup: func(f *fakeRecycle) {
			f.items[`C:\Users\Ann\junction\inside.txt`] = itemInfo{size: 7, mtime: 7, finalPath: `D:\Elsewhere\inside.txt`}
		}, status: statusUnsupported, inMsg: `leads elsewhere, to D:\Elsewhere\inside.txt`},
		{item: fileItem(`C:\Users\Ann\mystery.txt`, 7, 7), setup: func(f *fakeRecycle) {
			f.file(`C:\Users\Ann\mystery.txt`, 7, 7)
			f.unknown[`C:\Users\Ann\mystery.txt`] = true
		}, status: statusUnsupported, inMsg: "where the path leads"},
		{item: fileItem(`C:\Users\Ann\dot.`, 7, 7), setup: func(f *fakeRecycle) {
			f.file(`C:\Users\Ann\dot.`, 7, 7)
			f.win32[`C:\Users\Ann\dot.`] = `C:\Users\Ann\dot`
		}, status: statusUnsupported, inMsg: "differently"},

		// Within 2 seconds, another case on disk, a folder's contents: fine.
		{item: fileItem(`C:\Users\Ann\Downloads\big.iso`, 4509715660, 1730000000000), setup: func(f *fakeRecycle) {
			f.file(`C:\Users\Ann\Downloads\big.iso`, 4509715660, 1730000002000)
		}, status: statusOK},
		{item: fileItem(`C:\Users\Ann\Old.TXT`, 1, 1000), setup: func(f *fakeRecycle) {
			f.items[`C:\Users\Ann\Old.TXT`] = itemInfo{size: 1, mtime: 1000, finalPath: `C:\Users\Ann\old.txt`}
		}, status: statusOK},
		{item: dirItem(`C:\ProgramData\Cache`), setup: func(f *fakeRecycle) { f.dir(`C:\ProgramData\Cache`) }, status: statusOK},
	}
}

func TestRecycleChecks(t *testing.T) {
	f := newFakeRecycle()
	cases := recycleCases()
	var items []recycleItem
	for _, c := range cases {
		if c.setup != nil {
			c.setup(f)
		}
		items = append(items, c.item)
	}
	results, err := runRecycle(f, items, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != len(cases) {
		t.Fatalf("%d results for %d items", len(results), len(cases))
	}
	seen := map[string]bool{}
	for i, c := range cases {
		r := results[i]
		seen[r.Status] = true
		if r.Path != c.item.Path || r.Status != c.status || !strings.Contains(r.Message, c.inMsg) {
			t.Errorf("item %d %q: %s %q; want %s with %q", i, c.item.Path, r.Status, r.Message, c.status, c.inMsg)
		}
		if (r.Status == statusOK) != (r.Message == "") {
			t.Errorf("item %d: status %s with message %q", i, r.Status, r.Message)
		}
	}
	for _, st := range []string{statusInvalid, statusNotFound, statusChanged, statusProtected, statusUnsupported, statusOK, statusFailed} {
		if !seen[st] {
			t.Errorf("no case for %s", st)
		}
	}
	// A dry run changes nothing.
	if calls := f.calls(); len(calls) != 0 {
		t.Errorf("a dry run recycled %q", calls)
	}
}

func TestRecycleForReal(t *testing.T) {
	f := newFakeRecycle()
	f.file(`C:\Users\Ann\a.txt`, 1, 1)
	f.file(`C:\Users\Ann\b.txt`, 2, 2)
	f.file(`C:\Users\Ann\huge.bin`, 3, 3)
	f.file(`C:\Users\Ann\stuck.txt`, 4, 4)
	f.dir(`C:\Users\Ann\Old Projects`)
	f.dir(`C:\Users\Ann\Downloads`)
	f.recycleErr[`C:\Users\Ann\b.txt`] = errors.New("the file is in use")
	f.recycleErr[`C:\Users\Ann\huge.bin`] = errDeleteDeclined
	f.stays[`C:\Users\Ann\stuck.txt`] = true
	items := []recycleItem{
		fileItem(`C:\Users\Ann\a.txt`, 1, 1),
		fileItem(`C:\Users\Ann\b.txt`, 2, 2),
		fileItem(`C:\Users\Ann\huge.bin`, 3, 3),
		fileItem(`C:\Users\Ann\stuck.txt`, 4, 4),
		dirItem(`C:\Users\Ann\Old Projects`),
		dirItem(`C:\Users\Ann\Downloads`),    // protected: never handed to the shell
		fileItem(`C:\Users\Ann\a.txt`, 1, 1), // the same again: gone by now
	}
	results, err := runRecycle(f, items, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct{ status, inMsg string }{
		{statusRecycled, ""},
		{statusFailed, "in use"},
		{statusFailed, "permanently"},
		{statusFailed, "still there"},
		{statusRecycled, ""},
		{statusProtected, "protected"},
		{statusNotFound, ""},
	}
	for i, w := range want {
		if results[i].Status != w.status || !strings.Contains(results[i].Message, w.inMsg) {
			t.Errorf("item %d %s: %s %q, want %s %q", i, items[i].Path, results[i].Status, results[i].Message, w.status, w.inMsg)
		}
	}
	wantCalls := []string{`C:\Users\Ann\a.txt`, `C:\Users\Ann\b.txt`, `C:\Users\Ann\huge.bin`, `C:\Users\Ann\stuck.txt`, `C:\Users\Ann\Old Projects`}
	if calls := f.calls(); !reflect.DeepEqual(calls, wantCalls) {
		t.Errorf("recycled %q, want %q", calls, wantCalls)
	}
}

func TestRecycleEndpoint(t *testing.T) {
	f := newFakeRecycle()
	f.file(`C:\Users\Ann\a.txt`, 10, 1000)
	f.dir(`C:\Users\Ann\Stuff`)
	f.dir(`C:\Users`)
	h := newTestHelper(t, serverConfig{cleanup: f})

	body := func(items []recycleItem, dryRun bool) string {
		return jsonString(map[string]any{"items": items, "dryRun": dryRun})
	}
	many := make([]recycleItem, 101)
	for i := range many {
		many[i] = fileItem(fmt.Sprintf(`C:\x%d`, i), 1, 1)
	}
	for _, b := range []string{
		"", "{", `{"items": []}`, `{"items": null}`, body(many, true),
		`{"items": [{"path": "C:\\Users\\Ann\\a.txt", "size": 10, "mtime": 1000}]}`,                // no isDir
		`{"items": [{"path": "C:\\Users\\Ann\\a.txt", "isDir": false, "mtime": 1000}]}`,            // a file without size
		`{"items": [{"path": "C:\\Users\\Ann\\a.txt", "isDir": false, "size": 10}]}`,               // or mtime
		`{"items": [{"path": "C:\\Users\\Ann\\a.txt", "isDir": "no", "size": 10, "mtime": 1000}]}`, // wrong type
		`{"items": [null]}`,
	} {
		h.wantError("POST", "/v1/recycle", b, http.StatusBadRequest, codeBadRequest)
	}

	items := []recycleItem{
		dirItem(`C:\Users\Ann\Stuff`), // a folder needs no size or mtime
		fileItem(`C:\Users\Ann\a.txt`, 10, 1000),
		fileItem(`relative.txt`, 1, 1),
		dirItem(`C:\Users`),
	}
	v := h.call("POST", "/v1/recycle", body(items, true), http.StatusOK)
	want := `{"results":[{"message":"","path":"C:\\Users\\Ann\\Stuff","status":"ok"},{"message":"","path":"C:\\Users\\Ann\\a.txt","status":"ok"},` +
		`{"message":"the path is not absolute","path":"relative.txt","status":"invalid"},` +
		`{"message":"the users folder itself is protected, but not what is inside it","path":"C:\\Users","status":"protected"}]}`
	if got := jsonString(v); got != want {
		t.Errorf("dry run:\n got %s\nwant %s", got, want)
	}
	if calls := f.calls(); len(calls) != 0 {
		t.Fatalf("the dry run recycled %q", calls)
	}

	// dryRun false (or left out) recycles.
	v = h.call("POST", "/v1/recycle", `{"items": [{"path": "C:\\Users\\Ann\\a.txt", "isDir": false, "size": 10, "mtime": 1000}]}`, http.StatusOK)
	if got := jsonString(v); got != `{"results":[{"message":"","path":"C:\\Users\\Ann\\a.txt","status":"recycled"}]}` {
		t.Errorf("recycle: %s", got)
	}

	f.mu.Lock()
	f.locErr = errors.New("no known folders")
	f.mu.Unlock()
	h.wantError("POST", "/v1/recycle", body(items[:1], true), http.StatusInternalServerError, codeInternal)

	// Without a Recycle Bin the endpoint doesn't exist.
	plain := newTestHelper(t, serverConfig{})
	plain.wantError("POST", "/v1/recycle", body(items[:1], true), http.StatusNotFound, codeNotFound)
}

func TestRevealEndpoint(t *testing.T) {
	var mu sync.Mutex
	var revealed []string
	reveal := func(p string) error {
		mu.Lock()
		defer mu.Unlock()
		revealed = append(revealed, p)
		switch {
		case strings.HasSuffix(p, "gone.txt"):
			return fmt.Errorf("%w: %s", errPathNotFound, p)
		case strings.HasSuffix(p, "broken.txt"):
			return errors.New("the shell failed")
		}
		return nil
	}
	h := newTestHelper(t, serverConfig{reveal: reveal})
	if v := h.call("POST", "/v1/reveal", `{"path": "C:/Users/Ann/Videos/trip.mkv"}`, http.StatusOK); jsonString(v) != "{}" {
		t.Errorf("reveal: %v", v)
	}
	h.wantError("POST", "/v1/reveal", `{"path": "C:\\Users\\Ann\\gone.txt"}`, http.StatusNotFound, codeNotFound)
	h.wantError("POST", "/v1/reveal", `{"path": "C:\\Users\\Ann\\broken.txt"}`, http.StatusInternalServerError, codeInternal)
	for _, b := range []string{"", `{"path": ""}`, `{"path": "Videos\\trip.mkv"}`, `{"path": "\\\\.\\pipe\\x"}`, `{"path": "\\\\?\\Volume{1}\\x"}`, "{"} {
		h.wantError("POST", "/v1/reveal", b, http.StatusBadRequest, codeBadRequest)
	}
	mu.Lock()
	defer mu.Unlock()
	if want := []string{`C:\Users\Ann\Videos\trip.mkv`, `C:\Users\Ann\gone.txt`, `C:\Users\Ann\broken.txt`}; !reflect.DeepEqual(revealed, want) {
		t.Errorf("revealed %q, want %q", revealed, want)
	}

	plain := newTestHelper(t, serverConfig{})
	plain.wantError("POST", "/v1/reveal", `{"path": "C:\\x"}`, http.StatusNotFound, codeNotFound)
}

func TestFeatures(t *testing.T) {
	plain := newTestHelper(t, serverConfig{})
	if v := plain.call("GET", "/v1/info", "", http.StatusOK); fmt.Sprint(v["features"]) != "[scan]" {
		t.Errorf("without clean-up actions: %v", v["features"])
	}
	full := newTestHelper(t, serverConfig{cleanup: newFakeRecycle(), reveal: func(string) error { return nil }})
	if v := full.call("GET", "/v1/info", "", http.StatusOK); fmt.Sprint(v["features"]) != "[scan reveal recycle delete]" {
		t.Errorf("with both: %v", v["features"])
	}
	// What the helper offers on this system.
	onWindows := runtime.GOOS == "windows"
	if (platformCleanup() != nil) != onWindows || (platformReveal() != nil) != onWindows {
		t.Errorf("recycle %t, reveal %t on %s", platformCleanup() != nil, platformReveal() != nil, runtime.GOOS)
	}
}
