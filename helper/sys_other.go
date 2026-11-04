//go:build !windows

package main

import (
	"os/exec"
	"runtime"
)

// Simple stand-ins for the Windows functions, so the helper builds and its
// tests run on other systems: no elevation, no link registration, and "/" as
// the only drive.

func isElevated() bool { return false }

func restartElevated([]string) error { return errElevationUnsupported }

func enableBackupPrivilege() error { return nil }

func listDrives() []drive {
	return []drive{{Path: "/", Type: "fixed", Ready: true}}
}

func registerProtocol(string) error { return nil }

func unregisterProtocol() error { return nil }

func openURL(u string) error {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	return exec.Command(name, u).Start()
}

func attachConsole() {}
