package main

import (
	"errors"
	"fmt"
	"path"
	"strings"
)

// Errors for the path of a new scan. The API turns them into 400, 404 and 409.
var (
	errPathRelative = errors.New("the path is not absolute")
	errPathInvalid  = errors.New("the path is not valid")
	errPathNotFound = errors.New("the path does not exist")
	errNotDirectory = errors.New("the path is a file, not a folder")
)

// cleanWindowsPath returns the canonical form of an absolute Windows path:
// backslashes only, an upper-case drive letter, no "." or ".." elements and no
// repeated or trailing separators. A root keeps its backslash ("C:\",
// "\\server\share\"), and "C:" means "C:\". Network paths (\\server\share)
// and the \\?\ and \\.\ prefixes for drive and network paths are accepted.
// Relative paths, including "C:Users" (relative to the drive's current
// folder) and "\Users" (relative to the current drive), are refused.
//
// It is plain string handling, so it is tested on every system.
func cleanWindowsPath(p string) (string, error) {
	p = strings.ReplaceAll(p, "/", `\`)
	if strings.HasPrefix(p, `\\?\`) || strings.HasPrefix(p, `\\.\`) {
		rest := p[4:]
		switch {
		case len(rest) >= 4 && strings.EqualFold(rest[:4], `UNC\`):
			p = `\\` + rest[4:]
		case len(rest) >= 2 && isDriveLetter(rest[0]) && rest[1] == ':':
			p = rest
		default:
			return "", fmt.Errorf("%w: only drive and network paths are supported", errPathInvalid)
		}
	}

	var volume, rest string
	switch {
	case len(p) >= 2 && isDriveLetter(p[0]) && p[1] == ':':
		volume, rest = strings.ToUpper(p[:1])+":", p[2:]
		if rest == "" {
			rest = `\`
		}
		if rest[0] != '\\' {
			return "", errPathRelative
		}
	case strings.HasPrefix(p, `\\`):
		server, after, _ := strings.Cut(p[2:], `\`)
		share, after, _ := strings.Cut(after, `\`)
		if !validComponent(server) || !validComponent(share) {
			return "", fmt.Errorf("%w: a network path needs a server and a share", errPathInvalid)
		}
		volume, rest = `\\`+server+`\`+share, `\`+after
	default:
		return "", errPathRelative
	}
	if strings.ContainsFunc(rest, invalidPathChar) {
		return "", errPathInvalid
	}
	cleaned := path.Clean(strings.ReplaceAll(rest, `\`, "/"))
	return volume + strings.ReplaceAll(cleaned, "/", `\`), nil
}

// windowsRootName is the name of a scan's root entry: the cleaned path
// without a trailing separator, so "C:" for "C:\".
func windowsRootName(p string) string {
	return strings.TrimSuffix(p, `\`)
}

// cleanUnixPath is cleanWindowsPath for other systems.
func cleanUnixPath(p string) (string, error) {
	if !strings.HasPrefix(p, "/") {
		return "", errPathRelative
	}
	if strings.IndexByte(p, 0) >= 0 {
		return "", errPathInvalid
	}
	return path.Clean(p), nil
}

// unixRootName is windowsRootName for other systems. The file system root
// keeps its "/", because the name would be empty otherwise.
func unixRootName(p string) string {
	if p != "/" {
		return strings.TrimSuffix(p, "/")
	}
	return p
}

func isDriveLetter(c byte) bool {
	return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z'
}

// invalidPathChar reports characters that Windows doesn't allow in names:
// control characters and <>:"|?* (the last two would also turn the path into
// a search pattern).
func invalidPathChar(r rune) bool {
	return r < 0x20 || strings.ContainsRune(`<>:"|?*`, r)
}

func validComponent(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.ContainsFunc(s, invalidPathChar)
}
