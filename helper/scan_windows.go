//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// dirPath is a folder's extended-length path (\\?\C:\Users) in UTF-16,
// without a terminator. Keeping the listing's own UTF-16 names means even
// names that aren't valid Unicode can be listed in turn.
type dirPath = []uint16

func cleanPath(p string) (string, error) { return cleanWindowsPath(p) }

// extendedPath turns a cleaned path into its \\?\ form, so long paths work
// and Windows doesn't rewrite names (such as ones ending in a dot or space).
func extendedPath(p string) string {
	if strings.HasPrefix(p, `\\`) {
		return `\\?\UNC\` + p[2:]
	}
	return `\\?\` + p
}

// makeDirPath is the dirPath for a cleaned path.
func makeDirPath(p string) (dirPath, error) {
	ext, err := windows.UTF16FromString(extendedPath(p))
	if err != nil {
		return nil, errPathInvalid
	}
	return ext[:len(ext)-1], nil
}

// displayPath turns an extended-length path back into the usual form.
func displayPath(p dirPath) string {
	s := string(appendUTF16(nil, p))
	if rest, ok := strings.CutPrefix(s, `\\?\UNC\`); ok {
		return `\\` + rest
	}
	return strings.TrimPrefix(s, `\\?\`)
}

// openRoot checks that a cleaned path is a folder and describes the scan's
// root. Only its attributes are read; it isn't opened.
func openRoot(p string) (rootInfo, error) {
	dir, err := makeDirPath(p)
	if err != nil {
		return rootInfo{}, err
	}
	info := rootInfo{
		dir:     dir,
		name:    windowsRootName(p),
		kind:    kindFolder,
		cluster: clusterSize(p),
	}
	ext := append(dir[:len(dir):len(dir)], 0)
	var data windows.Win32FileAttributeData
	err = windows.GetFileAttributesEx(&ext[0], windows.GetFileExInfoStandard, (*byte)(unsafe.Pointer(&data)))
	switch {
	case err == nil:
	case isNotFound(err):
		return rootInfo{}, fmt.Errorf("%w: %s", errPathNotFound, p)
	default:
		// For example access denied: list it anyway. If that fails too, the
		// root gets the unreadable bit.
		return info, nil
	}
	if data.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return rootInfo{}, fmt.Errorf("%w: %s", errNotDirectory, p)
	}
	// The root is listed even if it is a link itself: it was asked for.
	kind, _ := classify(data.FileAttributes&^attrReparsePoint, 0)
	info.kind = kind
	info.mtime = filetimeToMs(filetime64(data.LastWriteTime))
	return info, nil
}

func isNotFound(err error) bool {
	switch err {
	case windows.ERROR_FILE_NOT_FOUND, windows.ERROR_PATH_NOT_FOUND, windows.ERROR_INVALID_NAME,
		windows.ERROR_BAD_PATHNAME, windows.ERROR_INVALID_DRIVE, windows.ERROR_NOT_READY,
		windows.ERROR_BAD_NETPATH, windows.ERROR_BAD_NET_NAME, windows.ERROR_DEV_NOT_EXIST:
		return true
	}
	return false
}

// clusterSize is the cluster size of the volume holding p, for rounding up
// sizes on disk. Mount points inside the scan aren't followed, so one volume
// is enough.
func clusterSize(p string) uint64 {
	root := volumeRoot(p)
	var volume [windows.MAX_PATH + 1]uint16
	if p16, err := windows.UTF16PtrFromString(p); err == nil {
		if windows.GetVolumePathName(p16, &volume[0], uint32(len(volume))) == nil {
			root = windows.UTF16ToString(volume[:])
		}
	}
	if spc, bps, ok := diskFreeSpace(root); ok {
		return uint64(spc) * uint64(bps)
	}
	return 4096
}

// volumeRoot is the drive or share root of a cleaned path: C:\ or \\server\share\.
func volumeRoot(p string) string {
	if strings.HasPrefix(p, `\\`) {
		parts := strings.SplitN(p[2:], `\`, 3)
		if len(parts) >= 2 {
			return `\\` + parts[0] + `\` + parts[1] + `\`
		}
		return p
	}
	return p[:2] + `\`
}

var (
	modkernel32                = windows.NewLazySystemDLL("kernel32.dll")
	procFindFirstFileExW       = modkernel32.NewProc("FindFirstFileExW")
	procFindNextFileW          = modkernel32.NewProc("FindNextFileW")
	procGetCompressedFileSizeW = modkernel32.NewProc("GetCompressedFileSizeW")
	procGetDiskFreeSpaceW      = modkernel32.NewProc("GetDiskFreeSpaceW")
)

const (
	findExInfoBasic       = 1 // FINDEX_INFO_LEVELS: no short names
	findExSearchNameMatch = 0
	findFirstExLargeFetch = 2 // larger buffers for the directory queries
)

// findData is WIN32_FIND_DATAW. (x/sys's Win32finddata is one character too
// short in FileName and is copied on every call.)
type findData struct {
	FileAttributes    uint32
	CreationTime      windows.Filetime
	LastAccessTime    windows.Filetime
	LastWriteTime     windows.Filetime
	FileSizeHigh      uint32
	FileSizeLow       uint32
	Reserved0         uint32 // the reparse tag, if FILE_ATTRIBUTE_REPARSE_POINT is set
	Reserved1         uint32
	FileName          [windows.MAX_PATH]uint16
	AlternateFileName [14]uint16
}

func (fd *findData) name() []uint16 {
	for i, c := range fd.FileName {
		if c == 0 {
			return fd.FileName[:i]
		}
	}
	return fd.FileName[:]
}

func filetime64(ft windows.Filetime) uint64 {
	return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime)
}

func findFirstFileEx(pattern *uint16, fd *findData) (windows.Handle, error) {
	r, _, e := syscall.SyscallN(procFindFirstFileExW.Addr(),
		uintptr(unsafe.Pointer(pattern)), findExInfoBasic, uintptr(unsafe.Pointer(fd)),
		findExSearchNameMatch, 0, findFirstExLargeFetch)
	h := windows.Handle(r)
	if h == windows.InvalidHandle {
		return h, errnoErr(e)
	}
	return h, nil
}

func findNextFile(h windows.Handle, fd *findData) error {
	r, _, e := syscall.SyscallN(procFindNextFileW.Addr(), uintptr(h), uintptr(unsafe.Pointer(fd)))
	if r == 0 {
		return errnoErr(e)
	}
	return nil
}

// compressedSize asks the file system for a compressed or sparse file's size
// on disk. path must end with a 0.
func compressedSize(path []uint16) (uint64, error) {
	var high uint32
	low, _, e := syscall.SyscallN(procGetCompressedFileSizeW.Addr(),
		uintptr(unsafe.Pointer(&path[0])), uintptr(unsafe.Pointer(&high)))
	if uint32(low) == 0xffffffff && e != 0 {
		return 0, e
	}
	return uint64(high)<<32 | uint64(uint32(low)), nil
}

func diskFreeSpace(root string) (sectorsPerCluster, bytesPerSector uint32, ok bool) {
	r16, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return 0, 0, false
	}
	var freeClusters, totalClusters uint32
	r, _, _ := syscall.SyscallN(procGetDiskFreeSpaceW.Addr(), uintptr(unsafe.Pointer(r16)),
		uintptr(unsafe.Pointer(&sectorsPerCluster)), uintptr(unsafe.Pointer(&bytesPerSector)),
		uintptr(unsafe.Pointer(&freeClusters)), uintptr(unsafe.Pointer(&totalClusters)))
	return sectorsPerCluster, bytesPerSector, r != 0 && sectorsPerCluster != 0 && bytesPerSector != 0
}

func errnoErr(e syscall.Errno) error {
	if e == 0 {
		return syscall.EINVAL
	}
	return e
}

// listDir lists one folder with FindFirstFileExW / FindNextFileW. Size,
// attributes, last write time and the reparse tag all come from the listing;
// no entry is opened, except compressed or sparse files for
// GetCompressedFileSizeW. Cloud placeholders are never touched beyond the
// listing, so nothing gets downloaded.
func listDir(ctx context.Context, dir dirPath, opt listOptions, b *batch) error {
	pattern := make([]uint16, 0, len(dir)+3)
	pattern = append(pattern, dir...)
	if len(dir) == 0 || dir[len(dir)-1] != '\\' {
		pattern = append(pattern, '\\')
	}
	prefix := pattern[:len(pattern):len(pattern)] // the folder with a trailing \
	pattern = append(pattern, '*', 0)

	var fd findData
	h, err := findFirstFileEx(&pattern[0], &fd)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return nil // an empty drive root has not even "." and ".."
		}
		return err
	}
	defer windows.FindClose(h)
	for i := 1; ; i++ {
		if name := fd.name(); !isDotName(name) {
			addFound(b, &fd, name, prefix, opt)
		}
		if i%256 == 0 && ctx.Err() != nil {
			return ctx.Err()
		}
		if err := findNextFile(h, &fd); err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				return nil
			}
			return err
		}
	}
}

func isDotName(name []uint16) bool {
	return len(name) == 1 && name[0] == '.' || len(name) == 2 && name[0] == '.' && name[1] == '.'
}

// addFound adds one listed entry to b. prefix is the folder's path with a
// trailing backslash.
func addFound(b *batch, fd *findData, name, prefix []uint16, opt listOptions) {
	var tag uint32
	if fd.FileAttributes&attrReparsePoint != 0 {
		tag = fd.Reserved0
	}
	kind, rule := classify(fd.FileAttributes, tag)
	size := uint64(fd.FileSizeHigh)<<32 | uint64(fd.FileSizeLow)
	if kind&(kindFolder|kindLink) != 0 {
		size = 0
	}
	var alloc uint64
	if opt.allocated {
		switch rule {
		case sizeClusters:
			alloc = roundUp(size, opt.cluster)
		case sizeCompressed:
			full := make([]uint16, 0, len(prefix)+len(name)+1)
			full = append(append(append(full, prefix...), name...), 0)
			if v, err := compressedSize(full); err == nil {
				alloc = v
			} else {
				kind |= kindUnreadable
				alloc = roundUp(size, opt.cluster)
			}
		}
	}
	b.names = appendUTF16(b.names, name)
	pos := b.add(kind, size, filetimeToMs(filetime64(fd.LastWriteTime)), alloc)
	if descend(kind) {
		p := make([]uint16, len(prefix)+len(name))
		copy(p, prefix)
		copy(p[len(prefix):], name)
		b.subdirs = append(b.subdirs, subdir{pos: pos, path: p})
	}
}
