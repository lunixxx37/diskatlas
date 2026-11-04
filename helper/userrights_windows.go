//go:build windows

package main

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Changes never run with administrator rights (docs/helper-protocol.md,
// "Security"): when the helper is elevated, recycling and deleting run on a
// thread that impersonates the user's unelevated token, so the user's normal
// rights are what counts, for the checks as well as the changes.
//
// TokenLinkedToken names that token's logon session, but Windows hands the
// linked token itself out only at the identification level to callers
// without SeTcbPrivilege, and file access under an identification-level
// token fails (ERROR_BAD_IMPERSONATION_LEVEL). So the helper duplicates the
// token of a program the user runs normally in that logon session, the
// shell (Explorer) first, and impersonates that.

var errNoUserRights = errors.New("could not drop administrator rights")

// Swapped in tests.
var (
	processElevated = splitElevated
	findUserToken   = userToken
)

// tokenElevationTypeFull: an elevated token with a linked, unelevated one.
const tokenElevationTypeFull = 2

// splitElevated reports whether the helper runs elevated while the user's
// normal rights are less: UAC split the user's token in two. With UAC off,
// or as the built-in Administrator, an elevated token has no linked token
// (TokenElevationTypeDefault): every program of the user has these rights
// anyway, so there is nothing to drop and changes run as they are.
var splitElevated = sync.OnceValue(func() bool {
	t, err := tokenDWORD(windows.GetCurrentProcessToken(), windows.TokenElevationType)
	return err == nil && t == tokenElevationTypeFull && isElevated()
})

// withUserRights runs f on the calling goroutine's OS thread. When the
// helper is elevated, the thread impersonates the user's unelevated token
// for exactly that time; if that can't be set up, f doesn't run.
func withUserRights(f func()) error {
	if !processElevated() {
		f()
		return nil
	}
	tok, err := findUserToken()
	if err != nil {
		return fmt.Errorf("%w: %v", errNoUserRights, err)
	}
	defer tok.Close()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread() // runs after RevertToSelf below
	if err := windows.SetThreadToken(nil, tok); err != nil {
		return fmt.Errorf("%w: %v", errNoUserRights, err)
	}
	defer windows.RevertToSelf()
	if err := checkUserRights(); err != nil {
		return err
	}
	f()
	return nil
}

// checkUserRights reports whether the current thread runs with the user's
// normal rights: always when the helper isn't elevated, otherwise only while
// it impersonates an unelevated token at the impersonation level.
func checkUserRights() error {
	if !processElevated() {
		return nil
	}
	thread, _ := windows.GetCurrentThread()
	var tok windows.Token
	if err := windows.OpenThreadToken(thread, windows.TOKEN_QUERY, true, &tok); err != nil {
		return fmt.Errorf("%w: the thread doesn't impersonate the user (%v)", errNoUserRights, err)
	}
	defer tok.Close()
	if tok.IsElevated() {
		return fmt.Errorf("%w: the thread's token is elevated", errNoUserRights)
	}
	if level, err := tokenDWORD(tok, windows.TokenImpersonationLevel); err != nil || level < windows.SecurityImpersonation {
		return fmt.Errorf("%w: the thread's token can't be used for access", errNoUserRights)
	}
	return nil
}

// userToken finds an impersonation token with the user's normal rights: a
// duplicate of the token of a program of the same user that runs unelevated
// in the logon session linked to the helper's elevated one.
func userToken() (windows.Token, error) {
	self := windows.GetCurrentProcessToken()
	user, err := self.GetTokenUser()
	if err != nil {
		return 0, err
	}
	linked, err := self.GetLinkedToken()
	if err != nil {
		return 0, fmt.Errorf("Windows links no unelevated token to this one: %w", err)
	}
	session, err := tokenAuthenticationID(linked)
	linked.Close()
	if err != nil {
		return 0, err
	}
	// The shell first, then any other program of the user.
	var pids []uint32
	var shell uint32
	if hwnd := windows.GetShellWindow(); hwnd != 0 {
		if _, err := windows.GetWindowThreadProcessId(hwnd, &shell); err == nil && shell != 0 {
			pids = append(pids, shell)
		}
	}
	pids = append(pids, processIDs()...)
	for _, pid := range pids {
		if tok, ok := unelevatedToken(pid, user.User.Sid, session); ok {
			return tok, nil
		}
	}
	return 0, errors.New("no program of the user runs with their normal rights in this session")
}

// unelevatedToken duplicates the token of process pid for impersonation if
// it belongs to user, runs in the logon session, and has the user's normal
// rights: not elevated, not restricted or sandboxed, medium integrity.
func unelevatedToken(pid uint32, user *windows.SID, session windows.LUID) (windows.Token, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return 0, false
	}
	defer windows.CloseHandle(h)
	var tok windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &tok); err != nil {
		return 0, false
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil || !u.User.Sid.Equals(user) || tok.IsElevated() {
		return 0, false
	}
	if id, err := tokenAuthenticationID(tok); err != nil || id != session {
		return 0, false
	}
	if restricted, _, _ := syscall.SyscallN(procIsTokenRestricted.Addr(), uintptr(tok)); restricted != 0 {
		return 0, false
	}
	if app, err := tokenDWORD(tok, tokenIsAppContainer); err != nil || app != 0 {
		return 0, false
	}
	if rid, err := integrityRID(tok); err != nil || rid != mediumIntegrityRID {
		return 0, false
	}
	var dup windows.Token
	if err := windows.DuplicateTokenEx(tok, windows.TOKEN_IMPERSONATE|windows.TOKEN_QUERY, nil,
		windows.SecurityImpersonation, windows.TokenImpersonation, &dup); err != nil {
		return 0, false
	}
	return dup, true
}

