//go:build windows

package main

import (
	"fmt"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// POST /v1/pick-folder: Windows' own folder dialog (IFileOpenDialog), which,
// unlike the browser's picker, allows drive roots and system folders.

var (
	modole32                        = windows.NewLazySystemDLL("ole32.dll")
	procCoCreateInstance            = modole32.NewProc("CoCreateInstance")
	procSHCreateItemFromParsingName = modshell32.NewProc("SHCreateItemFromParsingName")

	procIsWindow            = moduser32.NewProc("IsWindow")
	procIsWindowVisible     = moduser32.NewProc("IsWindowVisible")
	procGetClassNameW       = moduser32.NewProc("GetClassNameW")
	procRegisterClassExW    = moduser32.NewProc("RegisterClassExW")
	procDefWindowProcW      = moduser32.NewProc("DefWindowProcW")
	procCreateWindowExW     = moduser32.NewProc("CreateWindowExW")
	procDestroyWindow       = moduser32.NewProc("DestroyWindow")
	procShowWindow          = moduser32.NewProc("ShowWindow")
	procSetForegroundWindow = moduser32.NewProc("SetForegroundWindow")
	procBringWindowToTop    = moduser32.NewProc("BringWindowToTop")
	procAttachThreadInput   = moduser32.NewProc("AttachThreadInput")
	procGetSystemMetrics    = moduser32.NewProc("GetSystemMetrics")
)

var (
	clsidFileOpenDialog = windows.GUID{Data1: 0xdc1c5a9c, Data2: 0xe88a, Data3: 0x4dde, Data4: [8]byte{0xa5, 0xa1, 0x60, 0xf8, 0x2a, 0x20, 0xae, 0xf7}}
	iidIFileOpenDialog  = windows.GUID{Data1: 0xd57c7288, Data2: 0xd4ad, Data3: 0x4768, Data4: [8]byte{0xbe, 0x02, 0x9d, 0x96, 0x95, 0x32, 0xd9, 0x60}}
	iidIShellItem       = windows.GUID{Data1: 0x43826d1e, Data2: 0xe718, Data3: 0x42ee, Data4: [8]byte{0xbc, 0x55, 0xa1, 0xe2, 0x61, 0xc3, 0x7b, 0xfe}}
)

const (
	clsctxInprocServer = 0x1
	fosPickFolders     = 0x20
	fosForceFileSystem = 0x40
	fosPathMustExist   = 0x800
	sigdnFileSysPath   = 0x80058000
	hresultCancelled   = 0x800704c7 // HRESULT_FROM_WIN32(ERROR_CANCELLED): the user closed the dialog

	// Method numbers in the interfaces' tables (IUnknown, IModalWindow,
	// IFileDialog, then IFileOpenDialog; IShellItem).
	methodRelease        = 2
	methodShow           = 3
	methodSetOptions     = 9
	methodGetOptions     = 10
	methodSetFolder      = 12
	methodSetTitle       = 17
	methodGetResult      = 20
	methodGetDisplayName = 5
)

// comObject is a COM interface: a pointer to its table of methods.
type comObject struct {
	vtbl *[32]uintptr
}

func (o *comObject) call(method int, args ...uintptr) uintptr {
	r, _, _ := syscall.SyscallN(o.vtbl[method], append([]uintptr{uintptr(unsafe.Pointer(o))}, args...)...)
	return r
}

func (o *comObject) release() { o.call(methodRelease) }

func hrFailed(hr uintptr) bool { return int32(uint32(hr)) < 0 }

func platformPick() func(title, startPath string) (string, bool, error) { return pickFolder }

// pickFolder shows the dialog on the shell thread, owned by the window that
// is in the foreground when the request arrives, normally the browser.
func pickFolder(title, startPath string) (string, bool, error) {
	owner := windows.GetForegroundWindow()
	var path string
	var cancelled bool
	err := theShell.run(func() error {
		dlg, err := newFolderDialog(title, startPath)
		if err != nil {
			return err
		}
		defer dlg.release()
		path, cancelled, err = showFolderDialog(dlg, owner)
		return err
	})
	return path, cancelled, err
}

// newFolderDialog creates the dialog for folders of the file system that
// exist, with the title and, if it is a folder, the start folder. Nothing is
// shown yet.
func newFolderDialog(title, startPath string) (*comObject, error) {
	var dlg *comObject
	hr, _, _ := syscall.SyscallN(procCoCreateInstance.Addr(), uintptr(unsafe.Pointer(&clsidFileOpenDialog)), 0,
		clsctxInprocServer, uintptr(unsafe.Pointer(&iidIFileOpenDialog)), uintptr(unsafe.Pointer(&dlg)))
	if hrFailed(hr) || dlg == nil {
		return nil, fmt.Errorf("could not create the folder dialog: %w", hresultError(hr))
	}
	var opts uint32
	if hr := dlg.call(methodGetOptions, uintptr(unsafe.Pointer(&opts))); hrFailed(hr) {
		dlg.release()
		return nil, hresultError(hr)
	}
	if hr := dlg.call(methodSetOptions, uintptr(opts|fosPickFolders|fosForceFileSystem|fosPathMustExist)); hrFailed(hr) {
		dlg.release()
		return nil, hresultError(hr)
	}
	if title != "" {
		if t, err := windows.UTF16PtrFromString(title); err == nil {
			dlg.call(methodSetTitle, uintptr(unsafe.Pointer(t)))
		}
	}
	if startPath != "" && isFolder(startPath) {
		if p, err := windows.UTF16PtrFromString(startPath); err == nil {
			var item *comObject
			hr, _, _ := syscall.SyscallN(procSHCreateItemFromParsingName.Addr(), uintptr(unsafe.Pointer(p)), 0,
				uintptr(unsafe.Pointer(&iidIShellItem)), uintptr(unsafe.Pointer(&item)))
			if !hrFailed(hr) && item != nil {
				dlg.call(methodSetFolder, uintptr(unsafe.Pointer(item)))
				item.release()
			}
		}
	}
	return dlg, nil
}

// isFolder reports whether a cleaned path is an existing folder.
func isFolder(p string) bool {
	name, err := windows.UTF16PtrFromString(extendedPath(p))
	if err != nil {
		return false
	}
	var data windows.Win32FileAttributeData
	return windows.GetFileAttributesEx(name, windows.GetFileExInfoStandard, (*byte)(unsafe.Pointer(&data))) == nil &&
		data.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
}

// showFolderDialog shows the dialog and waits for the user. It runs on the
// shell thread.
func showFolderDialog(dlg *comObject, owner windows.HWND) (string, bool, error) {
	hr := showOwned(dlg, owner)
	if uint32(hr) == hresultCancelled {
		return "", true, nil
	}
	if hrFailed(hr) {
		return "", false, hresultError(hr)
	}
	var item *comObject
	if hr := dlg.call(methodGetResult, uintptr(unsafe.Pointer(&item))); hrFailed(hr) || item == nil {
		return "", false, fmt.Errorf("no folder: %w", hresultError(hr))
	}
	defer item.release()
	var name *uint16
	if hr := item.call(methodGetDisplayName, sigdnFileSysPath, uintptr(unsafe.Pointer(&name))); hrFailed(hr) || name == nil {
		return "", false, fmt.Errorf("the folder has no path: %w", hresultError(hr))
	}
	defer windows.CoTaskMemFree(unsafe.Pointer(name))
	return windows.UTF16PtrToString(name), false, nil
}

// showOwned shows the dialog owned by the foreground window, so it opens in
// front of it. Without a usable foreground window (none, or the taskbar or
// desktop, which the dialog would lock while open), a tiny window of the
// helper's own owns the dialog and is brought to the front first.
func showOwned(dlg *comObject, owner windows.HWND) uintptr {
	if usableOwner(owner) {
		hr := dlg.call(methodShow, uintptr(owner))
		if !hrFailed(hr) || uint32(hr) == hresultCancelled {
			return hr
		}
		// The window went away or can't own the dialog: try our own.
	}
	w, err := createOwnerWindow()
	if err != nil {
		return dlg.call(methodShow, 0)
	}
	defer syscall.SyscallN(procDestroyWindow.Addr(), uintptr(w))
	bringToFront(w)
	return dlg.call(methodShow, uintptr(w))
}

func usableOwner(h windows.HWND) bool {
	if h == 0 {
		return false
	}
	if r, _, _ := syscall.SyscallN(procIsWindow.Addr(), uintptr(h)); r == 0 {
		return false
	}
	if r, _, _ := syscall.SyscallN(procIsWindowVisible.Addr(), uintptr(h)); r == 0 {
		return false
	}
	switch windowClass(h) {
	case "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW":
		return false
	}
	return true
}

func windowClass(h windows.HWND) string {
	buf := make([]uint16, 256)
	n, _, _ := syscall.SyscallN(procGetClassNameW.Addr(), uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf[:n])
}

// wndClassEx is WNDCLASSEXW.
type wndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   windows.Handle
	icon       windows.Handle
	cursor     windows.Handle
	background windows.Handle
	menuName   *uint16
	className  *uint16
	iconSm     windows.Handle
}

