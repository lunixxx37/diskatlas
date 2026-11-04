//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	modshell32          = windows.NewLazySystemDLL("shell32.dll")
	procShellExecuteExW = modshell32.NewProc("ShellExecuteExW")

	modadvapi32               = windows.NewLazySystemDLL("advapi32.dll")
	procAdjustTokenPrivileges = modadvapi32.NewProc("AdjustTokenPrivileges")

	procAttachConsole = modkernel32.NewProc("AttachConsole")
)

var isElevated = sync.OnceValue(func() bool {
	return windows.GetCurrentProcessToken().IsElevated()
})

// shellExecuteInfo is SHELLEXECUTEINFOW.
type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         windows.HWND
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     windows.Handle
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    windows.Handle
	dwHotKey     uint32
	hIcon        windows.Handle // a union with hMonitor
	hProcess     windows.Handle
}

const (
	seeMaskNoCloseProcess = 0x00000040
	seeMaskNoAsync        = 0x00000100
	seeMaskFlagNoUI       = 0x00000400
)

// shellExecuteEx runs ShellExecuteExW and returns the new process's handle,
// which the caller must close. With the "runas" verb it shows the UAC prompt
// and returns only after the user has answered it; a decline is
// ERROR_CANCELLED. The prompt is parented to the foreground window (the
// browser), so Windows shows it in front instead of only flashing it in the
// taskbar.
func shellExecuteEx(verb, file, params, dir string, show int32) (windows.Handle, error) {
	info := shellExecuteInfo{
		fMask: seeMaskNoCloseProcess | seeMaskNoAsync | seeMaskFlagNoUI,
		hwnd:  windows.GetForegroundWindow(),
		nShow: show,
	}
	info.cbSize = uint32(unsafe.Sizeof(info))
	var err error
	if info.lpVerb, err = utf16PtrOrNil(verb); err != nil {
		return 0, err
	}
	if info.lpFile, err = utf16PtrOrNil(file); err != nil {
		return 0, err
	}
	if info.lpParameters, err = utf16PtrOrNil(params); err != nil {
		return 0, err
	}
	if info.lpDirectory, err = utf16PtrOrNil(dir); err != nil {
		return 0, err
	}
	err = withCOM(func() error {
		r, _, e := syscall.SyscallN(procShellExecuteExW.Addr(), uintptr(unsafe.Pointer(&info)))
		if r == 0 {
			return errnoErr(e)
		}
		return nil
	})
	return info.hProcess, err
}

func utf16PtrOrNil(s string) (*uint16, error) {
	if s == "" {
		return nil, nil
	}
	return windows.UTF16PtrFromString(s)
}

// withCOM runs f on one thread with COM initialized, as the shell's
// functions ask for.
func withCOM(f func() error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	const sFalse = syscall.Errno(1) // already initialized on this thread, still to be balanced
	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED|windows.COINIT_DISABLE_OLE1DDE); err == nil || err == sFalse {
		defer windows.CoUninitialize()
	}
	return f()
}

// restartElevated starts this program again with the "runas" verb, which
// shows the UAC prompt.
func restartElevated(args []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return elevationError(startElevated(exe, joinWindowsArgs(args), filepath.Dir(exe)))
}

var startElevated = func(exe, params, dir string) error {
	h, err := shellExecuteEx("runas", exe, params, dir, windows.SW_HIDE)
	if h != 0 {
		windows.CloseHandle(h)
	}
	return err
}

// elevationError maps the UAC prompt's decline to errElevationCancelled.
func elevationError(err error) error {
	if errors.Is(err, windows.ERROR_CANCELLED) {
		return errElevationCancelled
	}
	return err
}

// enableBackupPrivilege enables SeBackupPrivilege, which an elevated
// administrator holds but has turned off. It only grants reading.
func enableBackupPrivilege() error {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	defer token.Close()
	name, _ := windows.UTF16PtrFromString("SeBackupPrivilege")
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, name, &luid); err != nil {
		return err
	}
	privileges := windows.Tokenprivileges{PrivilegeCount: 1}
	privileges.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
	// It succeeds with ERROR_NOT_ALL_ASSIGNED if the token lacks the privilege.
	r, _, e := syscall.SyscallN(procAdjustTokenPrivileges.Addr(), uintptr(token), 0,
		uintptr(unsafe.Pointer(&privileges)), 0, 0, 0)
	if r == 0 {
		return errnoErr(e)
	}
	if e == windows.ERROR_NOT_ALL_ASSIGNED {
		return e
	}
	return nil
}