var procIsTokenRestricted = modadvapi32.NewProc("IsTokenRestricted")

const (
	mediumIntegrityRID  = 0x2000 // S-1-16-8192
	tokenIsAppContainer = 29     // TOKEN_INFORMATION_CLASS TokenIsAppContainer
)

// tokenStatistics is TOKEN_STATISTICS.
type tokenStatistics struct {
	TokenID, AuthenticationID        windows.LUID
	ExpirationTime                   int64
	TokenType, ImpersonationLevel    uint32
	DynamicCharged, DynamicAvailable uint32
	GroupCount, PrivilegeCount       uint32
	ModifiedID                       windows.LUID
}

func tokenAuthenticationID(t windows.Token) (windows.LUID, error) {
	var s tokenStatistics
	var n uint32
	err := windows.GetTokenInformation(t, windows.TokenStatistics, (*byte)(unsafe.Pointer(&s)), uint32(unsafe.Sizeof(s)), &n)
	return s.AuthenticationID, err
}

func tokenDWORD(t windows.Token, class uint32) (uint32, error) {
	var v, n uint32
	err := windows.GetTokenInformation(t, class, (*byte)(unsafe.Pointer(&v)), 4, &n)
	return v, err
}

// integrityRID is the last part of the token's integrity level SID.
func integrityRID(t windows.Token) (uint32, error) {
	buf := make([]byte, 64)
	var n uint32
	if err := windows.GetTokenInformation(t, windows.TokenIntegrityLevel, &buf[0], uint32(len(buf)), &n); err != nil {
		return 0, err
	}
	label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&buf[0]))
	sid := label.Label.Sid
	if sid == nil || sid.SubAuthorityCount() == 0 {
		return 0, errors.New("no integrity level")
	}
	return sid.SubAuthority(uint32(sid.SubAuthorityCount()) - 1), nil
}

// processIDs lists the programs running in the helper's session.
func processIDs() []uint32 {
	var mySession uint32
	if windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &mySession) != nil {
		return nil
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	var pids []uint32
	for err := windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		var s uint32
		if windows.ProcessIdToSessionId(e.ProcessID, &s) == nil && s == mySession {
			pids = append(pids, e.ProcessID)
		}
	}
	return pids
}

// asUser runs f with the user's normal rights, on the shell thread for
// recycling (SHFileOperationW needs it) or on the calling goroutine's thread.
func (windowsRecycle) asUser(shell bool, f func()) error {
	if shell {
		return theShell.run(func() error { return withUserRights(f) })
	}
	return withUserRights(f)
}

func (windowsRecycle) rightsCheck() error { return checkUserRights() }
