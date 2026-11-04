package main

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf16"
)

// POST /v1/recycle and POST /v1/delete (docs/helper-protocol.md): the only
// cases in which the helper changes files. Each item passes the same checks
// in order, and the first one that fails sets its status. Only then does it
// go to the Recycle Bin, or get deleted permanently.
const (
	statusInvalid     = "invalid"     // not an absolute, clean, non-device path
	statusNotFound    = "not_found"   // gone since the scan
	statusChanged     = "changed"     // another type, size or last write time
	statusProtected   = "protected"   // a protected location
	statusUnsupported = "unsupported" // a drive without the action, too long for the shell, or reached through a link
	statusOK          = "ok"          // every check passed (dry run)
	statusRecycled    = "recycled"
	statusDeleted     = "deleted"
	statusPartial     = "partial" // a folder of which some entries couldn't be deleted
	statusFailed      = "failed"
)

const (
	maxRecycleItems  = 100
	mtimeToleranceMs = 2000
	shellPathLimit   = 259 // MAX_PATH without the terminator
	confirmPermanent = "permanent"
)

// errDeleteDeclined: Windows would have deleted the item permanently (for
// example because it is too big for the Recycle Bin), asked, and the user
// said no.
var errDeleteDeclined = errors.New("not recycled: Windows would have deleted it permanently, for example because it is too big for the Recycle Bin, and that was declined")

// recycleItem is one entry of the request: the values from the scan result.
type recycleItem struct {
	Path  string   `json:"path"`
	IsDir *bool    `json:"isDir"`
	Size  *float64 `json:"size"`
	Mtime *float64 `json:"mtime"`
}

type recycleResult struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

// deleteResult is one result of /v1/delete. The counts are 0 in a dry run.
type deleteResult struct {
	Path           string `json:"path"`
	Status         string `json:"status"`
	DeletedFiles   int    `json:"deletedFiles"`
	DeletedFolders int    `json:"deletedFolders"`
	FailedEntries  int    `json:"failedEntries"`
	Message        string `json:"message"`
}

// itemInfo is what the helper finds at an item's path now.
type itemInfo struct {
	isDir     bool
	size      uint64
	mtime     float64 // ms since 1970-01-01 UTC
	link      bool    // the item itself is a name surrogate (symbolic link, junction, mount point)
	finalPath string  // where the path really leads, cleaned; "" if unknown
}

// deleteCounts is what a permanent deletion did.
type deleteCounts struct {
	files, folders, failed int    // deleted files and links to files; deleted folders and folder links; entries left in place
	firstPath              string // the first entry that couldn't be deleted
	firstErr               error
}

// fail counts an entry that couldn't be deleted.
func (c *deleteCounts) fail(path string, err error) {
	c.failed++
	if c.firstErr == nil {
		c.firstPath, c.firstErr = path, err
	}
}

// cleanupSystem is what recycling and deleting need from Windows. The real
// one is in recycle_windows.go and delete_windows.go; tests use a fake.
type cleanupSystem interface {
	// inspect opens the item for its attributes only, without data access,
	// so cloud files aren't downloaded. A missing item is errPathNotFound.
	inspect(path string) (itemInfo, error)
	// locations lists the folders the protection rules are built from.
	locations() (knownLocations, error)
	// driveType is the type of the drive path is on, as /v1/drives names
	// it: "fixed", "removable", "network", … Network paths are "network".
	driveType(path string) string
	// win32Path is the path as the shell will read it (GetFullPathNameW).
	// It differs for names Win32 rewrites, such as one ending in a dot.
	win32Path(path string) (string, error)
	// recycle moves path to the Recycle Bin, never deleting it permanently
	// without asking. A refusal by the user is errDeleteDeclined.
	recycle(path string) error
	// deleteItem deletes a file, or a folder depth first, permanently. Links
	// inside a folder are removed as links; their targets are never entered.
	// Entries that can't be deleted are left in place and counted.
	deleteItem(path string, isDir bool) deleteCounts
	// asUser runs f with the user's normal rights: when the helper is
	// elevated, on a thread that impersonates the user's unelevated token
	// (the shell thread if shell is set). It fails if that can't be set up.
	asUser(shell bool, f func()) error
	// rightsCheck reports whether the current thread runs with the user's
	// normal rights; it is called before each item.
	rightsCheck() error
}

// msgNoUserRights is the message of every item refused because the
// helper couldn't drop its administrator rights.
const msgNoUserRights = "could not drop administrator rights"

