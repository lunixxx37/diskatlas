package main

import (
	"errors"
	"flag"
	"reflect"
	"testing"
	"time"
)

func TestParseArgs(t *testing.T) {
	opts, err := parseArgs(nil)
	if err != nil || opts.idle != 10*time.Minute || opts.launchURL != "" || opts.port != 0 || opts.dev || opts.serve {
		t.Fatalf("defaults: %+v, %v", opts, err)
	}

	// How Windows starts the helper from a link registered with --dev.
	opts, err = parseArgs([]string{"--dev", "--origin", "http://localhost:3000", "diskatlas-helper://start"})
	if err != nil || !opts.dev || opts.launchURL != "diskatlas-helper://start" || !reflect.DeepEqual(opts.origins, []string{"http://localhost:3000"}) {
		t.Fatalf("link launch: %+v, %v", opts, err)
	}

	// Nothing after the link is read as a flag, whatever a web page put in it.
	opts, err = parseArgs([]string{"DiskAtlas-Helper://start/", "--uninstall", "--origin", "https://evil.example"})
	if err != nil || opts.uninstall || opts.origins != nil || opts.launchURL == "" || opts.ignored != 3 {
		t.Fatalf("flags after the link: %+v, %v", opts, err)
	}

	opts, err = parseArgs([]string{"--serve", "--no-open", "--port", "41500", "--idle", "90"})
	if err != nil || !opts.serve || !opts.noOpen || opts.port != 41500 || opts.idle != 90*time.Second {
		t.Fatalf("serve: %+v, %v", opts, err)
	}
	for in, want := range map[string]time.Duration{"30m": 30 * time.Minute, "1h30m": 90 * time.Minute, "0": 0, "45s": 45 * time.Second} {
		if opts, err := parseArgs([]string{"--idle", in}); err != nil || opts.idle != want {
			t.Errorf("--idle %s = %v, %v; want %v", in, opts.idle, err, want)
		}
	}

	if _, err := parseArgs([]string{"-h"}); !errors.Is(err, flag.ErrHelp) {
		t.Errorf("-h: %v", err)
	}
	for _, args := range [][]string{
		{"--bogus"},
		{"--idle", "-5"},
		{"--idle", "soon"},
		{"--port", "70000"},
		{"--port", "x"},
		{"--takeover"}, // needs --port
		{"--origin", "ftp://example.com"},
		{"--origin", "https://example.com/app"},
		{"--origin", "example.com"},
	} {
		if _, err := parseArgs(args); err == nil {
			t.Errorf("parseArgs(%q) succeeded", args)
		}
	}
}

func TestNormalizeOrigin(t *testing.T) {
	for in, want := range map[string]string{
		"https://lunixxx37.github.io":  "https://lunixxx37.github.io",
		"https://lunixxx37.github.io/": "https://lunixxx37.github.io",
		"HTTP://LocalHost:3000":        "http://localhost:3000",
		"https://example.com:443":      "https://example.com",
		"http://example.com:80/":       "http://example.com",
		"http://example.com:8080":      "http://example.com:8080",
		"http://[::1]:5173":            "http://[::1]:5173",
		"https://example.com:4430":     "https://example.com:4430",
	} {
		if got, err := normalizeOrigin(in); err != nil || got != want {
			t.Errorf("normalizeOrigin(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "null", "example.com", "file:///C:/", "https://user@example.com", "https://example.com/x", "https://example.com?x", "https://example.com#x"} {
		if got, err := normalizeOrigin(in); err == nil {
			t.Errorf("normalizeOrigin(%q) = %q, want an error", in, got)
		}
	}
}

func TestQuoteWindowsArg(t *testing.T) {
	for in, want := range map[string]string{
		``:                   `""`,
		`plain`:              `plain`,
		`--origin`:           `--origin`,
		`C:\Tools\x.exe`:     `C:\Tools\x.exe`,
		`C:\Program Files\x`: `"C:\Program Files\x"`,
		`C:\dir with space\`: `"C:\dir with space\\"`,
		`say "hi"`:           `"say \"hi\""`,
		`a\"b`:               `"a\\\"b"`,
		"tab\there":          "\"tab\there\"",
	} {
		if got := quoteWindowsArg(in); got != want {
			t.Errorf("quoteWindowsArg(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestProtocolCommand(t *testing.T) {
	exe := `C:\Users\Ann\Downloads\DiskAtlas-Helper.exe`
	if got, want := protocolCommand(exe, options{}), `"`+exe+`" "%1"`; got != want {
		t.Errorf("plain: %s, want %s", got, want)
	}
	opts := options{dev: true, origins: []string{"http://localhost:3000", "https://example.com"}}
	want := `"` + exe + `" --dev --origin http://localhost:3000 --origin https://example.com "%1"`
	if got := protocolCommand(exe, opts); got != want {
		t.Errorf("dev: %s, want %s", got, want)
	}
}

func TestElevatedArgs(t *testing.T) {
	opts := options{dev: true, origins: []string{"http://localhost:3000"}, idle: 30 * time.Minute, launchURL: "diskatlas-helper://start"}
	args := elevatedArgs(opts, 41418)
	want := []string{"--serve", "--takeover", "--port", "41418", "--idle", "30m0s", "--dev", "--origin", "http://localhost:3000"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("elevatedArgs = %q, want %q", args, want)
	}
	// The elevated instance parses them back into the same settings.
	got, err := parseArgs(args)
	if err != nil || !got.serve || !got.takeover || got.port != 41418 || got.idle != opts.idle || !got.dev ||
		!reflect.DeepEqual(got.origins, opts.origins) || got.launchURL != "" {
		t.Fatalf("parsed back: %+v, %v", got, err)
	}
	if line := joinWindowsArgs(args); line != "--serve --takeover --port 41418 --idle 30m0s --dev --origin http://localhost:3000" {
		t.Errorf("command line %s", line)
	}
}
