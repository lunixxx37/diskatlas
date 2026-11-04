package main

import (
	"errors"
	"testing"
)

func TestCleanWindowsPath(t *testing.T) {
	ok := []struct{ in, want string }{
		{`C:`, `C:\`},
		{`c:`, `C:\`},
		{`C:\`, `C:\`},
		{`C:/`, `C:\`},
		{`d:/Users/Ann/`, `D:\Users\Ann`},
		{`C:\Users\\Ann\\`, `C:\Users\Ann`},
		{`C:\Users\.\Ann\..\Bob`, `C:\Users\Bob`},
		{`C:\..\..`, `C:\`},
		{`C:\Program Files (x86)\Steam`, `C:\Program Files (x86)\Steam`},
		{`C:\Ä日😀`, `C:\Ä日😀`},
		{`\\server\share`, `\\server\share\`},
		{`\\server\share\`, `\\server\share\`},
		{`\\server\share\dir\..\other\`, `\\server\share\other`},
		{`//server/share/dir`, `\\server\share\dir`},
		{`\\?\C:\Users`, `C:\Users`},
		{`\\?\c:`, `C:\`},
		{`\\.\C:\Users`, `C:\Users`},
		{`\\?\UNC\server\share\dir`, `\\server\share\dir`},
		{`//?/C:/Users`, `C:\Users`},
	}
	for _, c := range ok {
		got, err := cleanWindowsPath(c.in)
		if err != nil || got != c.want {
			t.Errorf("cleanWindowsPath(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}

	bad := []struct {
		in   string
		want error
	}{
		{``, errPathRelative},
		{`Users`, errPathRelative},
		{`Users\Ann`, errPathRelative},
		{`.\Users`, errPathRelative},
		{`..`, errPathRelative},
		{`C:Users`, errPathRelative}, // relative to the drive's current folder
		{`\Users`, errPathRelative},  // relative to the current drive
		{`/Users`, errPathRelative},
		{`\\server`, errPathInvalid},
		{`\\server\`, errPathInvalid},
		{`\\\share`, errPathInvalid},
		{`\\?\Volume{12345678-1234-1234-1234-123456789abc}\`, errPathInvalid},
		{`\\.\pipe\x`, errPathInvalid},
		{`C:\Users\*`, errPathInvalid},
		{`C:\Users\?`, errPathInvalid},
		{`C:\Users\a:b`, errPathInvalid},
		{`C:\Users\a|b`, errPathInvalid},
		{"C:\\Users\x00", errPathInvalid},
		{"C:\\Users\nAnn", errPathInvalid},
	}
	for _, c := range bad {
		if got, err := cleanWindowsPath(c.in); !errors.Is(err, c.want) {
			t.Errorf("cleanWindowsPath(%q) = %q, %v; want error %v", c.in, got, err, c.want)
		}
	}
}

func TestRootNames(t *testing.T) {
	win := map[string]string{
		`C:\`:              `C:`,
		`C:\Users\Ann`:     `C:\Users\Ann`,
		`\\server\share\`:  `\\server\share`,
		`\\server\share\x`: `\\server\share\x`,
	}
	for in, want := range win {
		if got := windowsRootName(in); got != want {
			t.Errorf("windowsRootName(%q) = %q, want %q", in, got, want)
		}
	}
	unix := map[string]string{"/": "/", "/home/ann": "/home/ann"}
	for in, want := range unix {
		if got := unixRootName(in); got != want {
			t.Errorf("unixRootName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCleanUnixPath(t *testing.T) {
	for in, want := range map[string]string{"/": "/", "/home//ann/": "/home/ann", "/a/./b/../c": "/a/c", "/..": "/"} {
		if got, err := cleanUnixPath(in); err != nil || got != want {
			t.Errorf("cleanUnixPath(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "home", "./x", `C:\x`} {
		if _, err := cleanUnixPath(in); !errors.Is(err, errPathRelative) {
			t.Errorf("cleanUnixPath(%q): err = %v, want errPathRelative", in, err)
		}
	}
	if _, err := cleanUnixPath("/a\x00b"); !errors.Is(err, errPathInvalid) {
		t.Errorf("NUL: err = %v", err)
	}
}