// listDrives lists the drive letters in order. Drives are asked in parallel
// and for at most a few seconds, because a disconnected network drive can
// take much longer to answer; one that hasn't answered counts as not ready.
func listDrives() []drive {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}
	var drives []drive
	for i := range 26 {
		if mask&(1<<i) != 0 {
			root := string(rune('A'+i)) + `:\`
			drives = append(drives, drive{Path: root, Type: driveType(root)})
		}
	}
	answers := make([]chan drive, len(drives))
	for i := range drives {
		answers[i] = make(chan drive, 1)
		go func() { answers[i] <- queryDrive(drives[i]) }()
	}
	deadline := time.After(3 * time.Second)
	late := false
	for i := range drives {
		if !late {
			select {
			case drives[i] = <-answers[i]:
				continue
			case <-deadline:
				late = true
			}
		}
		select {
		case drives[i] = <-answers[i]:
		default: // still waiting for this drive: not ready
		}
	}
	return drives
}

func driveType(root string) string {
	r16, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return "unknown"
	}
	switch windows.GetDriveType(r16) {
	case windows.DRIVE_REMOVABLE:
		return "removable"
	case windows.DRIVE_FIXED:
		return "fixed"
	case windows.DRIVE_REMOTE:
		return "network"
	case windows.DRIVE_CDROM:
		return "cdrom"
	case windows.DRIVE_RAMDISK:
		return "ramdisk"
	}
	return "unknown"
}

// queryDrive fills in a drive's label, file system and sizes. A drive that
// isn't ready (such as an empty card reader) keeps them empty.
func queryDrive(d drive) drive {
	r16, err := windows.UTF16PtrFromString(d.Path)
	if err != nil {
		return d
	}
	var label, fileSystem [windows.MAX_PATH + 1]uint16
	if windows.GetVolumeInformation(r16, &label[0], uint32(len(label)), nil, nil, nil, &fileSystem[0], uint32(len(fileSystem))) != nil {
		return d
	}
	d.Ready = true
	d.Label = windows.UTF16ToString(label[:])
	d.FileSystem = windows.UTF16ToString(fileSystem[:])
	var free, total, totalFree uint64
	if windows.GetDiskFreeSpaceEx(r16, &free, &total, &totalFree) == nil {
		d.TotalBytes, d.FreeBytes = total, free
	}
	if spc, bps, ok := diskFreeSpace(d.Path); ok {
		d.ClusterBytes = uint64(spc) * uint64(bps)
	}
	return d
}

// The link registration lives in HKCU\Software\Classes, so no admin rights
// are needed.
const linkKey = `Software\Classes\` + protocolScheme

// registerProtocol writes the link registration. changed reports whether it
// was missing or pointed to another command before.
func registerProtocol(command string) (changed bool, err error) {
	changed = registeredCommand() != command
	k, _, err := registry.CreateKey(registry.CURRENT_USER, linkKey, registry.SET_VALUE)
	if err != nil {
		return false, err
	}
	defer k.Close()
	if err := k.SetStringValue("", "URL:DiskAtlas Helper"); err != nil {
		return false, err
	}
	if err := k.SetStringValue("URL Protocol", ""); err != nil {
		return false, err
	}
	c, _, err := registry.CreateKey(registry.CURRENT_USER, linkKey+`\shell\open\command`, registry.SET_VALUE)
	if err != nil {
		return false, err
	}
	defer c.Close()
	if err := c.SetStringValue("", command); err != nil {
		return false, err
	}
	if changed {
		notifyAssociationsChanged()
	}
	return changed, nil
}

// registeredCommand is the command the link starts now, or "" if there is none.
func registeredCommand() string {
	c, err := registry.OpenKey(registry.CURRENT_USER, linkKey+`\shell\open\command`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer c.Close()
	command, _, err := c.GetStringValue("")
	if err != nil {
		return ""
	}
	return command
}

func unregisterProtocol() error {
	if err := deleteKeyTree(registry.CURRENT_USER, linkKey); err != nil {
		return err
	}
	notifyAssociationsChanged()
	return nil
}

var procSHChangeNotify = modshell32.NewProc("SHChangeNotify")

// notifyAssociationsChanged tells Windows and running programs that a link
// registration changed, as Windows asks registering programs to do.
func notifyAssociationsChanged() {
	const shcneAssocChanged, shcnfIDList = 0x08000000, 0
	procSHChangeNotify.Call(shcneAssocChanged, shcnfIDList, 0, 0)
}

// deleteKeyTree deletes a registry key with all its subkeys. A missing key
// is not an error.
func deleteKeyTree(root registry.Key, path string) error {
	k, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	names, err := k.ReadSubKeyNames(-1)
	k.Close()
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := deleteKeyTree(root, path+`\`+name); err != nil {
			return err
		}
	}
	if err := registry.DeleteKey(root, path); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

// openURL opens a URL in the default browser.
func openURL(u string) error {
	verb, _ := windows.UTF16PtrFromString("open")
	file, err := windows.UTF16PtrFromString(u)
	if err != nil {
		return err
	}
	return withCOM(func() error {
		return windows.ShellExecute(0, verb, file, nil, nil, windows.SW_SHOWNORMAL)
	})
}

// attachConsole lets --version and --help print, although the helper is
// built without a console: unless the output already goes somewhere (a pipe
// or a file), it writes to the console of the program that started it.
func attachConsole() {
	if h, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE); err == nil && h != 0 && h != windows.InvalidHandle {
		if t, err := windows.GetFileType(h); err == nil && t != windows.FILE_TYPE_UNKNOWN {
			return
		}
	}
	const attachParentProcess = ^uint32(0)
	if r, _, _ := syscall.SyscallN(procAttachConsole.Addr(), uintptr(attachParentProcess)); r == 0 {
		return
	}
	if f, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout, os.Stderr = f, f
	}
}
