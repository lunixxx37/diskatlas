//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procSHFileOperationW           = modshell32.NewProc("SHFileOperationW")
	procSHParseDisplayName         = modshell32.NewProc("SHParseDisplayName")
	procSHOpenFolderAndSelectItems = modshell32.NewProc("SHOpenFolderAndSelectItems")
	procGetFullPathNameW           = modkernel32.NewProc("GetFullPathNameW")
)

func platformRecycle() recycleSystem { return windowsRecycle{} }

func platformReveal() func(string) error { return revealItem }

// windowsRecycle is the real recycleSystem.
type windowsRecycle struct{}

// fileBasicInfo is FILE_BASIC_INFO, fileStandardInfo FILE_STANDARD_INFO and
// fileAttributeTagInfo FILE_ATTRIBUTE_TAG_INFO.
type fileBasicInfo struct {
	CreationTime, LastAccessTime, LastWriteTime, ChangeTime int64
	FileAttributes                                          uint32
	_                                                       uint32 // C pads to 40 bytes, also on 32-bit Windows
}

type fileStandardInfo struct {
	AllocationSize, EndOfFile int64
	NumberOfLinks             uint32
	DeletePending, Directory  byte
}

type fileAttributeTagInfo struct {
	FileAttributes, ReparseTag uint32
}

const (
	fileNameNormalized = 0x0 // GetFinalPathNameByHandleW: FILE_NAME_NORMALIZED
	volumeNameDOS      = 0x0 //                            VOLUME_NAME_DOS
)

// inspect opens the item with FILE_READ_ATTRIBUTES only (no data access, so
// cloud files aren't downloaded) and FILE_FLAG_OPEN_REPARSE_POINT (so a link
// is opened itself, not its target), and reads its type, size, last write
// time, reparse tag and final path from the handle.
func (windowsRecycle) inspect(p string) (itemInfo, error) {
	name, err := windows.UTF16PtrFromString(extendedPath(p))
	if err != nil {
		return itemInfo{}, errPathInvalid
	}
	h, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		if isNotFound(err) {
			return itemInfo{}, errPathNotFound
		}
		return itemInfo{}, err
	}
	defer windows.CloseHandle(h)

	var basic fileBasicInfo
	var std fileStandardInfo
	var tag fileAttributeTagInfo
	for _, q := range []struct {
		class uint32
		buf   unsafe.Pointer
		size  uintptr
	}{
		{windows.FileBasicInfo, unsafe.Pointer(&basic), unsafe.Sizeof(basic)},
		{windows.FileStandardInfo, unsafe.Pointer(&std), unsafe.Sizeof(std)},
		{windows.FileAttributeTagInfo, unsafe.Pointer(&tag), unsafe.Sizeof(tag)},
	} {
		if err := windows.GetFileInformationByHandleEx(h, q.class, (*byte)(q.buf), uint32(q.size)); err != nil {
			return itemInfo{}, err
		}
	}
	info := itemInfo{
		isDir: basic.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0,
		mtime: filetimeToMs(uint64(basic.LastWriteTime)),
		link:  tag.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 && tag.ReparseTag&reparseNameSurrogate != 0,
	}
	if !info.isDir {
		info.size = uint64(max(std.EndOfFile, 0))
	}
	if final, err := finalPath(h); err == nil {
		info.finalPath = final
	}
	return info, nil
}

// finalPath is GetFinalPathNameByHandleW as a cleaned, usual path.
func finalPath(h windows.Handle) (string, error) {
	buf := make([]uint16, windows.MAX_PATH+1)
	for {
		n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), fileNameNormalized|volumeNameDOS)
		if err != nil {
			return "", err
		}
		if int(n) < len(buf) {
			return cleanWindowsPath(windows.UTF16ToString(buf[:n]))
		}
		buf = make([]uint16, n+1)
	}
}

// locations asks Windows for the known folders and lists the user profiles.
func (windowsRecycle) locations() (knownLocations, error) {
	known := func(id *windows.KNOWNFOLDERID) string {
		p, err := windows.KnownFolderPath(id, windows.KF_FLAG_DONT_VERIFY)
		if err != nil {
			return ""
		}
		return p
	}
	var loc knownLocations
	loc.windows = known(windows.FOLDERID_Windows)
	if loc.windows == "" {
		loc.windows = os.Getenv("SystemRoot")
	}
	if loc.windows == "" {
		return loc, errors.New("the Windows folder is unknown")
	}
	loc.programFiles = []string{
		known(windows.FOLDERID_ProgramFiles), known(windows.FOLDERID_ProgramFilesX86), known(windows.FOLDERID_ProgramFilesX64),
		os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramW6432"),
	}
	loc.programData = known(windows.FOLDERID_ProgramData)
	loc.userProfiles = known(windows.FOLDERID_UserProfiles)
	if loc.userProfiles != "" {
		// Every folder in the users folder is a profile, including links
		// such as "All Users".
		entries, _ := os.ReadDir(loc.userProfiles)
		for _, e := range entries {
			if !e.Type().IsRegular() {
				loc.profiles = append(loc.profiles, filepath.Join(loc.userProfiles, e.Name()))
			}
		}
	}
	loc.profiles = append(loc.profiles, known(windows.FOLDERID_Profile))
	for _, id := range []*windows.KNOWNFOLDERID{
		windows.FOLDERID_Desktop, windows.FOLDERID_Documents, windows.FOLDERID_Downloads,
		windows.FOLDERID_Pictures, windows.FOLDERID_Music, windows.FOLDERID_Videos,
		windows.FOLDERID_RoamingAppData, windows.FOLDERID_LocalAppData,
	} {
		loc.userFolders = append(loc.userFolders, known(id))
	}
	loc.exe, _ = os.Executable()
	return loc, nil
}

