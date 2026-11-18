//go:build xrayit

package dataplane

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/proxy"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/bridge"
	"github.com/sovereign/proxy/v4/pkg/xrayconf"
)

// A real Xray-core (the official release, path in XRAY_BIN) as the VLESS + REALITY
// terminator and as the client, against the gateway's virtual device:
//
//	xray client --REALITY--> xray server --SOCKS5 as dev-1--> gateway (virtual device)
//	    --WireGuard--> mesh node N
//
// Run with: go test -tags xrayit -run XrayReality ./pkg/dataplane/ (see scripts/dev/test-vless.sh).

const (
	uuidDev1 = "6f0f2a6e-1c5b-4f43-9a52-0b3c1d2e4f60"
	uuidDev2 = "0a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
	uuidUnk  = "11111111-2222-4333-8444-555555555555"
)

func xrayBin(t *testing.T) string {
	t.Helper()
	p := os.Getenv("XRAY_BIN")
	if p == "" {
		t.Skip("XRAY_BIN is not set")
	}
	return p
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func x25519(t *testing.T, bin string) (priv, pub string) {
	t.Helper()
	out, err := exec.Command(bin, "x25519").CombinedOutput()
	if err != nil {
		t.Fatalf("xray x25519: %v", err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		switch {
		case k == "PrivateKey":
			priv = strings.TrimSpace(v)
		case strings.HasPrefix(k, "Password") || strings.HasPrefix(k, "PublicKey"):
			pub = strings.TrimSpace(v)
		}
	}
	if priv == "" || pub == "" {
		t.Fatalf("could not read the key pair from xray x25519 output")
	}
	return
}

type xrayProc struct {
	cmd *exec.Cmd
	log *os.File
}

func startXray(t *testing.T, bin, dir, name string, cfg []byte) *xrayProc {
	t.Helper()
	path := filepath.Join(dir, name+".json")
	if err := os.WriteFile(path, cfg, 0o600); err != nil {
		t.Fatal(err)
	}
	logf, _ := os.Create(filepath.Join(dir, name+".log"))
	cmd := exec.Command(bin, "run", "-c", path)
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &xrayProc{cmd: cmd, log: logf}
	t.Cleanup(p.stop)
	time.Sleep(700 * time.Millisecond)
	return p
}

func (p *xrayProc) stop() {
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
		_, _ = p.cmd.Process.Wait()
	}
}

func clientConfig(socksPort, serverPort int, uuid, pub, sni, shortID string) []byte {
	cfg := map[string]any{
		"log": map[string]any{"loglevel": "warning"},
		"inbounds": []any{map[string]any{
			"listen": "127.0.0.1", "port": socksPort, "protocol": "socks",
			"settings": map[string]any{"auth": "noauth"},
		}},
		"outbounds": []any{map[string]any{
			"protocol": "vless",
			"settings": map[string]any{"vnext": []any{map[string]any{
				"address": "127.0.0.1", "port": serverPort,
				"users": []any{map[string]any{"id": uuid, "encryption": "none", "flow": "xtls-rprx-vision"}},
			}}},
			"streamSettings": map[string]any{
				"network": "tcp", "security": "reality",
				"realitySettings": map[string]any{
					"serverName": sni, "fingerprint": "chrome", "publicKey": pub, "shortId": shortID,
				},
			},
		}},
	}
	b, _ := json.Marshal(cfg)
	return b
}

// viaClient dials target through an Xray client's SOCKS inbound.
func viaClient(socksPort int, target string, total time.Duration) (net.Conn, error) {
	d, err := proxy.SOCKS5("tcp", fmt.Sprintf("127.0.0.1:%d", socksPort), nil, &net.Dialer{Timeout: total})
	if err != nil {
		return nil, err
	}
	type res struct {
		c   net.Conn
		err error
	}
	ch := make(chan res, 1)
	go func() { c, err := d.Dial("tcp", target); ch <- res{c, err} }()
	select {
	case r := <-ch:
		return r.c, r.err
	case <-time.After(total):
		return nil, fmt.Errorf("no connection within %s", total)
	}
}

func echoVia(c net.Conn) error {
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte("reality")); err != nil {
		return err
	}
	b := make([]byte, 7)
	if _, err := io.ReadFull(c, b); err != nil {
		return err
	}
	if string(b) != "reality" {
		return fmt.Errorf("echo %q", b)
	}
	return nil
}

