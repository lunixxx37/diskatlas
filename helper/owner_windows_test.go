//go:build windows

package main

import (
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestRealSameUserCheck(t *testing.T) {
	// A client in this process runs as the helper's user: it gets through.
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	ts.Listener = requireSameUser(ts.Listener, platformOwners(), selfSID(), nil)
	ts.Start()
	defer ts.Close()
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	for range 3 {
		resp, err := client.Get(ts.URL)
		if err != nil {
			t.Fatalf("this process was refused: %v", err)
		}
		resp.Body.Close()
	}
}

// tcpRow builds one MIB_TCPROW_OWNER_PID.
func tcpRow(state uint32, local, remote netip.AddrPort, pid uint32) []byte {
	row := make([]byte, tcpRowSize)
	binary.LittleEndian.PutUint32(row, state)
	l, r := local.Addr().As4(), remote.Addr().As4()
	copy(row[4:8], l[:])
	binary.BigEndian.PutUint16(row[8:], local.Port())
	copy(row[12:16], r[:])
	binary.BigEndian.PutUint16(row[16:], remote.Port())
	binary.LittleEndian.PutUint32(row[20:], pid)
	return row
}

func TestFindOwner(t *testing.T) {
	ap := netip.MustParseAddrPort
	helper, client := ap("127.0.0.1:41419"), ap("127.0.0.1:50000")
	rows := [][]byte{
		tcpRow(5, helper, client, 100),                               // the helper's own end
		tcpRow(11, ap("127.0.0.1:50001"), helper, 0),                 // TIME_WAIT: no owner any more
		tcpRow(5, ap("127.0.0.1:50000"), ap("127.0.0.1:41417"), 300), // the same port to another helper
		tcpRow(5, client, helper, 200),                               // the client's end
	}
	table := binary.LittleEndian.AppendUint32(nil, uint32(len(rows)))
	for _, r := range rows {
		table = append(table, r...)
	}
	if pid, err := findOwner(table, client, helper); err != nil || pid != 200 {
		t.Errorf("client: pid %d, %v; want 200", pid, err)
	}
	for _, c := range []netip.AddrPort{ap("127.0.0.1:50001"), ap("127.0.0.1:50002")} {
		if pid, err := findOwner(table, c, helper); err == nil {
			t.Errorf("%v: pid %d for a connection that is gone", c, pid)
		}
	}
	if _, err := findOwner(table[:4+tcpRowSize], client, helper); err == nil {
		t.Error("found a row that isn't in the table")
	}
	// The real table has no such connection.
	if pid, err := (windowsOwners{}).pid(ap("127.0.0.1:1"), ap("127.0.0.1:2")); err == nil {
		t.Errorf("pid %d for a made-up connection", pid)
	}
}

func TestOwnerOfThisProcess(t *testing.T) {
	sid, image, err := windowsOwners{}.user(uint32(os.Getpid()))
	if err != nil || sid == "" || sid != selfSID() {
		t.Fatalf("user: %q, %v; want %q", sid, err, selfSID())
	}
	if exe, _ := os.Executable(); !strings.EqualFold(image, filepath.Base(exe)) || strings.ContainsRune(image, '\\') {
		t.Errorf("image %q", image)
	}
}

func TestBrowsersAreTheSameUser(t *testing.T) {
	// Browsers' sandboxed network and renderer processes still carry the
	// user's SID; the helper must be able to read it. Uses whatever runs.
	browsers := map[string]bool{"chrome.exe": true, "msedge.exe": true, "firefox.exe": true, "brave.exe": true, "opera.exe": true, "vivaldi.exe": true}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(snap)
	self := selfSID()
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	counts := map[string][2]int{}
	for err := windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		name := strings.ToLower(windows.UTF16ToString(e.ExeFile[:]))
		if !browsers[name] {
			continue
		}
		c := counts[name]
		if sid, _, err := (windowsOwners{}).user(e.ProcessID); err == nil && sid == self {
			c[0]++
		} else {
			c[1]++
		}
		counts[name] = c
	}
	if len(counts) == 0 {
		t.Skip("no browser is running")
	}
	for name, c := range counts {
		t.Logf("%s: %d processes recognized as this user, %d not", name, c[0], c[1])
		if c[0] == 0 {
			t.Errorf("no %s process could be identified", name)
		}
	}
}
