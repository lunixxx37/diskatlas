//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestFileInfoLayouts(t *testing.T) {
	// GetFileInformationByHandleEx wants the exact C sizes (ERROR_BAD_LENGTH otherwise).
	if b, s, a := unsafe.Sizeof(fileBasicInfo{}), unsafe.Sizeof(fileStandardInfo{}), unsafe.Sizeof(fileAttributeTagInfo{}); b != 40 || s != 24 || a != 8 {
		t.Errorf("FILE_BASIC_INFO %d, FILE_STANDARD_INFO %d, FILE_ATTRIBUTE_TAG_INFO %d bytes; want 40, 24, 8", b, s, a)
	}
}

func TestShFileOpLayout(t *testing.T) {
	var op shFileOpStruct
	size, flags, aborted := unsafe.Sizeof(op), unsafe.Offsetof(op.fFlags), unsafe.Offsetof(op.fAnyOperationsAborted)
	switch runtime.GOARCH {
	case "amd64", "arm64":
		if size != 56 || flags != 32 || aborted != 36 {
			t.Errorf("64-bit SHFILEOPSTRUCTW: size %d, fFlags at %d, fAnyOperationsAborted at %d; want 56, 32, 36", size, flags, aborted)
		}
	default:
		// Packed to 1 byte: 30 bytes, which Go rounds up to 32.
		if size < 30 || flags != 16 || aborted != 18 || unsafe.Offsetof(op.lpszProgressTitle) != 26 {
			t.Errorf("32-bit SHFILEOPSTRUCTW: size %d, fFlags at %d, fAnyOperationsAborted at %d", size, flags, aborted)
		}
	}
}

// longTempDir is a new temp folder by its final path, which is what the
// checks compare with (a temp path may use a short name, like RUNNER~1).
func longTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	info, err := windowsRecycle{}.inspect(cleaned(t, dir))
	if err != nil || info.finalPath == "" {
		t.Fatalf("inspect %s: %+v, %v", dir, info, err)
	}
	return info.finalPath
}

func TestInspect(t *testing.T) {
	sys := windowsRecycle{}
	dir := longTempDir(t)
	file := filepath.Join(dir, "real", "a.txt")
	writeTestFile(t, file, 1234)
	mklinkJ(t, filepath.Join(dir, "junc"), filepath.Join(dir, "real"))

	info, err := sys.inspect(file)
	if err != nil || info.isDir || info.link || info.size != 1234 || info.mtime != float64(testTime.UnixMilli()) || info.finalPath != file {
		t.Errorf("file: %+v, %v", info, err)
	}
	if info, err := sys.inspect(filepath.Join(dir, "real")); err != nil || !info.isDir || info.link || info.size != 0 {
		t.Errorf("folder: %+v, %v", info, err)
	}
	// The junction itself is opened, not its target.
	junc := filepath.Join(dir, "junc")
	if info, err := sys.inspect(junc); err != nil || !info.isDir || !info.link || info.finalPath != junc {
		t.Errorf("junction: %+v, %v", info, err)
	}
	// Through the junction, the final path is the real one.
	if info, err := sys.inspect(filepath.Join(junc, "a.txt")); err != nil || info.link || info.finalPath != file {
		t.Errorf("file through the junction: %+v, %v", info, err)
	}
	// Another case: the final path has the case on disk; the same path.
	upper := strings.ToUpper(file[:3]) + strings.ToUpper(file[3:])
	if info, err := sys.inspect(upper); err != nil || info.finalPath != file || !samePath(upper, info.finalPath) {
		t.Errorf("upper case: %+v, %v", info, err)
	}
	if _, err := sys.inspect(filepath.Join(dir, "missing.txt")); !errors.Is(err, errPathNotFound) {
		t.Errorf("missing: %v", err)
	}
	if _, err := sys.inspect(filepath.Join(dir, "missing", "deeper.txt")); !errors.Is(err, errPathNotFound) {
		t.Errorf("missing folder: %v", err)
	}
	if c, n := sys.driveType(`C:\Users`), sys.driveType(`\\server\share\x`); c != "fixed" || n != "network" {
		t.Errorf("driveType: C: %s, network path %s", c, n)
	}
}

