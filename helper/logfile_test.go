package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLogCutBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "helper.log")
	lf := &logFile{path: path, max: 1000, keep: 300}
	logger := log.New(lf, "[1] ", log.Lmsgprefix)
	for i := range 100 {
		logger.Printf("line %03d", i)
	}
	lf.close()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > 1000 {
		t.Errorf("the log grew to %d bytes", len(data))
	}
	text := string(data)
	if !strings.HasPrefix(text, "[1] line ") || !strings.HasSuffix(text, "[1] line 099\n") {
		t.Errorf("the log doesn't keep whole, recent lines:\n%s", text)
	}

	// A log that is already too large is cut back on the next start.
	big := strings.Repeat("old line\n", 200) // 1800 bytes
	if err := os.WriteFile(path, []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	lf = &logFile{path: path, max: 1000, keep: 300}
	fmt.Fprintln(lf, "start")
	lf.close()
	data, _ = os.ReadFile(path)
	if len(data) > 310 || !strings.HasSuffix(string(data), "old line\nstart\n") || !strings.HasPrefix(string(data), "old line\n") {
		t.Errorf("after the start: %d bytes: %q", len(data), data)
	}
}