// cleanupRules are the few checks in which recycling and deleting differ.
type cleanupRules struct {
	verb     string          // "recycled" or "deleted", for messages
	drives   map[string]bool // allowed drive types
	driveMsg string
	maxPath  int // in UTF-16 characters; 0: no limit
}

var (
	recycleRules = cleanupRules{
		verb:     "recycled",
		drives:   map[string]bool{"fixed": true},
		driveMsg: "only items on a local fixed drive can be recycled; other drives and network shares have no Recycle Bin",
		maxPath:  shellPathLimit, // SHFileOperationW
	}
	deleteRules = cleanupRules{
		verb:     "deleted",
		drives:   map[string]bool{"fixed": true, "removable": true},
		driveMsg: "only items on a local fixed or removable drive can be deleted; network shares and other drives are not supported",
		// No limit: the deletion uses \\?\ paths, not the shell.
	}
)

// runRecycle checks every item and, unless dryRun, recycles those that pass,
// one at a time, so a failure doesn't affect the others.
func runRecycle(sys cleanupSystem, items []recycleItem, dryRun bool) ([]recycleResult, error) {
	loc, err := sys.locations()
	if err != nil {
		return nil, fmt.Errorf("could not work out the protected locations: %w", err)
	}
	prot := newProtection(loc)
	results := make([]recycleResult, len(items))
	for i, it := range items {
		if sys.rightsCheck() != nil {
			results[i] = recycleResult{Path: it.Path, Status: statusFailed, Message: msgNoUserRights}
			continue
		}
		status, msg := checkItem(sys, prot, it, recycleRules)
		if status == statusOK && !dryRun {
			status, msg = recycleNow(sys, it.Path)
		}
		results[i] = recycleResult{Path: it.Path, Status: status, Message: msg}
	}
	return results, nil
}

// runDelete checks every item like runRecycle and, unless dryRun, deletes
// those that pass permanently, one at a time.
func runDelete(sys cleanupSystem, items []recycleItem, dryRun bool) ([]deleteResult, error) {
	loc, err := sys.locations()
	if err != nil {
		return nil, fmt.Errorf("could not work out the protected locations: %w", err)
	}
	prot := newProtection(loc)
	results := make([]deleteResult, len(items))
	for i, it := range items {
		if sys.rightsCheck() != nil {
			results[i] = deleteResult{Path: it.Path, Status: statusFailed, Message: msgNoUserRights}
			continue
		}
		status, msg := checkItem(sys, prot, it, deleteRules)
		if status == statusOK && !dryRun {
			results[i] = deleteNow(sys, it.Path, *it.IsDir)
			continue
		}
		results[i] = deleteResult{Path: it.Path, Status: status, Message: msg}
	}
	return results, nil
}

// recycleAsUser and deleteAsUser run a request with the user's normal
// rights. If those can't be set up, every item is refused as failed and
// dropErr says why (for the log); err is any other error.
func recycleAsUser(sys cleanupSystem, items []recycleItem, dryRun bool) (results []recycleResult, err, dropErr error) {
	if dropErr = sys.asUser(true, func() { results, err = runRecycle(sys, items, dryRun) }); dropErr != nil {
		results = make([]recycleResult, len(items))
		for i, it := range items {
			results[i] = recycleResult{Path: it.Path, Status: statusFailed, Message: msgNoUserRights}
		}
		return results, nil, dropErr
	}
	return results, err, nil
}

func deleteAsUser(sys cleanupSystem, items []recycleItem, dryRun bool) (results []deleteResult, err, dropErr error) {
	if dropErr = sys.asUser(false, func() { results, err = runDelete(sys, items, dryRun) }); dropErr != nil {
		results = make([]deleteResult, len(items))
		for i, it := range items {
			results[i] = deleteResult{Path: it.Path, Status: statusFailed, Message: msgNoUserRights}
		}
		return results, nil, dropErr
	}
	return results, err, nil
}

// deleteNow deletes an item that passed the checks and checks afterwards
// whether it is really gone.
func deleteNow(sys cleanupSystem, p string, isDir bool) deleteResult {
	c := sys.deleteItem(p, isDir)
	r := deleteResult{Path: p, DeletedFiles: c.files, DeletedFolders: c.folders, FailedEntries: c.failed}
	_, err := sys.inspect(p)
	gone := errors.Is(err, errPathNotFound)
	switch {
	case gone:
		r.Status = statusDeleted
	case isDir && c.files+c.folders > 0:
		r.Status = statusPartial // some of what was inside is gone
	default:
		r.Status = statusFailed
		if !isDir {
			r.DeletedFiles = 0 // the file is still there
		}
	}
	if !gone {
		switch {
		case c.failed == 1:
			r.Message = fmt.Sprintf("1 entry could not be deleted: %s: %s", c.firstPath, deleteErrorText(c.firstErr))
		case c.failed > 1:
			r.Message = fmt.Sprintf("%d entries could not be deleted, first: %s: %s", c.failed, c.firstPath, deleteErrorText(c.firstErr))
		default:
			r.Message = "Windows reported success, but the item is still there"
		}
	}
	return r
}

