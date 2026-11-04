//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"golang.org/x/sys/windows"
)

// threadImpersonates reports whether the current OS thread has a token.
func threadImpersonates() bool {
	thread, _ := windows.GetCurrentThread()
	var tok windows.Token
	if err := windows.OpenThreadToken(thread, windows.TOKEN_QUERY, true, &tok); err != nil {
		return false
	}
	tok.Close()
	return true
}

func swapUserRights(t *testing.T, elevated bool, find func() (windows.Token, error)) {
	t.Helper()
	savedElevated, savedFind := processElevated, findUserToken
	t.Cleanup(func() { processElevated, findUserToken = savedElevated, savedFind })
	processElevated = func() bool { return elevated }
	if find != nil {
		findUserToken = find
	}
}

func TestUserRightsNotElevated(t *testing.T) {
	if splitElevated() {
		t.Skip("the test runs elevated")
	}
	// Not elevated: nothing to drop, and no impersonation at all.
	ran := false
	if err := withUserRights(func() { ran = !threadImpersonates() && checkUserRights() == nil }); err != nil || !ran {
		t.Errorf("withUserRights: %v, ran without impersonating: %t", err, ran)
	}
}

func TestUserRightsRefusedWithoutLinkedToken(t *testing.T) {
	swapUserRights(t, true, func() (windows.Token, error) {
		return 0, errors.New("Windows links no unelevated token to this one")
	})
	ran := false
	if err := withUserRights(func() { ran = true }); !errors.Is(err, errNoUserRights) || ran {
		t.Errorf("withUserRights: %v, ran %t", err, ran)
	}
	// Without impersonation, the check before each item fails.
	runtime.LockOSThread()
	err := checkUserRights()
	runtime.UnlockOSThread()
	if !errors.Is(err, errNoUserRights) {
		t.Errorf("checkUserRights on a plain thread: %v", err)
	}
	// Recycle and delete refuse every item and change nothing.
	file := filepath.Join(t.TempDir(), "keep.txt")
	writeTestFile(t, file, 1)
	it := statItem(t, file)
	rec, err1, drop1 := recycleAsUser(windowsRecycle{}, []recycleItem{it}, false)
	del, err2, drop2 := deleteAsUser(windowsRecycle{}, []recycleItem{it}, false)
	if err1 != nil || err2 != nil || drop1 == nil || drop2 == nil || rec[0].Status != statusFailed || rec[0].Message != msgNoUserRights ||
		del[0].Status != statusFailed || del[0].Message != msgNoUserRights {
		t.Errorf("recycle %+v (%v, %v), delete %+v (%v, %v)", rec[0], err1, drop1, del[0], err2, drop2)
	}
	if !exists(file) {
		t.Error("the file was changed")
	}
}

// shellUserToken duplicates the token of the shell, if it runs unelevated in
// this process's logon session (as it does without UAC elevation).
func shellUserToken(t *testing.T) func() (windows.Token, error) {
	t.Helper()
	self := windows.GetCurrentProcessToken()
	user, err := self.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	session, err := tokenAuthenticationID(self)
	if err != nil {
		t.Fatal(err)
	}
	var shell uint32
	if hwnd := windows.GetShellWindow(); hwnd != 0 {
		windows.GetWindowThreadProcessId(hwnd, &shell)
	}
	tok, ok := unelevatedToken(shell, user.User.Sid, session)
	if !ok {
		t.Skip("no unelevated shell in this logon session (no desktop, or UAC is off)")
	}
	tok.Close()
	return func() (windows.Token, error) {
		if tok, ok := unelevatedToken(shell, user.User.Sid, session); ok {
			return tok, nil
		}
		return 0, errors.New("the shell is gone")
	}
}

func TestUserRightsImpersonation(t *testing.T) {
	// The real mechanics, without UAC: pretend to be elevated and impersonate
	// the shell's unelevated token, which here has this process's rights.
	swapUserRights(t, true, shellUserToken(t))
	runtime.LockOSThread() // to look at the same thread afterwards
	defer runtime.UnlockOSThread()

	dir := longTempDir(t)
	file := filepath.Join(dir, "made-as-user.txt")
	var inside error
	err := withUserRights(func() {
		if !threadImpersonates() {
			inside = errors.New("no impersonation")
			return
		}
		if inside = checkUserRights(); inside == nil {
			inside = os.WriteFile(file, []byte("x"), 0o644)
		}
	})
	if err != nil || inside != nil {
		t.Fatalf("withUserRights: %v, inside: %v", err, inside)
	}
	if threadImpersonates() {
		t.Fatal("the impersonation wasn't reverted")
	}
	// Reverted after a panic too.
	func() {
		defer func() { recover() }()
		withUserRights(func() { panic("boom") })
	}()
	if threadImpersonates() {
		t.Fatal("the impersonation wasn't reverted after a panic")
	}

	// The real pipelines under the impersonation: checks on the shell thread
	// for recycling (dry run), checks and deletion for deleting.
	it := statItem(t, file)
	rec, err1, drop1 := recycleAsUser(windowsRecycle{}, []recycleItem{it}, true)
	if err1 != nil || drop1 != nil || rec[0].Status != statusOK {
		t.Errorf("recycle check as the user: %+v, %v, %v", rec[0], err1, drop1)
	}
	del, err2, drop2 := deleteAsUser(windowsRecycle{}, []recycleItem{it}, false)
	if err2 != nil || drop2 != nil || del[0].Status != statusDeleted || exists(file) {
		t.Errorf("delete as the user: %+v, %v, %v", del[0], err2, drop2)
	}
	if theShell.run(func() error {
		if threadImpersonates() {
			return errors.New("the shell thread still impersonates")
		}
		return nil
	}) != nil {
		t.Error("the shell thread kept the user's token")
	}
}