func TestXrayRealityEntersTheMeshAsTheDevice(t *testing.T) {
	bin := xrayBin(t)
	dir := t.TempDir()

	// Gateway, mesh node and the virtual device with its policy.
	policy := devicePolicy(deviceAddr,
		[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolTCP, 9999, acl.ActionAccept)}, nil)
	r := newVirtRig(t, policy)
	seen := sourceRecorder(t, r.n.dev, 9999)
	vd, _ := r.g.dev.VirtualDialer("dev-1")

	// The gateway's device SOCKS, with a per-device secret only the config holds.
	reg := bridge.NewDeviceSOCKS()
	reg.Replace(map[string]bridge.DeviceEntry{"dev-1": {Password: "per-device-secret-1", Dialer: vd}})
	socks := bridge.NewSOCKS5Server("127.0.0.1:0", nil)
	socks.SetDeviceAuth(reg.Authenticate)
	if err := socks.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = socks.Close() })
	sp := socks.Addr().(*net.TCPAddr).Port

	// REALITY's fallback target: a TLS 1.3 server that stands for the real site.
	site := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }))
	site.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	site.StartTLS()
	t.Cleanup(site.Close)

	priv, pub := x25519(t, bin)
	serverPort := freePort(t)
	spec := xrayconf.Spec{
		ListenPort: uint16(serverPort), Dest: site.Listener.Addr().String(),
		ServerNames: []string{"www.example.com"}, PrivateKey: priv, ShortIDs: []string{"0123456789abcdef"},
		SocksHost: "127.0.0.1", SocksPort: uint16(sp),
		Clients: []xrayconf.Client{{DeviceID: "dev-1", UUID: uuidDev1, SocksPassword: "per-device-secret-1"}},
	}
	cfg, err := xrayconf.Render(spec)
	if err != nil {
		t.Fatal(err)
	}
	server := startXray(t, bin, dir, "server", cfg)
	requireListening(t, serverPort)

	clientPort := func(name, uuid string) int {
		p := freePort(t)
		startXray(t, bin, dir, name, clientConfig(p, serverPort, uuid, pub, "www.example.com", "0123456789abcdef"))
		return p
	}

	t.Run("a device reaches a mesh node and the node sees the device's address", func(t *testing.T) {
		p := clientPort("client-dev1", uuidDev1)
		var c net.Conn
		var err error
		for i := 0; i < 5; i++ {
			if c, err = viaClient(p, meshAddr+":9999", 8*time.Second); err == nil {
				break
			}
		}
		if err != nil {
			t.Fatalf("through REALITY to the mesh node: %v", err)
		}
		defer c.Close()
		if err := echoVia(c); err != nil {
			t.Fatal(err)
		}
		ap, _ := netip.ParseAddrPort(<-seen)
		if ap.Addr().String() != deviceAddr {
			t.Fatalf("mesh node saw %s, want the device's overlay address %s", ap.Addr(), deviceAddr)
		}
	})

	t.Run("an unknown uuid is refused", func(t *testing.T) {
		p := clientPort("client-unknown", uuidUnk)
		if c, err := viaClient(p, meshAddr+":9999", 6*time.Second); err == nil {
			if echoVia(c) == nil {
				t.Fatal("a uuid the organisation never issued got through")
			}
			c.Close()
		}
		select {
		case s := <-seen:
			t.Fatalf("mesh node received a connection from %s", s)
		default:
		}
	})

	t.Run("a DROP rule cuts the device", func(t *testing.T) {
		p := clientPort("client-dev1-drop", uuidDev1)
		r.dFilter.UpdatePolicy(devicePolicy(deviceAddr,
			[]acl.CompiledFilterRule{rule(meshAddr, acl.ProtocolTCP, 9999, acl.ActionDrop)}, nil))
		if c, err := viaClient(p, meshAddr+":9999", 8*time.Second); err == nil {
			if echoVia(c) == nil {
				t.Fatal("traffic passed although the device's policy drops it")
			}
			c.Close()
		}
		// and lifting it restores the path
		r.dFilter.UpdatePolicy(policy)
		var c net.Conn
		var err error
		for i := 0; i < 5; i++ {
			if c, err = viaClient(p, meshAddr+":9999", 8*time.Second); err == nil && echoVia(c) == nil {
				c.Close()
				return
			}
		}
		t.Fatalf("path not restored after the rule was lifted: %v", err)
	})

	t.Run("a device the config does not list gets nothing, and a revoked one is cut", func(t *testing.T) {
		// dev-2 exists in the console but did not choose this method: it is not in the
		// rendered clients, so its uuid is refused like any stranger's.
		p2 := clientPort("client-dev2", uuidDev2)
		if c, err := viaClient(p2, meshAddr+":9999", 6*time.Second); err == nil {
			if echoVia(c) == nil {
				t.Fatal("a device without the method got through")
			}
			c.Close()
		}
		// revoke dev-1: re-render without it and restart the terminator
		server.stop()
		spec.Clients = nil
		cfg, err := xrayconf.Render(spec)
		if err != nil {
			t.Fatal(err)
		}
		startXray(t, bin, dir, "server2", cfg)
		requireListening(t, serverPort)
		reg.Replace(map[string]bridge.DeviceEntry{})
		p1 := clientPort("client-dev1-revoked", uuidDev1)
		if c, err := viaClient(p1, meshAddr+":9999", 6*time.Second); err == nil {
			if echoVia(c) == nil {
				t.Fatal("a revoked device still gets through")
			}
			c.Close()
		}
	})
}

// requireListening fails unless something accepts TCP on the port: a negative test
// against a terminator that never started would pass for the wrong reason.
func requireListening(t *testing.T, port int) {
	t.Helper()
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 2*time.Second)
	if err != nil {
		t.Fatalf("the terminator is not listening on %d: %v", port, err)
	}
	c.Close()
}
