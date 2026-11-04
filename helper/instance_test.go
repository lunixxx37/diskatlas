package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// freePorts returns n ports that were free a moment ago.
func freePorts(t *testing.T, n int) []int {
	t.Helper()
	var ports []int
	var held []net.Listener
	for range n {
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, ln)
		ports = append(ports, ln.Addr().(*net.TCPAddr).Port)
	}
	for _, ln := range held {
		ln.Close()
	}
	return ports
}

func hold(t *testing.T, port int) net.Listener {
	t.Helper()
	ln, err := listen(port)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln
}

func listenerPort(ln net.Listener) int { return ln.Addr().(*net.TCPAddr).Port }

func TestAcquirePort(t *testing.T) {
	never := func(int) bool { return false }

	ports := freePorts(t, 3)
	ln, existing, err := acquirePort(ports, never)
	if err != nil || existing != 0 || listenerPort(ln) != ports[0] {
		t.Fatalf("all free: %v, %d, %v", ln, existing, err)
	}
	// The other candidates were let go again.
	hold(t, ports[1]).Close()
	hold(t, ports[2]).Close()
	ln.Close()

	// The first port is taken by something else: use the next.
	ports = freePorts(t, 3)
	hold(t, ports[0])
	ln, existing, err = acquirePort(ports, never)
	if err != nil || existing != 0 || listenerPort(ln) != ports[1] {
		t.Fatalf("first taken: %v, %d, %v", ln, existing, err)
	}
	ln.Close()

	// A helper runs on the second port, while the first is free.
	ports = freePorts(t, 3)
	hold(t, ports[1])
	isHelper := func(p int) bool { return p == ports[1] }
	ln, existing, err = acquirePort(ports, isHelper)
	if err != nil || existing != ports[1] || ln != nil {
		t.Fatalf("helper running: %v, %d, %v", ln, existing, err)
	}
	hold(t, ports[0]).Close() // released again

	// Every port taken by something else.
	ports = freePorts(t, 2)
	hold(t, ports[0])
	hold(t, ports[1])
	if ln, _, err := acquirePort(ports, never); err == nil {
		ln.Close()
		t.Fatal("no error with every port taken")
	}
}

func TestProbeHelper(t *testing.T) {
	// A real helper is recognized, as a second instance would find it.
	h := newTestHelper(t, serverConfig{})
	if !probeHelper(h.srv.port) {
		t.Error("the helper was not recognized")
	}
	// Other servers are not.
	for _, body := range []string{`{"app":"something-else","protocol":1}`, `{"app":"diskatlas-helper","protocol":2}`, `not json`} {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(body))
		}))
		port := listenerPort(ts.Listener)
		if probeHelper(port) {
			t.Errorf("%s was taken for a helper", body)
		}
		ts.Close()
	}
}

func TestListenRetry(t *testing.T) {
	port := freePorts(t, 1)[0]
	ln := hold(t, port)
	if l, err := listenRetry(port, 100*time.Millisecond); err == nil {
		l.Close()
		t.Fatal("bound a taken port")
	}
	// The old instance lets go after a moment, as after /v1/elevate.
	time.AfterFunc(300*time.Millisecond, func() { ln.Close() })
	start := time.Now()
	l, err := listenRetry(port, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	l.Close()
	if d := time.Since(start); d < 250*time.Millisecond {
		t.Errorf("bound after %v, before the port was free", d)
	}
}

func TestListenLoopbackOnly(t *testing.T) {
	ln, err := listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if addr := ln.Addr().String(); !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Errorf("listening on %s", addr)
	}
}