const ownerClassName = "DiskAtlasHelperDialogOwner"

var registerOwnerClass = sync.OnceValue(func() error {
	var instance windows.Handle
	if err := windows.GetModuleHandleEx(0, nil, &instance); err != nil {
		return err
	}
	name, _ := windows.UTF16PtrFromString(ownerClassName)
	wc := wndClassEx{wndProc: procDefWindowProcW.Addr(), instance: instance, className: name}
	wc.size = uint32(unsafe.Sizeof(wc))
	if r, _, e := syscall.SyscallN(procRegisterClassExW.Addr(), uintptr(unsafe.Pointer(&wc))); r == 0 {
		return errnoErr(e)
	}
	return nil
})

// createOwnerWindow makes an empty popup in the middle of the main screen:
// it has no size and no taskbar button, and the dialog centers on it.
func createOwnerWindow() (windows.HWND, error) {
	if err := registerOwnerClass(); err != nil {
		return 0, err
	}
	const wsPopup, wsExToolWindow, smCXScreen, smCYScreen = 0x80000000, 0x80, 0, 1
	cx, _, _ := syscall.SyscallN(procGetSystemMetrics.Addr(), smCXScreen)
	cy, _, _ := syscall.SyscallN(procGetSystemMetrics.Addr(), smCYScreen)
	class, _ := windows.UTF16PtrFromString(ownerClassName)
	title, _ := windows.UTF16PtrFromString("DiskAtlas Helper")
	var instance windows.Handle
	windows.GetModuleHandleEx(0, nil, &instance)
	h, _, e := syscall.SyscallN(procCreateWindowExW.Addr(), wsExToolWindow, uintptr(unsafe.Pointer(class)),
		uintptr(unsafe.Pointer(title)), wsPopup, cx/2, cy/2, 0, 0, 0, 0, uintptr(instance), 0)
	if h == 0 {
		return 0, errnoErr(e)
	}
	return windows.HWND(h), nil
}

// bringToFront makes the helper's owner window the foreground window, so the
// dialog it owns opens in front. Windows only lets the foreground thread
// change the foreground, so the shell thread briefly shares its input with
// the current foreground window's thread (AttachThreadInput). With no
// foreground window at all, SetForegroundWindow is allowed anyway.
func bringToFront(w windows.HWND) {
	me := windows.GetCurrentThreadId()
	if fg := windows.GetForegroundWindow(); fg != 0 {
		if tid, _ := windows.GetWindowThreadProcessId(fg, nil); tid != 0 && tid != me {
			if r, _, _ := syscall.SyscallN(procAttachThreadInput.Addr(), uintptr(me), uintptr(tid), 1); r != 0 {
				defer syscall.SyscallN(procAttachThreadInput.Addr(), uintptr(me), uintptr(tid), 0)
			}
		}
	}
	const swShow = 5
	syscall.SyscallN(procShowWindow.Addr(), uintptr(w), swShow)
	syscall.SyscallN(procSetForegroundWindow.Addr(), uintptr(w))
	syscall.SyscallN(procBringWindowToTop.Addr(), uintptr(w))
}