func TestWin32Path(t *testing.T) {
	sys := windowsRecycle{}
	if p, err := sys.win32Path(`C:\Users\Ann\a.txt`); err != nil || p != `C:\Users\Ann\a.txt` {
		t.Errorf("plain path: %q, %v", p, err)
	}
	for _, in := range []string{`C:\Users\Ann\dot.`, `C:\Users\Ann\space `, `C:\Users\Ann\NUL`} {
		if p, err := sys.win32Path(in); err != nil || p == in {
			t.Errorf("win32Path(%q) = %q, %v; Win32 should rewrite it", in, p, err)
		}
	}
}

func TestRealLocations(t *testing.T) {
	loc, err := windowsRecycle{}.locations()
	if err != nil {
		t.Fatal(err)
	}
	prot := newProtection(loc)
	profile, _ := windows.KnownFolderPath(windows.FOLDERID_Profile, 0)
	downloads, _ := windows.KnownFolderPath(windows.FOLDERID_Downloads, 0)
	exe, _ := os.Executable()
	for _, p := range []string{
		`C:\`, loc.windows, filepath.Join(loc.windows, "System32", "kernel32.dll"),
		os.Getenv("ProgramFiles"), filepath.Join(os.Getenv("ProgramFiles"), "x"),
		loc.programData, loc.userProfiles, profile, filepath.Join(profile, "AppData", "Local"),
		downloads, exe, filepath.Dir(exe),
	} {
		if _, ok := prot.check(cleaned(t, p)); !ok {
			t.Errorf("%s is not protected", p)
		}
	}
	for _, p := range []string{filepath.Join(downloads, "big.iso"), filepath.Join(loc.programData, "SomeCache")} {
		if why, ok := prot.check(cleaned(t, p)); ok {
			t.Errorf("%s is protected: %s", p, why)
		}
	}
	t.Logf("%d profiles, %d protected trees, %d protected folders", len(loc.profiles), len(prot.trees), len(prot.exact))
}

func TestRealChecksDryRun(t *testing.T) {
	dir := longTempDir(t)
	writeTestFile(t, filepath.Join(dir, "keep.txt"), 100)
	writeTestFile(t, filepath.Join(dir, "folder", "inner.txt"), 5)
	writeTestFile(t, filepath.Join(dir, "grows.txt"), 10)
	writeTestFile(t, filepath.Join(dir, "vanishes.txt"), 10)
	mklinkJ(t, filepath.Join(dir, "junc"), filepath.Join(dir, "folder"))
	// A name Win32 would rewrite (the shell would recycle "dot" instead).
	dot := `\\?\` + filepath.Join(dir, "dot.")
	if err := os.WriteFile(dot, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		name, _ := windows.UTF16PtrFromString(dot)
		windows.DeleteFile(name)
	})

	// The values the website sends come from a scan.
	_, d := scanTree(t, dir, false)
	idx := d.byPath(t)
	item := func(rel string) recycleItem {
		i, ok := idx[rel]
		if !ok {
			t.Fatalf("%s is not in the scan", rel)
		}
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if d.kind[i]&kindFolder != 0 {
			return dirItem(p)
		}
		return fileItem(p, d.size[i], d.mtime[i])
	}
	through := item("folder/inner.txt")
	through.Path = filepath.Join(dir, "junc", "inner.txt")

	// Changes after the scan.
	if err := os.WriteFile(filepath.Join(dir, "grows.txt"), []byte("now longer than before"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "vanishes.txt")); err != nil {
		t.Fatal(err)
	}

	items := []recycleItem{item("keep.txt"), item("folder"), item("junc"), through, item("grows.txt"), item("vanishes.txt"), item("dot.")}
	want := []string{statusOK, statusOK, statusUnsupported, statusUnsupported, statusChanged, statusNotFound, statusUnsupported}
	results, err, _ := recycleAsUser(windowsRecycle{}, items, true)
	if err != nil {
		t.Fatal(err)
	}
	for i, r := range results {
		if r.Status != want[i] {
			t.Errorf("%s: %s %q, want %s", r.Path, r.Status, r.Message, want[i])
		}
	}
	// Nothing was changed.
	for _, rel := range []string{"keep.txt", "folder", "folder/inner.txt", "junc", "grows.txt"} {
		if _, err := os.Lstat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
			t.Errorf("after the dry run: %v", err)
		}
	}
}

func TestPagefileIsProtected(t *testing.T) {
	// pagefile.sys can't be opened even for its attributes.
	var fd findData
	name, _ := windows.UTF16PtrFromString(`\\?\C:\pagefile.sys`)
	h, err := findFirstFileEx(name, &fd)
	if err != nil {
		t.Skip("no C:\\pagefile.sys here")
	}
	windows.FindClose(h)
	size := float64(uint64(fd.FileSizeHigh)<<32 | uint64(fd.FileSizeLow))
	results, err, _ := recycleAsUser(windowsRecycle{}, []recycleItem{fileItem(`C:\pagefile.sys`, size, filetimeToMs(filetime64(fd.LastWriteTime)))}, true)
	if err != nil || results[0].Status != statusProtected {
		t.Errorf("C:\\pagefile.sys: %+v, %v", results, err)
	}
}

func TestShellThread(t *testing.T) {
	procCoGetApartmentType := windows.NewLazySystemDLL("ole32.dll").NewProc("CoGetApartmentType")
	var threads [2]uint32
	for i := range threads {
		err := theShell.run(func() error {
			threads[i] = windows.GetCurrentThreadId()
			var apt, qualifier int32
			hr, _, _ := syscall.SyscallN(procCoGetApartmentType.Addr(), uintptr(unsafe.Pointer(&apt)), uintptr(unsafe.Pointer(&qualifier)))
			if hr != 0 {
				return hresultError(hr)
			}
			if apt != 0 && apt != 3 { // APTTYPE_STA, APTTYPE_MAINSTA
				return errors.New("COM is not in a single-threaded apartment")
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if threads[0] != threads[1] || threads[0] == windows.GetCurrentThreadId() {
		t.Errorf("shell calls ran on threads %v (test thread %d)", threads, windows.GetCurrentThreadId())
	}
	// A panic in a shell call is an error, and the thread keeps serving.
	if err := theShell.run(func() error { panic("boom") }); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Errorf("panic: %v", err)
	}
	if err := theShell.run(func() error { return nil }); err != nil {
		t.Errorf("after the panic: %v", err)
	}
}

// TestRealRecycle moves a temp file into the user's Recycle Bin. It runs
// only with DISKATLAS_TEST_RECYCLE=1.
func TestRealRecycle(t *testing.T) {
	if os.Getenv("DISKATLAS_TEST_RECYCLE") != "1" {
		t.Skip("set DISKATLAS_TEST_RECYCLE=1 to move a temp file into the Recycle Bin")
	}
	dir := longTempDir(t)
	file := filepath.Join(dir, "DiskAtlas-recycle-test.txt")
	writeTestFile(t, file, 42)
	_, d := scanTree(t, dir, false)
	i := d.byPath(t)["DiskAtlas-recycle-test.txt"]
	results, err, _ := recycleAsUser(windowsRecycle{}, []recycleItem{fileItem(file, d.size[i], d.mtime[i])}, false)
	if err != nil || results[0].Status != statusRecycled {
		t.Fatalf("recycle: %+v, %v", results, err)
	}
	if _, err := os.Lstat(file); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the file is still there: %v", err)
	}
}

// TestRealReveal opens a File Explorer window. It runs only with
// DISKATLAS_TEST_SHELL=1.
func TestRealReveal(t *testing.T) {
	if os.Getenv("DISKATLAS_TEST_SHELL") != "1" {
		t.Skip("set DISKATLAS_TEST_SHELL=1 to open File Explorer")
	}
	dir := longTempDir(t)
	file := filepath.Join(dir, "shown.txt")
	writeTestFile(t, file, 1)
	if err := revealItem(file); err != nil {
		t.Errorf("reveal a file: %v", err)
	}
	if err := revealItem(dir); err != nil {
		t.Errorf("reveal a folder: %v", err)
	}
	if err := revealItem(filepath.Join(dir, "missing.txt")); !errors.Is(err, errPathNotFound) {
		t.Errorf("reveal a missing file: %v", err)
	}
}