// fixedDrive reports whether the drive is a local fixed one. Network paths
// have no Recycle Bin.
func (windowsRecycle) fixedDrive(p string) bool {
	if len(p) < 3 || p[1] != ':' || p[2] != '\\' {
		return false
	}
	root, err := windows.UTF16PtrFromString(p[:3])
	return err == nil && windows.GetDriveType(root) == windows.DRIVE_FIXED
}

// win32Path is GetFullPathNameW: the path after Win32's rewriting, which the
// shell applies (it drops trailing dots and spaces, and turns device names
// into \\.\ paths).
func (windowsRecycle) win32Path(p string) (string, error) {
	p16, err := windows.UTF16FromString(p)
	if err != nil {
		return "", err
	}
	buf := make([]uint16, windows.MAX_PATH+1)
	for {
		n, _, e := syscall.SyscallN(procGetFullPathNameW.Addr(), uintptr(unsafe.Pointer(&p16[0])),
			uintptr(len(buf)), uintptr(unsafe.Pointer(&buf[0])), 0)
		if n == 0 {
			return "", errnoErr(e)
		}
		if int(n) < len(buf) {
			return windows.UTF16ToString(buf[:n]), nil
		}
		buf = make([]uint16, n)
	}
}

// SHFileOperationW settings: delete to the Recycle Bin, without dialogs,
// except that Windows asks before it would delete permanently instead.
const (
	foDelete           = 0x0003
	fofSilent          = 0x0004
	fofNoConfirmation  = 0x0010
	fofAllowUndo       = 0x0040
	fofNoErrorUI       = 0x0400
	fofWantNukeWarning = 0x4000
)

// recycle moves one item to the Recycle Bin with SHFileOperationW, on the
// shell thread. The dialog that asks before a permanent delete is owned by
// the foreground window (the browser), so it shows in front of it.
func (windowsRecycle) recycle(p string) error {
	from, err := windows.UTF16FromString(p)
	if err != nil {
		return err
	}
	from = append(from, 0) // the list of paths ends with an empty one
	return theShell.run(func() error {
		op := shFileOpStruct{
			hwnd:   uintptr(windows.GetForegroundWindow()),
			wFunc:  foDelete,
			pFrom:  &from[0],
			fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI | fofWantNukeWarning,
		}
		r, _, _ := syscall.SyscallN(procSHFileOperationW.Addr(), uintptr(unsafe.Pointer(&op)))
		switch {
		case op.aborted() || r == uintptr(windows.ERROR_CANCELLED) || r == deOpCancelled:
			return errDeleteDeclined
		case r != 0:
			return shFileOpError(r)
		}
		return nil
	})
}

const deOpCancelled = 0x75

// shFileOpError describes an SHFileOperationW result. Besides Win32 error
// codes it returns its own DE_ codes.
func shFileOpError(r uintptr) error {
	codes := map[uintptr]string{
		0x71:  "the source and destination are the same file",
		0x74:  "a drive root can't be moved",
		0x78:  "access denied",
		0x79:  "the path is too deep",
		0x7c:  "the path is not valid",
		0x81:  "the name is too long",
		0x82:  "the item is on a CD or DVD",
		0x86:  "the item is on read-only media",
		0x88:  "the item is on a write-protected disk",
		0xb7:  "the path is longer than the shell allows",
		0x402: "an unknown error, usually an unusual path",
	}
	if msg, ok := codes[r]; ok {
		return fmt.Errorf("%s (0x%x)", msg, r)
	}
	if r < 0x71 || r > 0xb7 {
		return fmt.Errorf("%w (0x%x)", syscall.Errno(r), r)
	}
	return fmt.Errorf("error 0x%x", r)
}

// revealItem opens File Explorer with the item selected (a folder's parent
// opens with the folder selected). Nothing is executed or opened with an app.
func revealItem(p string) error {
	name, err := windows.UTF16PtrFromString(extendedPath(p))
	if err != nil {
		return errPathInvalid
	}
	var data windows.Win32FileAttributeData
	if err := windows.GetFileAttributesEx(name, windows.GetFileExInfoStandard, (*byte)(unsafe.Pointer(&data))); err != nil && isNotFound(err) {
		return fmt.Errorf("%w: %s", errPathNotFound, p)
	}
	path16, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return errPathInvalid
	}
	return theShell.run(func() error {
		var pidl unsafe.Pointer
		hr, _, _ := syscall.SyscallN(procSHParseDisplayName.Addr(), uintptr(unsafe.Pointer(path16)), 0,
			uintptr(unsafe.Pointer(&pidl)), 0, 0)
		if err := hresultError(hr); err != nil {
			return fmt.Errorf("the shell can't find the item: %w", err)
		}
		defer windows.CoTaskMemFree(pidl)
		hr, _, _ = syscall.SyscallN(procSHOpenFolderAndSelectItems.Addr(), uintptr(pidl), 0, 0, 0)
		if err := hresultError(hr); err != nil {
			return fmt.Errorf("could not open File Explorer: %w", err)
		}
		return nil
	})
}

// hresultError turns a failed HRESULT into an error; a Win32 code inside it
// (0x8007xxxx) becomes that error.
func hresultError(hr uintptr) error {
	code := uint32(hr)
	if int32(code) >= 0 {
		return nil
	}
	if code&0xffff0000 == 0x80070000 {
		errno := syscall.Errno(code & 0xffff)
		if isNotFound(errno) {
			return errPathNotFound
		}
		return errno
	}
	return fmt.Errorf("HRESULT 0x%08x", code)
}
