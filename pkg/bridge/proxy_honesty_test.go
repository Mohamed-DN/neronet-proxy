package bridge

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// The node's proxies told a client it was connected before trying to connect: the
// SOCKS5 inbound answered success and the HTTP inbound "200 Connection Established"
// whatever the outbound dial did next. The SOCKS5 inbound accepted any username and
// password. And the HTTP server's timeouts stayed on the connection after the
// hijack, closing every CONNECT tunnel 30 seconds in.

func loopbackBridge() *NetstackBridge {
	return NewNetstackBridge(NewSandboxPolicyEngine(SandboxPolicyConfig{AllowLAN: true}), nil, nil)
}

// closedPort returns a loopback port nothing listens on.
func closedPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

func echoServer(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func socksRequest(port int) []byte {
	return []byte{0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, byte(port >> 8), byte(port)}
}

func TestSOCKS5ReportsARefusedDestination(t *testing.T) {
	srv := NewSOCKS5Server("127.0.0.1:0", loopbackBridge())
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))

	_, _ = c.Write([]byte{0x05, 0x01, 0x00})
	var method [2]byte
	if _, err := io.ReadFull(c, method[:]); err != nil {
		t.Fatal(err)
	}
	_, _ = c.Write(socksRequest(closedPort(t)))
	var reply [10]byte
	if _, err := io.ReadFull(c, reply[:]); err != nil {
		t.Fatal(err)
	}
	if reply[1] == SOCKS5RepSuccess {
		t.Fatal("the proxy reported success for a destination that refused the connection")
	}
	if reply[1] != SOCKS5RepConnRefused {
		t.Fatalf("reply %#x, want connection refused (0x05)", reply[1])
	}
}

func socksAuth(t *testing.T, addr, user, pass string) (net.Conn, byte) {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	_, _ = c.Write([]byte{0x05, 0x01, 0x02})
	var method [2]byte
	if _, err := io.ReadFull(c, method[:]); err != nil {
		t.Fatal(err)
	}
	if method[1] != SOCKS5AuthUserPass {
		t.Fatalf("method %#x, want username/password", method[1])
	}
	msg := []byte{0x01, byte(len(user))}
	msg = append(msg, user...)
	msg = append(msg, byte(len(pass)))
	msg = append(msg, pass...)
	_, _ = c.Write(msg)
	var status [2]byte
	if _, err := io.ReadFull(c, status[:]); err != nil {
		t.Fatal(err)
	}
	return c, status[1]
}

func TestSOCKS5ChecksTheConfiguredCredentials(t *testing.T) {
	srv := NewSOCKS5Server("127.0.0.1:0", loopbackBridge())
	srv.SetCredentials("alice", "correct horse")
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	wrong, status := socksAuth(t, srv.Addr().String(), "alice", "wrong")
	wrong.Close()
	if status == 0x00 {
		t.Fatal("a wrong password was accepted")
	}

	// No authentication offered at all: nothing acceptable.
	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	_, _ = c.Write([]byte{0x05, 0x01, 0x00})
	var method [2]byte
	_, _ = io.ReadFull(c, method[:])
	c.Close()
	if method[1] != SOCKS5AuthNoAcceptable {
		t.Fatalf("a client offering no authentication got method %#x", method[1])
	}

	right, status := socksAuth(t, srv.Addr().String(), "alice", "correct horse")
	defer right.Close()
	if status != 0x00 {
		t.Fatalf("the right password was refused (%#x)", status)
	}
	port := echoServer(t)
	_, _ = right.Write(socksRequest(port))
	var reply [10]byte
	if _, err := io.ReadFull(right, reply[:]); err != nil || reply[1] != SOCKS5RepSuccess {
		t.Fatalf("connect after authentication: %v %#x", err, reply[1])
	}
}

func httpConnect(t *testing.T, proxy string, port int, auth string) (net.Conn, *bufio.Reader, string) {
	t.Helper()
	c, err := net.Dial("tcp", proxy)
	if err != nil {
		t.Fatal(err)
	}
	req := fmt.Sprintf("CONNECT 127.0.0.1:%d HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n", port, port)
	if auth != "" {
		req += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(auth)) + "\r\n"
	}
	_, _ = c.Write([]byte(req + "\r\n"))
	r := bufio.NewReader(c)
	status, err := r.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	// Skip the rest of the response head.
	for {
		line, err := r.ReadString('\n')
		if err != nil || line == "\r\n" {
			break
		}
	}
	return c, r, status
}

func TestHTTPConnectReportsARefusedDestination(t *testing.T) {
	srv := NewHTTPProxyServer("127.0.0.1:0", loopbackBridge())
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, _, status := httpConnect(t, srv.Addr().String(), closedPort(t), "")
	c.Close()
	if strings.Contains(status, " 200 ") {
		t.Fatalf("the proxy said %q for a destination that refused the connection", strings.TrimSpace(status))
	}
}

func TestHTTPConnectRequiresTheConfiguredCredentials(t *testing.T) {
	srv := NewHTTPProxyServer("127.0.0.1:0", loopbackBridge())
	srv.SetCredentials("bob", "s3cret")
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	port := echoServer(t)

	c, _, status := httpConnect(t, srv.Addr().String(), port, "bob:wrong")
	c.Close()
	if !strings.Contains(status, " 407 ") {
		t.Fatalf("wrong credentials: %q, want 407", strings.TrimSpace(status))
	}
	c, _, status = httpConnect(t, srv.Addr().String(), port, "bob:s3cret")
	c.Close()
	if !strings.Contains(status, " 200 ") {
		t.Fatalf("right credentials: %q, want 200", strings.TrimSpace(status))
	}
}

func TestHTTPConnectTunnelOutlivesTheRequestTimeout(t *testing.T) {
	srv := NewHTTPProxyServer("127.0.0.1:0", loopbackBridge())
	srv.requestTimeout = 200 * time.Millisecond
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, r, status := httpConnect(t, srv.Addr().String(), echoServer(t), "")
	defer c.Close()
	if !strings.Contains(status, " 200 ") {
		t.Fatalf("CONNECT: %q", status)
	}

	time.Sleep(600 * time.Millisecond)
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte("still here\n")); err != nil {
		t.Fatalf("write after the request timeout: %v", err)
	}
	line, err := r.ReadString('\n')
	if err != nil || line != "still here\n" {
		t.Fatalf("the tunnel was closed by the request timeout: %q %v", line, err)
	}
}
