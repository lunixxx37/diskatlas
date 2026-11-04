package main

import (
	"bytes"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// The log is cut back to its last logKeep bytes when it would exceed logMax.
const (
	logMax  = 1 << 20
	logKeep = 256 << 10
)

// openLog opens %LOCALAPPDATA%\DiskAtlas\helper.log (os.UserCacheDir is
// %LOCALAPPDATA% on Windows). The log only ever holds the start, the stop,
// errors and the scanned root paths, never names found by a scan. Logging
// never fails the helper: without a log file it logs nowhere.
func openLog() (*log.Logger, func()) {
	nowhere := log.New(io.Discard, "", 0)
	dir, err := os.UserCacheDir()
	if err != nil {
		return nowhere, func() {}
	}
	dir = filepath.Join(dir, "DiskAtlas")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nowhere, func() {}
	}
	lf := &logFile{path: filepath.Join(dir, "helper.log"), max: logMax, keep: logKeep}
	prefix := "[" + strconv.Itoa(os.Getpid()) + "] "
	return log.New(lf, prefix, log.LstdFlags|log.Lmsgprefix), lf.close
}

// logFile appends to a file and cuts it back when it grows too large.
type logFile struct {
	path      string
	max, keep int64

	mu   sync.Mutex
	f    *os.File
	size int64
}

func (l *logFile) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil && l.open() != nil {
		return len(p), nil
	}
	if l.size+int64(len(p)) > l.max {
		l.f.Close()
		l.f = nil
		cutBack(l.path, l.keep)
		if l.open() != nil {
			return len(p), nil
		}
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}

func (l *logFile) open() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	l.size = 0
	if fi, err := f.Stat(); err == nil {
		l.size = fi.Size()
	}
	l.f = f
	return nil
}

func (l *logFile) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
}

// cutBack keeps only the last keep bytes of the file at path, starting at a
// whole line.
func cutBack(path string, keep int64) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if int64(len(data)) <= keep {
		return nil
	}
	data = data[int64(len(data))-keep:]
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		data = data[i+1:]
	}
	return os.WriteFile(path, data, 0o644)
}
