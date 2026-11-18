package bridge

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

// taggedDialer answers every dial with a pipe whose far end writes who it is, so a test
// can tell which device a connection entered the mesh as.
type taggedDialer struct {
	tag    string
	dialed chan string
}

func (d *taggedDialer) DialContext(_ context.Context, _, address string) (net.Conn, error) {
	d.dialed <- address
	client, server := net.Pipe()
	go func() {
		_, _ = server.Write([]byte(d.tag))
		_ = server.Close()
	}()
	return client, nil
}

// socksConnect runs a user/password handshake and a CONNECT. It returns the connection,
// the method the server selected and the CONNECT reply code; 0xff stands for "refused
// before a reply".
func socksConnect(t *testing.T, addr, user, pass, host string, port uint16) (net.Conn, byte, byte) {
	t.Helper()
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = c.Write([]byte{5, 1, SOCKS5AuthUserPass})
	sel := make([]byte, 2)
	if _, err := io.ReadFull(c, sel); err != nil {
		return c, 0xff, 0xff
	}
	if sel[1] != SOCKS5AuthUserPass {
		return c, sel[1], 0xff
	}
	msg := append([]byte{1, byte(len(user))}, user...)
	msg = append(msg, byte(len(pass)))
	msg = append(msg, pass...)
	_, _ = c.Write(msg)
	res := make([]byte, 2)
	if _, err := io.ReadFull(c, res); err != nil || res[1] != 0 {
		return c, sel[1], 0xff
	}
	req := append([]byte{5, 1, 0, SOCKS5AtypDomain, byte(len(host))}, host...)
	req = append(req, byte(port>>8), byte(port))
	_, _ = c.Write(req)
	rep := make([]byte, 10)
	if _, err := io.ReadFull(c, rep); err != nil {
		return c, sel[1], 0xfe
	}
	return c, sel[1], rep[1]
}

func startDeviceSOCKS(t *testing.T, reg *DeviceSOCKS) string {
	t.Helper()
	s := NewSOCKS5Server("127.0.0.1:0", nil)
	s.SetDeviceAuth(reg.Authenticate)
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s.Addr().String()
}

func TestDeviceSOCKSEntersAsTheAuthenticatedDeviceOnly(t *testing.T) {
	a := &taggedDialer{tag: "A", dialed: make(chan string, 4)}
	b := &taggedDialer{tag: "B", dialed: make(chan string, 4)}
	reg := NewDeviceSOCKS()
	reg.Replace(map[string]DeviceEntry{
		"dev-a": {Password: "pw-a", Dialer: a},
		"dev-b": {Password: "pw-b", Dialer: b},
	})
	addr := startDeviceSOCKS(t, reg)

	c, _, rep := socksConnect(t, addr, "dev-b", "pw-b", "node.example.com", 8080)
	defer c.Close()
	if rep != SOCKS5RepSuccess {
		t.Fatalf("reply %#x", rep)
	}
	got := make([]byte, 1)
	if _, err := io.ReadFull(c, got); err != nil || string(got) != "B" {
		t.Fatalf("connection entered as %q (%v), want B", got, err)
	}
	if len(a.dialed) != 0 {
		t.Fatal("device A's dialer was used for device B's credentials")
	}
	if dst := <-b.dialed; dst != "node.example.com:8080" {
		t.Fatalf("dialed %q", dst)
	}
}

func TestDeviceSOCKSRefusesWrongUnknownAndMissingCredentials(t *testing.T) {
	a := &taggedDialer{tag: "A", dialed: make(chan string, 4)}
	reg := NewDeviceSOCKS()
	reg.Replace(map[string]DeviceEntry{"dev-a": {Password: "pw-a", Dialer: a}})
	addr := startDeviceSOCKS(t, reg)

	for name, cred := range map[string][2]string{
		"wrong password": {"dev-a", "nope"},
		"unknown device": {"dev-z", "pw-a"},
		"empty":          {"", ""},
	} {
		c, _, rep := socksConnect(t, addr, cred[0], cred[1], "x.example.com", 1)
		c.Close()
		if rep != 0xff {
			t.Errorf("%s: accepted (reply %#x)", name, rep)
		}
	}

	// A client that offers only "no authentication" gets nothing.
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write([]byte{5, 1, SOCKS5AuthNone})
	sel := make([]byte, 2)
	_, _ = io.ReadFull(c, sel)
	if sel[1] != SOCKS5AuthNoAcceptable {
		t.Fatalf("no-auth client was offered method %#x", sel[1])
	}
	if len(a.dialed) != 0 {
		t.Fatal("a refused client caused a dial")
	}
}

func TestDeviceSOCKSRevocationStopsNewConnections(t *testing.T) {
	a := &taggedDialer{tag: "A", dialed: make(chan string, 4)}
	reg := NewDeviceSOCKS()
	reg.Replace(map[string]DeviceEntry{"dev-a": {Password: "pw-a", Dialer: a}})
	addr := startDeviceSOCKS(t, reg)
	reg.Replace(map[string]DeviceEntry{})
	c, _, rep := socksConnect(t, addr, "dev-a", "pw-a", "x.example.com", 1)
	c.Close()
	if rep != 0xff {
		t.Fatalf("a removed device still authenticates (reply %#x)", rep)
	}
}
