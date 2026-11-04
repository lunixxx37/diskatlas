//go:build windows

package main

import (
	"errors"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// deleteItem deletes p permanently (POST /v1/delete): a file, or a folder
// depth first. Everything works on \\?\ paths, so long paths are fine.
//
// Safety against links: a folder is only entered after it was opened with
// FILE_FLAG_OPEN_REPARSE_POINT and that handle showed a real folder, not a
// link. The handle stays open (shared for reading and writing, not for
// deleting) while the folder is listed and emptied, and Windows refuses to
// rename or replace a folder, or any folder above it, while such a handle is
// open. So no path below the item can be redirected by a junction swapped in
// during the deletion. Links found inside are removed as links.
func (windowsRecycle) deleteItem(p string, isDir bool) deleteCounts {
	var c deleteCounts
	ext, err := makeDirPath(p)
	if err != nil {
		c.fail(p, err)
		return c
	}
	if isDir {
		deleteFolder(ext, p, &c)
		return c
	}
	// Hold the folder the file is in, so its path can't change until the
	// file is gone.
	parentExt, parent := parentDir(ext), windowsParent(p)
	pin, tag, err := pinFolder(parentExt)
	if err != nil {
		c.fail(p, err)
		return c
	}
	defer windows.CloseHandle(pin)
	// The folder must be a real one (opened without following a reparse
	// point, a link would show its own path) and where the checks saw it.
	if tag.FileAttributes&attrDirectory == 0 || tag.FileAttributes&attrReparsePoint != 0 && tag.ReparseTag&reparseNameSurrogate != 0 {
		c.fail(p, errPathChanged)
		return c
	}
	if final, err := finalPath(pin); err != nil || !samePath(final, parent) {
		c.fail(p, errPathChanged)
		return c
	}
	deleteFile(ext, attrUnknown, &c)
	return c
}

// attrUnknown asks deleteFile to look at the read-only attribute itself.
const attrUnknown = ^uint32(0)

// deleteFolder empties and removes one folder. expected is the path the
// checks approved, for the item itself; "" for folders found inside it.
func deleteFolder(path []uint16, expected string, c *deleteCounts) bool {
	pin, tag, err := pinFolder(path)
	if err != nil {
		if isNotFound(err) {
			return true
		}
		c.fail(displayPath(path), err)
		return false
	}
	isLink := tag.FileAttributes&attrReparsePoint != 0 && tag.ReparseTag&reparseNameSurrogate != 0
	if isLink || tag.FileAttributes&attrDirectory == 0 {
		windows.CloseHandle(pin)
		if expected != "" {
			// The item itself is no longer the folder the checks saw.
			c.fail(displayPath(path), errPathChanged)
			return false
		}
		// It became a link or a file since it was listed: remove that, and
		// never enter it.
		if isLink && tag.FileAttributes&attrDirectory != 0 {
			return removeDir(path, tag.FileAttributes, c)
		}
		return deleteFile(path, tag.FileAttributes, c)
	}
	if expected != "" {
		if final, err := finalPath(pin); err != nil || !samePath(final, expected) {
			windows.CloseHandle(pin)
			c.fail(displayPath(path), errPathChanged)
			return false
		}
	}

	entries, listErr := listEntries(path)
	remaining := false
	for _, e := range entries {
		child := joinPath(path, e.name)
		var gone bool
		switch {
		case e.link && e.attrs&attrDirectory != 0:
			gone = removeDir(child, e.attrs, c) // a folder link: RemoveDirectoryW removes the link only
		case e.link:
			gone = deleteFile(child, e.attrs, c) // a file link: DeleteFileW removes the link only
		case e.attrs&attrDirectory != 0:
			gone = deleteFolder(child, "", c)
		default:
			gone = deleteFile(child, e.attrs, c)
		}
		if !gone {
			remaining = true
		}
	}
	if listErr != nil {
		c.fail(displayPath(path), listErr)
		remaining = true
	}
	windows.CloseHandle(pin)
	if remaining {
		// Not empty: it stays, and only the entries inside count as failed.
		return false
	}
	return removeDir(path, tag.FileAttributes, c)
}

// pinFolder opens a folder without following a reparse point, with an
// access that takes part in sharing, so that while the handle is open the
// folder and the folders above it can't be renamed, replaced or deleted.
func pinFolder(path []uint16) (windows.Handle, fileAttributeTagInfo, error) {
	var tag fileAttributeTagInfo
	p0 := append(path[:len(path):len(path)], 0)
	h, err := windows.CreateFile(&p0[0], windows.FILE_LIST_DIRECTORY|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, tag, err
	}
	if err := windows.GetFileInformationByHandleEx(h, windows.FileAttributeTagInfo, (*byte)(unsafe.Pointer(&tag)), uint32(unsafe.Sizeof(tag))); err != nil {
		windows.CloseHandle(h)
		return 0, tag, err
	}
	return h, tag, nil
}

// dirEntry is one entry of a folder listing.
type dirEntry struct {
	name  []uint16
	attrs uint32
	link  bool // a name surrogate: symbolic link, junction or mount point
}

// listEntries lists a folder completely with FindFirstFileExW, as the scan
// does, before anything in it is deleted.
func listEntries(dir []uint16) ([]dirEntry, error) {
	pattern := append(append(dir[:len(dir):len(dir)], '\\', '*'), 0)
	if n := len(dir); n > 0 && dir[n-1] == '\\' {
		pattern = append(append(dir[:len(dir):len(dir)], '*'), 0)
	}
	var fd findData
	h, err := findFirstFileEx(&pattern[0], &fd)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return nil, nil
		}
		return nil, err
	}
	defer windows.FindClose(h)
	var entries []dirEntry
	for {
		if name := fd.name(); !isDotName(name) {
			e := dirEntry{name: append([]uint16(nil), name...), attrs: fd.FileAttributes}
			e.link = fd.FileAttributes&attrReparsePoint != 0 && fd.Reserved0&reparseNameSurrogate != 0
			entries = append(entries, e)
		}
		if err := findNextFile(h, &fd); err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				return entries, nil
			}
			return entries, err
		}
	}
}

