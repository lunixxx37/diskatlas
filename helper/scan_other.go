//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// dirPath is a folder's path. Other systems are only supported so the code
// builds and its tests run everywhere; the helper is meant for Windows.
type dirPath = string

func cleanPath(p string) (string, error) { return cleanUnixPath(p) }

// makeDirPath is the dirPath for a cleaned path.
func makeDirPath(p string) (dirPath, error) { return p, nil }

func displayPath(p dirPath) string { return p }

func openRoot(p string) (rootInfo, error) {
	info := rootInfo{dir: p, name: unixRootName(p), kind: kindFolder, cluster: 4096}
	fi, err := os.Stat(p)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ENOTDIR):
		return rootInfo{}, fmt.Errorf("%w: %s", errPathNotFound, p)
	default:
		return info, nil // listing it will mark it unreadable
	}
	if !fi.IsDir() {
		return rootInfo{}, fmt.Errorf("%w: %s", errNotDirectory, p)
	}
	info.mtime = float64(fi.ModTime().UnixMilli())
	return info, nil
}

// listDir lists one folder with os.ReadDir. Symbolic links are listed but
// not followed. Sizes on disk are the sizes rounded up to opt.cluster.
func listDir(ctx context.Context, dir dirPath, opt listOptions, b *batch) error {
	entries, err := os.ReadDir(dir)
	for i, e := range entries {
		if i%256 == 255 && ctx.Err() != nil {
			return ctx.Err()
		}
		var kind uint8
		var size uint64
		var mtime float64
		fi, infoErr := e.Info()
		switch {
		case infoErr != nil: // gone since the listing
			kind = kindUnreadable
			if e.IsDir() {
				kind |= kindFolder
			}
		case e.Type()&fs.ModeSymlink != 0:
			kind = kindLink
		case e.IsDir():
			kind = kindFolder
		default:
			size = uint64(max(fi.Size(), 0))
		}
		if fi != nil {
			mtime = float64(fi.ModTime().UnixMilli())
		}
		var alloc uint64
		if opt.allocated {
			alloc = roundUp(size, opt.cluster)
		}
		b.names = append(b.names, strings.ToValidUTF8(e.Name(), "�")...)
		pos := b.add(kind, size, mtime, alloc)
		if descend(kind) && infoErr == nil {
			b.subdirs = append(b.subdirs, subdir{pos: pos, path: filepath.Join(dir, e.Name())})
		}
	}
	return err
}
