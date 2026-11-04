//go:build windows

package main

import (
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestFindDataLayout(t *testing.T) {
	if size := unsafe.Sizeof(findData{}); size != 592 {
		t.Errorf("findData is %d bytes, WIN32_FIND_DATAW is 592", size)
	}
	if off := unsafe.Offsetof(findData{}.Reserved0); off != 36 {
		t.Errorf("dwReserved0 at %d, want 36", off)
	}
	if off := unsafe.Offsetof(findData{}.FileName); off != 44 {
		t.Errorf("cFileName at %d, want 44", off)
	}
}

func TestExtendedPaths(t *testing.T) {
	for in, want := range map[string]string{
		`C:\`:              `\\?\C:\`,
		`C:\Users\Ann`:     `\\?\C:\Users\Ann`,
		`\\server\share\`:  `\\?\UNC\server\share\`,
		`\\server\share\x`: `\\?\UNC\server\share\x`,
	} {
		if got := extendedPath(in); got != want {
			t.Errorf("extendedPath(%q) = %q, want %q", in, got, want)
		}
		p, err := makeDirPath(in)
		if err != nil {
			t.Fatal(err)
		}
		if got := displayPath(p); got != in {
			t.Errorf("displayPath(makeDirPath(%q)) = %q", in, got)
		}
	}
	for in, want := range map[string]string{`C:\Users`: `C:\`, `\\server\share\x\y`: `\\server\share\`} {
		if got := volumeRoot(in); got != want {
			t.Errorf("volumeRoot(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestOpenRoot(t *testing.T) {
	root, err := openRoot(`C:\`)
	if err != nil {
		t.Fatal(err)
	}
	if root.name != "C:" || root.kind&kindFolder == 0 || root.cluster < 512 || root.mtime <= 0 || displayPath(root.dir) != `C:\` {
		t.Errorf("C:\\ = %+v (dir %s)", root, displayPath(root.dir))
	}
	dir := t.TempDir()
	if _, err := openRoot(filepath.Join(dir, "missing")); !errors.Is(err, errPathNotFound) {
		t.Errorf("missing folder: %v", err)
	}
	if _, err := openRoot(filepath.Join(dir, "missing", "deeper")); !errors.Is(err, errPathNotFound) {
		t.Errorf("missing parent: %v", err)
	}
	file := filepath.Join(dir, "f.txt")
	writeTestFile(t, file, 1)
	if _, err := openRoot(file); !errors.Is(err, errNotDirectory) {
		t.Errorf("file: %v", err)
	}
}

func scanTree(t *testing.T, dir string, allocated bool) (*scan, decoded) {
	t.Helper()
	p := cleaned(t, dir)
	root, err := openRoot(p)
	if err != nil {
		t.Fatal(err)
	}
	sc := newScan("s1", p, allocated, root, listDir, 4)
	sc.run(root)
	res, state, failure := sc.snapshot()
	if state != stateDone {
		t.Fatalf("state %s: %s", state, failure)
	}
	return sc, decodeResult(t, encode(t, res))
}

func mklinkJ(t *testing.T, link, target string) {
	t.Helper()
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("mklink /J: %v: %s", err, out)
	}
}

func TestWalkJunctionAndLinks(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "a.txt"), 10)
	writeTestFile(t, filepath.Join(dir, "sub", "b.bin"), 5000)
	mklinkJ(t, filepath.Join(dir, "junc"), filepath.Join(dir, "sub"))
	// A junction pointing at its own parent would loop forever if followed.
	mklinkJ(t, filepath.Join(dir, "sub", "loop"), dir)

	// Symbolic links need developer mode or admin rights; use them if possible.
	symlinks := os.Symlink(filepath.Join(dir, "sub"), filepath.Join(dir, "dirlink")) == nil &&
		os.Symlink(filepath.Join(dir, "a.txt"), filepath.Join(dir, "filelink")) == nil
	if !symlinks {
		t.Log("no symbolic links (needs developer mode)")
	}

	sc, d := scanTree(t, dir, true)
	idx := d.byPath(t)
	want := map[string]uint8{
		"a.txt": 0, "sub": kindFolder, "sub/b.bin": 0,
		"junc": kindFolder | kindLink, "sub/loop": kindFolder | kindLink,
	}
	if symlinks {
		want["dirlink"] = kindFolder | kindLink
		want["filelink"] = kindLink
	}
	if d.count != len(want)+1 {
		t.Errorf("%d entries, want %d: %q", d.count, len(want)+1, d.names)
	}
	for path, kind := range want {
		i, ok := idx[path]
		if !ok {
			t.Errorf("%s is missing", path)
			continue
		}
		if d.kind[i] != kind {
			t.Errorf("%s: kind %d, want %d", path, d.kind[i], kind)
		}
		if kind&kindLink != 0 && (d.size[i] != 0 || d.alloc[i] != 0) {
			t.Errorf("link %s: size %v, on disk %v", path, d.size[i], d.alloc[i])
		}
	}
	// Nothing below the links: they were listed, not followed.
	for path := range idx {
		for _, link := range []string{"junc/", "sub/loop/", "dirlink/"} {
			if strings.HasPrefix(path, link) {
				t.Errorf("followed a link: %s", path)
			}
		}
	}
	if p := sc.progress(); p.Errors != 0 || p.Bytes != 5010 {
		t.Errorf("progress %+v", p)
	}
}

func TestWalkCompressedAndSparse(t *testing.T) {
	dir := t.TempDir()
	const size = 1 << 20
	compressed := filepath.Join(dir, "zeros.bin")
	if err := os.WriteFile(compressed, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
	canCompress := exec.Command("compact", "/c", "/q", compressed).Run() == nil

	sparse := filepath.Join(dir, "sparse.bin")
	canSparse := makeSparse(t, sparse, 64<<20) == nil

	_, d := scanTree(t, dir, true)
	idx := d.byPath(t)
	if canCompress {
		i := idx["zeros.bin"]
		if d.size[i] != size || d.alloc[i] >= size || d.kind[i] != 0 {
			t.Errorf("compressed file: size %v, on disk %v, kind %d", d.size[i], d.alloc[i], d.kind[i])
		}
		t.Logf("compressed: %v bytes on disk for %d", d.alloc[i], size)
	} else {
		t.Log("compact /c failed; not an NTFS volume?")
	}
	if canSparse {
		i := idx["sparse.bin"]
		if d.size[i] != 64<<20 || d.alloc[i] >= 1<<20 || d.kind[i] != 0 {
			t.Errorf("sparse file: size %v, on disk %v, kind %d", d.size[i], d.alloc[i], d.kind[i])
		}
		t.Logf("sparse: %v bytes on disk for %d", d.alloc[i], 64<<20)
	} else {
		t.Log("could not make a sparse file")
	}
	if !canCompress && !canSparse {
		t.Skip("neither compressed nor sparse files are possible here")
	}
}

// makeSparse creates a sparse file of the given size without data.
func makeSparse(t *testing.T, path string, size int64) error {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	const fsctlSetSparse = 0x000900c4
	var n uint32
	if err := windows.DeviceIoControl(windows.Handle(f.Fd()), fsctlSetSparse, nil, 0, nil, 0, &n, nil); err != nil {
		return err
	}
	return f.Truncate(size)
}

func TestWalkLongPath(t *testing.T) {
	dir := t.TempDir()
	deep := dir
	for i := range 12 {
		deep = filepath.Join(deep, strings.Repeat(string(rune('a'+i)), 30))
	}
	if len(deep) < 300 {
		t.Fatalf("test bug: path only %d long", len(deep))
	}
	writeTestFile(t, filepath.Join(deep, "deep.txt"), 123)
	sc, d := scanTree(t, dir, true)
	if p := sc.progress(); p.Errors != 0 || p.Files != 1 || p.Dirs != 12 || p.Bytes != 123 {
		t.Errorf("progress %+v", p)
	}
	if d.names[d.count-1] != "deep.txt" {
		t.Errorf("last entry %q", d.names[d.count-1])
	}
}

func TestWalkNonUnicodeName(t *testing.T) {
	// Windows allows unpaired surrogates in names. Such a folder must still
	// be listed: the helper keeps the listing's UTF-16 names for that.
	dir := t.TempDir()
	base, _ := windows.UTF16FromString(extendedPath(cleaned(t, dir)) + `\bad`)
	name := append(base[:len(base)-1:len(base)-1], 0xd800, 0)
	if err := windows.CreateDirectory(&name[0], nil); err != nil {
		t.Skipf("CreateDirectory: %v", err)
	}
	inner := append(name[:len(name)-1:len(name)-1], append([]uint16{'\\'}, utf16z("inner.txt")...)...)
	h, err := windows.CreateFile(&inner[0], windows.GENERIC_WRITE, 0, nil, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	var written uint32
	windows.WriteFile(h, []byte("hello"), &written, nil)
	windows.CloseHandle(h)
	// os.RemoveAll can't remove names that aren't valid Unicode.
	t.Cleanup(func() {
		windows.DeleteFile(&inner[0])
		windows.RemoveDirectory(&name[0])
	})

	sc, d := scanTree(t, dir, false)
	idx := d.byPath(t)
	if i, ok := idx["bad\uFFFD/inner.txt"]; !ok || d.size[i] != 5 {
		t.Errorf("inner file: found %t in %q", ok, d.names)
	}
	if p := sc.progress(); p.Errors != 0 {
		t.Errorf("progress %+v", p)
	}
}

func utf16z(s string) []uint16 {
	u, _ := windows.UTF16FromString(s)
	return u
}

func TestScanDriveRootName(t *testing.T) {
	// "c:" means C:\ and its root entry is named "C:". The lister never
	// starts, so the real drive isn't listed, only its attributes are read.
	release := make(chan struct{})
	defer close(release)
	h := newTestHelper(t, serverConfig{list: blockingList(release, nil)})
	if v := h.call("POST", "/v1/scans", `{"path": "c:"}`, http.StatusAccepted); v["id"] != "s1" {
		t.Fatalf("start: %v", v)
	}
	p := h.call("POST", "/v1/scans/s1/cancel", "", http.StatusAccepted)
	if p["path"] != `C:\` || p["state"] != stateCancelled {
		t.Errorf("progress %v", p)
	}
	d, _ := h.fetchResult("s1")
	if d.names[0] != "C:" {
		t.Errorf("root name %q, want C:", d.names[0])
	}
}

func TestListDrives(t *testing.T) {
	drives := listDrives()
	var c *drive
	for i := range drives {
		if i > 0 && drives[i].Path <= drives[i-1].Path {
			t.Errorf("not in letter order: %v", drives)
		}
		if drives[i].Path == `C:\` {
			c = &drives[i]
		}
		if !drives[i].Ready && (drives[i].Label != "" || drives[i].FileSystem != "" || drives[i].TotalBytes != 0 || drives[i].ClusterBytes != 0) {
			t.Errorf("a drive that isn't ready has details: %+v", drives[i])
		}
	}
	if c == nil {
		t.Fatalf("no C: in %v", drives)
	}
	if c.Type != "fixed" || !c.Ready || c.FileSystem == "" || c.TotalBytes == 0 || c.FreeBytes > c.TotalBytes || c.ClusterBytes < 512 {
		t.Errorf("C: = %+v", *c)
	}
	t.Logf("%d drives; C: %s, %d bytes, cluster %d", len(drives), c.FileSystem, c.TotalBytes, c.ClusterBytes)
}
