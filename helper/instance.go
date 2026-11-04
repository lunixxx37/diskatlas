package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

// listen binds a port on the loopback interface only.
func listen(port int) (net.Listener, error) {
	return net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
}

// acquirePort binds the first free port of ports, unless one of the taken
// ports belongs to a running helper: then it returns that port as existing
// and no listener. All candidates are tried first, so a helper on a later
// port is found even if an earlier port has become free since it started.
func acquirePort(ports []int, isHelper func(port int) bool) (ln net.Listener, existing int, err error) {
	listeners := make([]net.Listener, len(ports))
	var taken []int
	for i, p := range ports {
		if l, err := listen(p); err == nil {
			listeners[i] = l
		} else {
			taken = append(taken, p)
		}
	}
	closeAllBut := func(keep net.Listener) {
		for _, l := range listeners {
			if l != nil && l != keep {
				l.Close()
			}
		}
	}
	for _, p := range taken {
		if isHelper(p) {
			closeAllBut(nil)
			return nil, p, nil
		}
	}
	for _, l := range listeners {
		if l != nil {
			closeAllBut(l)
			return l, 0, nil
		}
	}
	return nil, 0, fmt.Errorf("the ports %v are all in use", ports)
}

// listenRetry binds port, retrying until timeout while it is still taken.
func listenRetry(port int, timeout time.Duration) (net.Listener, error) {
	deadline := time.Now().Add(timeout)
	for {
		ln, err := listen(port)
		if err == nil || time.Now().After(deadline) {
			return ln, err
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// probeHelper reports whether a DiskAtlas Helper answers on port, the way
// the website recognizes one: GET /v1/info with app and protocol.
func probeHelper(port int) bool {
	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true},
	}
	req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+"/v1/info", nil)
	if err != nil {
		return false
	}
	origin, err := normalizeOrigin(siteOrigin)
	if err != nil {
		origin = siteOrigin
	}
	req.Header.Set("Origin", origin)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var info struct {
		App      string `json:"app"`
		Protocol int    `json:"protocol"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&info); err != nil {
		return false
	}
	return info.App == appName && info.Protocol == protocolVersion
}
