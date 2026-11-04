//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// These tests delete permanently, but only inside their own temp folders.

func statItem(t *testing.T, p string) recycleItem {
	t.Helper()
	fi, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	if fi.IsDir() {
		return dirItem(p)
	}
	return fileItem(p, float64(fi.Size()), float64(fi.ModTime().UnixMilli()))
}

func deleteOne(t *testing.T, it recycleItem, dryRun bool) deleteResult {
	t.Helper()
	results, err, _ := deleteAsUser(windowsRecycle{}, []recycleItem{it}, dryRun)
	if err != nil {
		t.Fatal(err)
	}
	return results[0]
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func setAttrs(t *testing.T, p string, attrs uint32) {
	t.Helper()
	name, _ := windows.UTF16PtrFromString(`\\?\` + p)
	if err := windows.SetFileAttributes(name, attrs); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteNestedTree(t *testing.T) {
	base := longTempDir(t)
	victim := filepath.Join(base, "victim")
	writeTestFile(t, filepath.Join(victim, "a.txt"), 10)
	writeTestFile(t, filepath.Join(victim, "sub", "b.txt"), 20)
	writeTestFile(t, filepath.Join(victim, "sub", "deeper", "c.txt"), 30)
	writeTestFile(t, filepath.Join(victim, "sub", "readonly.txt"), 40)
	setAttrs(t, filepath.Join(victim, "sub", "readonly.txt"), windows.FILE_ATTRIBUTE_READONLY)
	writeTestFile(t, filepath.Join(victim, "sub", "hidden.sys"), 50)
	setAttrs(t, filepath.Join(victim, "sub", "hidden.sys"), windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM|windows.FILE_ATTRIBUTE_READONLY)
	// A read-only folder, as customized folders are: RemoveDirectoryW refuses it as it is.
	writeTestFile(t, filepath.Join(victim, "custom", "desktop.ini"), 5)
	setAttrs(t, filepath.Join(victim, "custom"), windows.FILE_ATTRIBUTE_READONLY)
	// A path over 260 characters.
	deep := filepath.Join(victim, strings.Repeat("L", 120), strings.Repeat("M", 120))
	writeTestFile(t, filepath.Join(deep, "deep.txt"), 7)
	if len(filepath.Join(deep, "deep.txt")) <= 260 {
		t.Fatalf("test bug: the deep path is only %d long", len(deep))
	}
	// A name that isn't valid Unicode, which the listing's UTF-16 keeps.
	odd, _ := windows.UTF16FromString(`\\?\` + victim + `\odd`)
	odd = append(odd[:len(odd)-1:len(odd)-1], 0xd800, 0)
	if err := windows.CreateDirectory(&odd[0], nil); err != nil {
		t.Fatal(err)
	}

	// A dry run changes nothing.
	if r := deleteOne(t, dirItem(victim), true); r.Status != statusOK || r.DeletedFiles+r.DeletedFolders+r.FailedEntries != 0 {
		t.Fatalf("dry run: %+v", r)
	}
	for _, p := range []string{filepath.Join(victim, "a.txt"), filepath.Join(victim, "sub", "readonly.txt"), filepath.Join(deep, "deep.txt")} {
		if !exists(p) {
			t.Fatalf("the dry run removed %s", p)
		}
	}

	r := deleteOne(t, dirItem(victim), false)
	// Files: a, b, c, readonly, hidden, desktop.ini, deep. Folders: sub,
	// deeper, custom, L…, M…, odd and the item itself.
	want := deleteResult{Path: victim, Status: statusDeleted, DeletedFiles: 7, DeletedFolders: 7}
	if r != want {
		t.Errorf("delete:\n got %+v\nwant %+v", r, want)
	}
	if exists(victim) {
		t.Error("the folder is still there")
	}
}

func TestDeleteNeverEntersLinks(t *testing.T) {
	base := longTempDir(t)
	// A sibling folder outside the item, which links inside it point to.
	target := filepath.Join(base, "target")
	writeTestFile(t, filepath.Join(target, "keep1.txt"), 11)
	writeTestFile(t, filepath.Join(target, "sub", "keep2.txt"), 22)

	victim := filepath.Join(base, "victim")
	writeTestFile(t, filepath.Join(victim, "own.txt"), 3)
	if err := os.MkdirAll(filepath.Join(victim, "inner"), 0o755); err != nil {
		t.Fatal(err)
	}
	mklinkJ(t, filepath.Join(victim, "inner", "junc"), target) // deep inside
	mklinkJ(t, filepath.Join(victim, "junc"), target)          // a direct child
	wantFiles, wantFolders := 1, 4                             // own.txt; inner, both junctions, victim
	if err := os.Symlink(filepath.Join(target, "keep1.txt"), filepath.Join(victim, "filelink")); err == nil {
		wantFiles++
	} else {
		t.Logf("no file symbolic link (needs developer mode or admin rights): %v", err)
	}
	if err := os.Symlink(target, filepath.Join(victim, "dirlink")); err == nil {
		wantFolders++
	} else {
		t.Logf("no folder symbolic link: %v", err)
	}

	r := deleteOne(t, dirItem(victim), false)
	if r.Status != statusDeleted || r.DeletedFiles != wantFiles || r.DeletedFolders != wantFolders || r.FailedEntries != 0 {
		t.Errorf("delete: %+v, want %d files and %d folders", r, wantFiles, wantFolders)
	}
	if exists(victim) {
		t.Error("the folder is still there")
	}
	// The link targets and everything in them survive.
	for p, size := range map[string]int64{filepath.Join(target, "keep1.txt"): 11, filepath.Join(target, "sub", "keep2.txt"): 22} {
		fi, err := os.Stat(p)
		if err != nil || fi.Size() != size {
			t.Errorf("link target damaged: %s: %v", p, err)
		}
	}
}

func TestDeleteDirectLinkItemsAreRefused(t *testing.T) {
	base := longTempDir(t)
	target := filepath.Join(base, "target")
	writeTestFile(t, filepath.Join(target, "keep.txt"), 5)
	junc := filepath.Join(base, "junc")
	mklinkJ(t, junc, target)
	if r := deleteOne(t, dirItem(junc), false); r.Status != statusUnsupported || !strings.Contains(r.Message, "is a link") {
		t.Errorf("a junction as the item: %+v", r)
	}
	through := statItem(t, filepath.Join(junc, "keep.txt"))
	if r := deleteOne(t, through, false); r.Status != statusUnsupported || !strings.Contains(r.Message, "leads elsewhere") {
		t.Errorf("a file through a junction: %+v", r)
	}
	// Even without the checks, deleteItem refuses paths that lead elsewhere.
	for _, c := range []struct {
		path  string
		isDir bool
	}{{junc, true}, {filepath.Join(junc, "keep.txt"), false}} {
		got := windowsRecycle{}.deleteItem(c.path, c.isDir)
		if got.files+got.folders != 0 || got.failed != 1 || got.firstErr != errPathChanged {
			t.Errorf("deleteItem(%s): %+v", c.path, got)
		}
	}
	if !exists(filepath.Join(target, "keep.txt")) || !exists(junc) {
		t.Error("something was deleted")
	}
}

func TestDeleteFileInUse(t *testing.T) {
	base := longTempDir(t)
	victim := filepath.Join(base, "victim")
	writeTestFile(t, filepath.Join(victim, "a.txt"), 1)
	writeTestFile(t, filepath.Join(victim, "b.txt"), 2)
	locked := filepath.Join(victim, "data", "db.lock")
	writeTestFile(t, locked, 3)
	// Held open without FILE_SHARE_DELETE, as a database would.
	name, _ := windows.UTF16PtrFromString(locked)
	h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)

	// The file alone: nothing could be deleted.
	if r := deleteOne(t, statItem(t, locked), false); r.Status != statusFailed || r.DeletedFiles != 0 || r.FailedEntries != 1 ||
		r.Message != "1 entry could not be deleted: "+locked+": in use by another process" {
		t.Errorf("the file in use: %+v", r)
	}
	// Its folder: the rest goes, the file and the folders around it stay.
	r := deleteOne(t, dirItem(victim), false)
	want := deleteResult{Path: victim, Status: statusPartial, DeletedFiles: 2, DeletedFolders: 0, FailedEntries: 1,
		Message: "1 entry could not be deleted: " + locked + ": in use by another process"}
	if r != want {
		t.Errorf("the folder:\n got %+v\nwant %+v", r, want)
	}
	if !exists(locked) || exists(filepath.Join(victim, "a.txt")) || exists(filepath.Join(victim, "b.txt")) {
		t.Error("wrong entries are left")
	}
	// Once the file is closed, a second run finishes the job.
	windows.CloseHandle(h)
	if r := deleteOne(t, dirItem(victim), false); r.Status != statusDeleted || r.DeletedFiles != 1 || r.DeletedFolders != 2 {
		t.Errorf("second run: %+v", r)
	}
}

func TestDeleteSingleFiles(t *testing.T) {
	base := longTempDir(t)
	ro := filepath.Join(base, "readonly.txt")
	writeTestFile(t, ro, 9)
	setAttrs(t, ro, windows.FILE_ATTRIBUTE_READONLY)
	it := statItem(t, ro)
	if r := deleteOne(t, it, true); r.Status != statusOK || !exists(ro) {
		t.Fatalf("dry run: %+v", r)
	}
	if r := deleteOne(t, it, false); r.Status != statusDeleted || r.DeletedFiles != 1 || r.DeletedFolders != 0 || exists(ro) {
		t.Errorf("read-only file: %+v", r)
	}
	// A long path, which the Recycle Bin can't take but deletion can.
	long := filepath.Join(base, strings.Repeat("x", 150), strings.Repeat("y", 150)+".txt")
	writeTestFile(t, long, 4)
	it = statItem(t, long)
	if rec, _, _ := recycleAsUser(windowsRecycle{}, []recycleItem{it}, true); rec[0].Status != statusUnsupported {
		t.Errorf("recycle of a long path: %+v", rec[0])
	}
	if r := deleteOne(t, it, false); r.Status != statusDeleted || exists(long) {
		t.Errorf("long path: %+v", r)
	}
}