// errPathChanged: during the deletion a folder was no longer what the checks
// saw, for example because it had been replaced by a junction.
var errPathChanged = errors.New("the path changed while it was being deleted")

// deleteErrorText is a short English description of a deletion error.
func deleteErrorText(err error) string {
	if err == nil {
		return "unknown error"
	}
	if errors.Is(err, errPathChanged) {
		return err.Error()
	}
	return friendlyError(err)
}

// checkItem runs the checks in the documented order: invalid, not_found,
// changed, protected, unsupported.
func checkItem(sys cleanupSystem, prot *protection, it recycleItem, rules cleanupRules) (string, string) {
	p, err := cleanWindowsPath(it.Path)
	switch {
	case it.Path == "":
		return statusInvalid, "the path is missing"
	case err != nil:
		return statusInvalid, err.Error()
	case p != it.Path:
		return statusInvalid, "the path is not in its clean form, " + p
	}

	info, err := sys.inspect(p)
	if errors.Is(err, errPathNotFound) {
		return statusNotFound, "the item no longer exists"
	}
	if err != nil {
		// Some items can't even be opened for their attributes, such as
		// pagefile.sys; they are protected anyway.
		if why, ok := prot.check(p); ok {
			return statusProtected, why
		}
		return statusFailed, "could not check the item: " + err.Error()
	}

	if info.isDir != *it.IsDir {
		if info.isDir {
			return statusChanged, "it is a folder now, not a file"
		}
		return statusChanged, "it is a file now, not a folder"
	}
	if !info.isDir {
		if float64(info.size) != *it.Size {
			return statusChanged, fmt.Sprintf("its size changed since the scan, from %.0f to %d bytes", *it.Size, info.size)
		}
		if math.Abs(info.mtime-*it.Mtime) > mtimeToleranceMs {
			return statusChanged, "it was modified after the scan"
		}
	}

	if why, ok := prot.check(p); ok {
		return statusProtected, why
	}
	if info.finalPath != "" {
		if why, ok := prot.check(info.finalPath); ok {
			return statusProtected, why + " (the path leads to " + info.finalPath + ")"
		}
	}

	switch {
	case !rules.drives[sys.driveType(p)]:
		return statusUnsupported, rules.driveMsg
	case rules.maxPath > 0 && len(utf16.Encode([]rune(p))) > rules.maxPath:
		return statusUnsupported, fmt.Sprintf("the path is longer than the %d characters the Windows shell can handle", rules.maxPath)
	case info.link:
		return statusUnsupported, "it is a link (a symbolic link, junction or mount point); only items reached without links can be " + rules.verb
	case info.finalPath == "":
		return statusUnsupported, "could not find out where the path leads"
	case !samePath(info.finalPath, p):
		return statusUnsupported, "the path leads elsewhere, to " + info.finalPath + ", for example through a junction or a short name; only items reached without links can be " + rules.verb
	}
	if w, err := sys.win32Path(p); err != nil || w != p {
		return statusUnsupported, "Windows would read this name differently (for example because it ends with a dot or a space, or is a device name such as NUL)"
	}
	return statusOK, ""
}

// recycleNow moves an item that passed the checks to the Recycle Bin.
func recycleNow(sys cleanupSystem, p string) (string, string) {
	if err := sys.recycle(p); err != nil {
		if errors.Is(err, errDeleteDeclined) {
			return statusFailed, err.Error()
		}
		return statusFailed, "could not move it to the Recycle Bin: " + err.Error()
	}
	if _, err := sys.inspect(p); !errors.Is(err, errPathNotFound) {
		return statusFailed, "Windows reported success, but the item is still there"
	}
	return statusRecycled, ""
}

// pathKey is a cleaned Windows path in upper case, to compare paths the way
// NTFS does (it compares upper-cased names).
func pathKey(p string) (string, bool) {
	c, err := cleanWindowsPath(p)
	if err != nil {
		return "", false
	}
	return strings.ToUpper(c), true
}

func samePath(a, b string) bool {
	ka, okA := pathKey(a)
	kb, okB := pathKey(b)
	return okA && okB && ka == kb
}

