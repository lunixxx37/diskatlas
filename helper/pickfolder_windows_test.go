//go:build windows

package main

import (
	"os"
	"runtime"
	"syscall"
	"testing"
	"unsafe"
)

func TestWndClassExLayout(t *testing.T) {
	want := map[string]uintptr{"amd64": 80, "arm64": 80, "386": 48}[runtime.GOARCH]
	if size := unsafe.Sizeof(wndClassEx{}); size != want {
		t.Errorf("wndClassEx is %d bytes, WNDCLASSEXW is %d", size, want)
	}
}

func TestFolderDialogPlumbing(t *testing.T) {
	// Creates and sets up the dialog on the shell thread, but never shows
	// it, so no window opens.
	err := theShell.run(func() error {
		for _, start := range []string{`C:\`, `C:\does\not\exist`, ""} {
			dlg, err := newFolderDialog("DiskAtlas test", start)
			if err != nil {
				return err
			}
			var opts uint32
			if hr := dlg.call(methodGetOptions, uintptr(unsafe.Pointer(&opts))); hrFailed(hr) {
				dlg.release()
				return hresultError(hr)
			}
			dlg.release()
			if want := uint32(fosPickFolders | fosForceFileSystem | fosPathMustExist); opts&want != want {
				t.Errorf("options %#x lack %#x", opts, want)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !isFolder(`C:\`) || isFolder(`C:\does\not\exist`) {
		t.Error("isFolder")
	}
}

func TestDialogOwnerWindow(t *testing.T) {
	if usableOwner(0) {
		t.Error("no window is no owner")
	}
	// The helper's own owner window: created and destroyed on the shell
	// thread, without making it the foreground window.
	err := theShell.run(func() error {
		w, err := createOwnerWindow()
		if err != nil {
			return err
		}
		defer syscall.SyscallN(procDestroyWindow.Addr(), uintptr(w))
		if usableOwner(w) {
			t.Error("the hidden owner window counts as a usable foreground window")
		}
		if c := windowClass(w); c != ownerClassName {
			t.Errorf("class %q", c)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// TestRealPickFolder opens the dialog on the screen. It runs only with
// DISKATLAS_TEST_SHELL=1.
func TestRealPickFolder(t *testing.T) {
	if os.Getenv("DISKATLAS_TEST_SHELL") != "1" {
		t.Skip("set DISKATLAS_TEST_SHELL=1 to open the folder dialog")
	}
	path, cancelled, err := pickFolder("DiskAtlas test: choose any folder", `C:\`)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("path %q, cancelled %t", path, cancelled)
}
