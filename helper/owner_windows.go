//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"net/netip"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetExtendedTcpTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

const (
	afInet                      = 2
	tcpTableOwnerPIDConnections = 4  // TCP_TABLE_OWNER_PID_CONNECTIONS
	tcpRowSize                  = 24 // MIB_TCPROW_OWNER_PID: six DWORDs
)

func platformOwners() ownerLookup { return windowsOwners{} }

// selfSID is the user SID of the helper's own process token. An elevated
// helper (after the UAC consent prompt) has the same user as the one that
// started it.
func selfSID() string {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return ""
	}
	return u.User.Sid.String()
}

type windowsOwners struct{}

// pid looks the connection up in the IPv4 TCP table: the client's own row
// has the client's address as its local end and the helper as its remote end.
func (windowsOwners) pid(client, server netip.AddrPort) (uint32, error) {
	table, err := tcpTable()
	if err != nil {
		return 0, err
	}
	return findOwner(table, client, server)
}

// findOwner searches a MIB_TCPTABLE_OWNER_PID. Addresses and ports are in
// network byte order there; the rest is little-endian.
func findOwner(table []byte, client, server netip.AddrPort) (uint32, error) {
	if len(table) < 4 {
		return 0, errors.New("the TCP table is empty")
	}
	n := int(binary.LittleEndian.Uint32(table))
	for i := range n {
		row := table[4+i*tcpRowSize:]
		if len(row) < tcpRowSize {
			break
		}
		local := netip.AddrPortFrom(netip.AddrFrom4([4]byte(row[4:8])), uint16(row[8])<<8|uint16(row[9]))
		remote := netip.AddrPortFrom(netip.AddrFrom4([4]byte(row[12:16])), uint16(row[16])<<8|uint16(row[17]))
		pid := binary.LittleEndian.Uint32(row[20:])
		if local == client && remote == server && pid != 0 {
			return pid, nil
		}
	}
	return 0, errors.New("the connection is not in the TCP table (the program may have closed it)")
}

// tcpTable reads the IPv4 connection table with owning PIDs.
func tcpTable() ([]byte, error) {
	size := uint32(32 << 10)
	for range 8 {
		buf := make([]byte, size)
		r, _, _ := syscall.SyscallN(procGetExtendedTcpTable.Addr(), uintptr(unsafe.Pointer(&buf[0])),
			uintptr(unsafe.Pointer(&size)), 0, afInet, tcpTableOwnerPIDConnections, 0)
		switch syscall.Errno(r) {
		case 0:
			return buf, nil
		case windows.ERROR_INSUFFICIENT_BUFFER:
			size += 4 << 10 // it may grow again before the next call
			continue
		default:
			return nil, syscall.Errno(r)
		}
	}
	return nil, errors.New("the TCP table kept growing")
}

// user reads a process's user SID. PROCESS_QUERY_LIMITED_INFORMATION and
// TOKEN_QUERY are enough, also for browsers' sandboxed network processes,
// which carry the user's SID at a lower integrity level.
func (windowsOwners) user(pid uint32) (string, string, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", "", err
	}
	defer windows.CloseHandle(h)
	image := imageName(h)
	var tok windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &tok); err != nil {
		return "", image, err
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return "", image, err
	}
	return u.User.Sid.String(), image, nil
}

// imageName is the file name of a process's program, without its folder.
func imageName(h windows.Handle) string {
	buf := make([]uint16, windows.MAX_PATH+1)
	size := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &size) != nil {
		return ""
	}
	return filepath.Base(windows.UTF16ToString(buf[:size]))
}