// deleteFile clears a file's (or a file link's) read-only attribute if it
// is set, then deletes it with DeleteFileW. Cloud placeholders aren't opened
// for their data, so nothing is downloaded.
func deleteFile(path []uint16, attrs uint32, c *deleteCounts) bool {
	p0 := append(path[:len(path):len(path)], 0)
	if attrs == attrUnknown || attrs&windows.FILE_ATTRIBUTE_READONLY != 0 {
		if err := clearReadOnly(p0); err != nil && !isNotFound(err) {
			c.fail(displayPath(path), err)
			return false
		}
	}
	err := windows.DeleteFile(&p0[0])
	switch {
	case err == nil:
		c.files++
		return true
	case isNotFound(err):
		return true // gone already
	}
	c.fail(displayPath(path), err)
	return false
}

// removeDir removes an empty folder, or a folder link (without touching its
// target), with RemoveDirectoryW. Windows refuses read-only folders, which
// customized folders often are, so the attribute is cleared first.
func removeDir(path []uint16, attrs uint32, c *deleteCounts) bool {
	p0 := append(path[:len(path):len(path)], 0)
	if attrs&windows.FILE_ATTRIBUTE_READONLY != 0 {
		if err := clearReadOnly(p0); err != nil && !isNotFound(err) {
			c.fail(displayPath(path), err)
			return false
		}
	}
	err := windows.RemoveDirectory(&p0[0])
	switch {
	case err == nil:
		c.folders++
		return true
	case isNotFound(err):
		return true
	}
	c.fail(displayPath(path), err)
	return false
}

// The attributes SetFileInformationByHandle may set; others (such as the
// directory bit) are left out of the new value.
const settableAttrs = 0x1 | 0x2 | 0x4 | 0x20 | 0x100 | 0x1000 | 0x2000 | 0x80000 | 0x100000

// clearReadOnly clears FILE_ATTRIBUTE_READONLY through a handle on the entry
// itself (FILE_FLAG_OPEN_REPARSE_POINT), so a link is changed, never its
// target. path ends with a 0.
func clearReadOnly(path []uint16) error {
	h, err := windows.CreateFile(&path[0], windows.FILE_READ_ATTRIBUTES|windows.FILE_WRITE_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	var basic fileBasicInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return err
	}
	if basic.FileAttributes&windows.FILE_ATTRIBUTE_READONLY == 0 {
		return nil
	}
	set := fileBasicInfo{FileAttributes: basic.FileAttributes & settableAttrs &^ windows.FILE_ATTRIBUTE_READONLY}
	if set.FileAttributes == 0 {
		set.FileAttributes = windows.FILE_ATTRIBUTE_NORMAL // 0 would mean "unchanged"
	}
	// The zero times mean "unchanged" too.
	return windows.SetFileInformationByHandle(h, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&set)), uint32(unsafe.Sizeof(set)))
}

// joinPath is dir\name.
func joinPath(dir, name []uint16) []uint16 {
	p := make([]uint16, 0, len(dir)+1+len(name))
	p = append(p, dir...)
	if len(dir) == 0 || dir[len(dir)-1] != '\\' {
		p = append(p, '\\')
	}
	return append(p, name...)
}

// parentDir is the folder an extended path is in, with the backslash kept
// for a drive root (\\?\C:\), which would otherwise name the volume device.
func parentDir(p []uint16) []uint16 {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '\\' {
			if d := displayPath(p[:i]); len(d) == 2 && d[1] == ':' {
				return p[:i+1]
			}
			return p[:i]
		}
	}
	return p
}

// windowsParent is the folder a cleaned path is in: C:\ for C:\file.txt.
func windowsParent(p string) string {
	root, rest := splitVolume(p)
	for i := len(rest) - 1; i >= 0; i-- {
		if rest[i] == '\\' {
			return root + rest[:i]
		}
	}
	return root
}

// friendlyError describes common deletion errors in short English.
func friendlyError(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case windows.ERROR_SHARING_VIOLATION, windows.ERROR_LOCK_VIOLATION:
			return "in use by another process"
		case windows.ERROR_ACCESS_DENIED:
			return "access denied"
		case windows.ERROR_DIR_NOT_EMPTY:
			return "the folder is not empty"
		case windows.ERROR_WRITE_PROTECT:
			return "the drive is write-protected"
		}
	}
	return err.Error()
}
