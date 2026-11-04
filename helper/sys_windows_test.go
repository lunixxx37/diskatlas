//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func TestShellExecuteInfoLayout(t *testing.T) {
	want := map[string]uintptr{"amd64": 112, "arm64": 112, "386": 60, "arm": 60}[runtime.GOARCH]
	if size := unsafe.Sizeof(shellExecuteInfo{}); size != want {
		t.Errorf("shellExecuteInfo is %d bytes, SHELLEXECUTEINFOW is %d", size, want)
	}
}

// TestShellExecuteEx runs the same call as the elevation, with the "open"
// verb instead of "runas" so no UAC prompt appears: a hidden cmd.exe that
// exits with code 7. It checks the structure, the parameters and the process
// handle.
func TestShellExecuteEx(t *testing.T) {
	cmd := filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	h, err := shellExecuteEx("open", cmd, "/c exit 7", os.TempDir(), windows.SW_HIDE)
	if err != nil {
		t.Fatal(err)
	}
	if h == 0 {
		t.Fatal("no process handle")
	}
	defer windows.CloseHandle(h)
	if ev, err := windows.WaitForSingleObject(h, 10_000); err != nil || ev != windows.WAIT_OBJECT_0 {
		t.Fatalf("wait: %d, %v", ev, err)
	}
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil || code != 7 {
		t.Errorf("exit code %d, %v; want 7", code, err)
	}

	if _, err := shellExecuteEx("open", filepath.Join(t.TempDir(), "missing.exe"), "", "", windows.SW_HIDE); err == nil {
		t.Error("no error for a missing program")
	}
}

func TestRestartElevated(t *testing.T) {
	saved := startElevated
	t.Cleanup(func() { startElevated = saved })
	exe, _ := os.Executable()
	args := []string{"--serve", "--takeover", "--port", "41417", "--idle", "10m0s", "--origin", "http://localhost:3000"}

	for _, c := range []struct {
		result error
		want   error
	}{
		{nil, nil},
		{windows.ERROR_CANCELLED, errElevationCancelled}, // the user said no
		{windows.ERROR_ACCESS_DENIED, windows.ERROR_ACCESS_DENIED},
	} {
		var gotExe, gotParams, gotDir string
		startElevated = func(exe, params, dir string) error {
			gotExe, gotParams, gotDir = exe, params, dir
			return c.result
		}
		if err := restartElevated(args); !errors.Is(err, c.want) && err != c.want {
			t.Errorf("start returns %v: restartElevated = %v, want %v", c.result, err, c.want)
		}
		if gotExe != exe || gotDir != filepath.Dir(exe) || gotParams != joinWindowsArgs(args) {
			t.Errorf("started %q %q in %q", gotExe, gotParams, gotDir)
		}
	}
	// The command line survives Windows' own splitting.
	split, err := windows.DecomposeCommandLine("x " + joinWindowsArgs([]string{`C:\dir with space\`, `a"b`, "", "plain"}))
	if err != nil || len(split) != 5 || split[1] != `C:\dir with space\` || split[2] != `a"b` || split[3] != "" || split[4] != "plain" {
		t.Errorf("DecomposeCommandLine = %q, %v", split, err)
	}
}

func TestEnableBackupPrivilege(t *testing.T) {
	err := enableBackupPrivilege()
	if isElevated() {
		if err != nil {
			t.Errorf("elevated: %v", err)
		}
		return
	}
	// Without administrator rights the token doesn't hold the privilege.
	if !errors.Is(err, windows.ERROR_NOT_ALL_ASSIGNED) {
		t.Errorf("not elevated: %v, want ERROR_NOT_ALL_ASSIGNED", err)
	}
}

func TestDeleteKeyTree(t *testing.T) {
	// A scratch key under HKCU\Software, not the link itself.
	path := `Software\DiskAtlas-Helper-Test-` + filepath.Base(filepath.Dir(t.TempDir()))
	for _, sub := range []string{`shell\open\command`, `DefaultIcon`} {
		k, _, err := registry.CreateKey(registry.CURRENT_USER, path+`\`+sub, registry.SET_VALUE)
		if err != nil {
			t.Fatal(err)
		}
		k.SetStringValue("", "x")
		k.Close()
	}
	t.Cleanup(func() { deleteKeyTree(registry.CURRENT_USER, path) })
	if err := deleteKeyTree(registry.CURRENT_USER, path); err != nil {
		t.Fatal(err)
	}
	if k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE); err == nil {
		k.Close()
		t.Fatal("the key still exists")
	}
	if err := deleteKeyTree(registry.CURRENT_USER, path); err != nil {
		t.Errorf("deleting a missing key: %v", err)
	}
}

func TestAttachConsoleKeepsPipes(t *testing.T) {
	// Under go test, stdout is a pipe or a console: it must stay as it is.
	before := os.Stdout
	attachConsole()
	if os.Stdout != before {
		t.Error("attachConsole replaced a working stdout")
	}
}