// splitVolume splits a cleaned path into its root (C:\ or \\server\share\)
// and the rest, without a leading separator.
func splitVolume(c string) (root, rest string) {
	if len(c) >= 3 && c[1] == ':' && c[2] == '\\' {
		return c[:3], c[3:]
	}
	if strings.HasPrefix(c, `\\`) {
		server := strings.IndexByte(c[2:], '\\')
		if server < 0 {
			return c, ""
		}
		share := strings.IndexByte(c[3+server:], '\\')
		if share < 0 {
			return c, ""
		}
		end := 3 + server + share + 1
		return c[:end], c[end:]
	}
	return "", c
}

// knownLocations are the folders the protection rules name, as Windows
// reports them on this PC.
type knownLocations struct {
	windows      string   // %SystemRoot%
	programFiles []string // %ProgramFiles%, %ProgramFiles(x86)% (duplicates and blanks are fine)
	programData  string   // %ProgramData%
	userProfiles string   // the users folder, C:\Users
	profiles     []string // the folders in it, and the current user's profile
	userFolders  []string // the current user's own Desktop, Documents, … (they may be redirected)
	exe          string   // the helper's own exe
}

// The folders of every user profile that are protected themselves (their
// contents are not).
var profileSubfolders = []string{
	`AppData`, `AppData\Local`, `AppData\Roaming`,
	`Desktop`, `Documents`, `Downloads`, `Pictures`, `Music`, `Videos`,
}

// Files in a drive root that Windows itself uses.
var rootSystemFiles = map[string]bool{
	"PAGEFILE.SYS": true, "HIBERFIL.SYS": true, "SWAPFILE.SYS": true, "DUMPSTACK.LOG.TMP": true,
}

// protection decides whether a path is in a protected location.
type protection struct {
	trees []protectedPath          // protected with everything inside
	exact map[string]protectedPath // protected themselves, by pathKey
}

type protectedPath struct {
	key, why string
}

func newProtection(loc knownLocations) *protection {
	p := &protection{exact: make(map[string]protectedPath)}
	tree := func(dir string) {
		if c, err := cleanWindowsPath(dir); err == nil {
			p.trees = append(p.trees, protectedPath{strings.ToUpper(c), c + " and everything in it is protected"})
		}
	}
	exact := func(dir, why string) {
		if key, ok := pathKey(dir); ok {
			if _, dup := p.exact[key]; !dup {
				p.exact[key] = protectedPath{key, why}
			}
		}
	}
	tree(loc.windows)
	for _, dir := range loc.programFiles {
		tree(dir)
	}

	const contentsAllowed = ", but not what is inside it"
	if exe, err := cleanWindowsPath(loc.exe); err == nil {
		exact(exe, "this is the DiskAtlas Helper itself")
		// The helper's folder, and the folders above it up to the drive root
		// (protected anyway): recycling one of them would move the helper.
		root, _ := splitVolume(exe)
		for dir := exe; ; {
			i := strings.LastIndexByte(dir, '\\')
			if i < len(root) {
				break
			}
			dir = dir[:i]
			exact(dir, "this folder holds the DiskAtlas Helper")
		}
	}
	exact(loc.programData, "the ProgramData folder itself is protected"+contentsAllowed)
	exact(loc.userProfiles, "the users folder itself is protected"+contentsAllowed)
	for _, prof := range loc.profiles {
		if prof == "" {
			continue
		}
		exact(prof, "a user profile folder itself is protected"+contentsAllowed)
		for _, sub := range profileSubfolders {
			exact(prof+`\`+sub, "this folder of a user profile is protected itself"+contentsAllowed)
		}
	}
	for _, dir := range loc.userFolders {
		exact(dir, "this folder of a user profile is protected itself"+contentsAllowed)
	}
	return p
}

// check reports whether a path is protected, and why.
func (p *protection) check(raw string) (string, bool) {
	key, ok := pathKey(raw)
	if !ok {
		return "the path is not valid", true // never let an unclear path through
	}
	_, rest := splitVolume(key)
	if rest == "" {
		return "a drive root is protected", true
	}
	first, _, inside := strings.Cut(rest, `\`)
	if first == "$RECYCLE.BIN" || first == "SYSTEM VOLUME INFORMATION" {
		return "the Recycle Bin and System Volume Information are protected, with everything in them", true
	}
	if !inside && rootSystemFiles[first] {
		return "this file in the drive root belongs to Windows", true
	}
	for _, t := range p.trees {
		if key == t.key || strings.HasPrefix(key, t.key+`\`) {
			return t.why, true
		}
	}
	if e, ok := p.exact[key]; ok {
		return e.why, true
	}
	return "", false
}
