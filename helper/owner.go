package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"sync/atomic"
)

// Same user (docs/helper-protocol.md, "Security"): loopback ports are shared
// by every user on a PC, so each accepted connection is checked once: the
// program on the other end must run as the helper's own user. Otherwise the
// connection is closed before a request is read.

// ownerLookup finds who is on the other end of a loopback connection. The
// real one asks Windows (owner_windows.go); tests use a fake.
type ownerLookup interface {
	// pid finds the process owning the client side of the connection from
	// client to server, in the system's TCP table.
	pid(client, server netip.AddrPort) (uint32, error)
	// user returns the user SID of a process, and its image name (without a
	// path) for the log. image may be set even when err is.
	user(pid uint32) (sid, image string, err error)
}

const maxRefusalLogs = 50

// sameUserListener accepts only connections from programs of selfSID.
type sameUserListener struct {
	net.Listener
	owners  ownerLookup
	selfSID string
	logger  *log.Logger
	refused atomic.Int32
}

// requireSameUser wraps ln so that connections from other users' programs
// are closed as soon as they are accepted. A nil lookup allows everything
// (systems other than Windows).
func requireSameUser(ln net.Listener, owners ownerLookup, selfSID string, logger *log.Logger) net.Listener {
	if owners == nil {
		return ln
	}
	return &sameUserListener{Listener: ln, owners: owners, selfSID: selfSID, logger: logger}
}

func (l *sameUserListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if err := l.check(c); err != nil {
			if l.refused.Add(1) <= maxRefusalLogs && l.logger != nil {
				l.logger.Printf("refused a connection: %v", err)
			}
			c.Close()
			continue
		}
		return c, nil
	}
}

var errOtherUser = errors.New("runs as another user")

func (l *sameUserListener) check(c net.Conn) error {
	client, ok1 := c.RemoteAddr().(*net.TCPAddr)
	server, ok2 := c.LocalAddr().(*net.TCPAddr)
	if !ok1 || !ok2 {
		return errors.New("not a TCP connection")
	}
	pid, err := l.owners.pid(unmapped(client), unmapped(server))
	if err != nil {
		return fmt.Errorf("could not find the program behind port %d: %w", client.Port, err)
	}
	sid, image, err := l.owners.user(pid)
	if image == "" {
		image = "a program"
	}
	if err != nil {
		return fmt.Errorf("could not identify %s (pid %d): %w", image, pid, err)
	}
	if sid == "" || sid != l.selfSID {
		return fmt.Errorf("%s (pid %d) %w", image, pid, errOtherUser)
	}
	return nil
}

func unmapped(a *net.TCPAddr) netip.AddrPort {
	ap := a.AddrPort()
	return netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
}
