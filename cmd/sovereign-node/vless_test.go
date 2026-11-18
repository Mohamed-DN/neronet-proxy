package main

import (
	"context"
	"encoding/json"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/bridge"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

const (
	vlessUUID1 = "6f0f2a6e-1c5b-4f43-9a52-0b3c1d2e4f60"
	vlessUUID2 = "0a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
	vlessKey   = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

type fakeDialer struct{ id string }

func (fakeDialer) DialContext(context.Context, string, string) (net.Conn, error) {
	return nil, net.ErrClosed
}

type vlessRig struct {
	m       *netmapManager
	cfgPath string
	virtual [][]dataplane.VirtualSpec
	reg     *bridge.DeviceSOCKS
}

func newVlessRig(t *testing.T) *vlessRig {
	t.Helper()
	r := &vlessRig{cfgPath: filepath.Join(t.TempDir(), "xray", "config.json"), reg: bridge.NewDeviceSOCKS()}
	r.m = &netmapManager{}
	r.m.vless = vlessState{
		enabled:    true,
		socksAddr:  "gateway:1081",
		configPath: r.cfgPath,
		reg:        r.reg,
		setVirtual: func(s []dataplane.VirtualSpec) error { r.virtual = append(r.virtual, s); return nil },
		dialerOf:   func(id string) (bridge.OverlayDialer, bool) { return fakeDialer{id}, true },
	}
	return r
}

func vlessDoc(self *control.VlessConfig, peers ...control.NetmapPeer) *control.NetmapResponse {
	d := &control.NetmapResponse{Peers: peers}
	d.Self.Vless = self
	return d
}

func reality() *control.VlessConfig {
	return &control.VlessConfig{ListenPort: 443, Dest: "www.example.com:443", ServerNames: []string{"www.example.com"},
		PrivateKey: vlessKey, ShortIDs: []string{"0123456789abcdef"}}
}

func vlessPeer(id, uuid, ip, key string) control.NetmapPeer {
	return control.NetmapPeer{NodeID: id, PublicKeyHex: key, Profile: true, AccessMethod: "vless-reality",
		VlessUUID: uuid, AllowedIPs: []string{ip + "/32"}}
}

func hex64(c string) string { return strings.Repeat(c, 64) }

func TestVLESSDevicesBecomeVirtualDevicesAndXrayClients(t *testing.T) {
	r := newVlessRig(t)
	doc := vlessDoc(reality(),
		vlessPeer("dev-a", vlessUUID1, "100.64.0.3", hex64("a")),
		control.NetmapPeer{NodeID: "dev-wg", PublicKeyHex: hex64("b"), Profile: true, AccessMethod: "wireguard", AllowedIPs: []string{"100.64.0.4/32"}},
	)
	r.m.reconcileVLESS(doc, nil)

	last := r.virtual[len(r.virtual)-1]
	if len(last) != 1 || last[0].ID != "dev-a" || last[0].Addrs[0] != netip.MustParseAddr("100.64.0.3") {
		t.Fatalf("virtual devices %+v", last)
	}
	if !r.m.vless.served["dev-a"] || r.m.vless.served["dev-wg"] {
		t.Fatalf("served %v", r.m.vless.served)
	}
	raw, err := os.ReadFile(r.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), vlessUUID1) || strings.Contains(string(raw), "dev-wg") {
		t.Fatalf("config clients wrong:\n%s", raw)
	}
	if fi, _ := os.Stat(r.cfgPath); runtimeIsPosix() && fi.Mode().Perm() != 0o600 {
		t.Fatalf("config mode %v", fi.Mode().Perm())
	}
	// the SOCKS registry has an entry for the device and the config's password opens it
	var cfg struct {
		Outbounds []struct {
			Protocol string
			Settings struct {
				Servers []struct{ Users []struct{ User, Pass string } }
			}
		}
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, o := range cfg.Outbounds {
		if o.Protocol != "socks" {
			continue
		}
		u := o.Settings.Servers[0].Users[0]
		if _, ok := r.reg.Authenticate(u.User, u.Pass); !ok || u.User != "dev-a" {
			t.Fatalf("config credentials do not open the registry: %+v", u)
		}
		found = true
	}
	if !found {
		t.Fatal("no socks outbound")
	}
}

var testEpoch = time.Unix(1_000_000_000, 0)

func runtimeIsPosix() bool { return os.PathSeparator == '/' }

func TestVLESSRevokedDeviceIsNotServed(t *testing.T) {
	r := newVlessRig(t)
	doc := vlessDoc(reality(),
		vlessPeer("dev-a", vlessUUID1, "100.64.0.3", hex64("a")),
		vlessPeer("dev-b", vlessUUID2, "100.64.0.4", hex64("b")))
	r.m.reconcileVLESS(doc, map[string]uint64{hex64("b"): 1})
	if r.m.vless.served["dev-b"] || !r.m.vless.served["dev-a"] {
		t.Fatalf("served %v", r.m.vless.served)
	}
	raw, _ := os.ReadFile(r.cfgPath)
	if strings.Contains(string(raw), vlessUUID2) {
		t.Fatal("a revoked device's uuid is still a client")
	}
}

func TestVLESSOrganisationSwitchedOffStopsEverything(t *testing.T) {
	r := newVlessRig(t)
	peer := vlessPeer("dev-a", vlessUUID1, "100.64.0.3", hex64("a"))
	r.m.reconcileVLESS(vlessDoc(reality(), peer), nil)
	if _, err := os.Stat(r.cfgPath); err != nil {
		t.Fatal(err)
	}
	r.m.reconcileVLESS(vlessDoc(nil, peer), nil)
	if _, err := os.Stat(r.cfgPath); !os.IsNotExist(err) {
		t.Fatal("the Xray configuration stays on disk after the method was switched off; the terminator would keep accepting")
	}
	if last := r.virtual[len(r.virtual)-1]; len(last) != 0 {
		t.Fatalf("virtual devices remain: %+v", last)
	}
	if len(r.m.vless.served) != 0 {
		t.Fatal("served is not empty")
	}
	if _, ok := r.reg.Authenticate("dev-a", "anything"); ok {
		t.Fatal("registry still authenticates")
	}
}

func TestVLESSUnchangedDocumentDoesNotRewriteTheConfig(t *testing.T) {
	r := newVlessRig(t)
	doc := vlessDoc(reality(), vlessPeer("dev-a", vlessUUID1, "100.64.0.3", hex64("a")))
	r.m.reconcileVLESS(doc, nil)
	if err := os.Chtimes(r.cfgPath, testEpoch, testEpoch); err != nil {
		t.Fatal(err)
	}
	r.m.reconcileVLESS(doc, nil)
	fi, _ := os.Stat(r.cfgPath)
	if !fi.ModTime().Equal(testEpoch) {
		t.Fatal("an unchanged netmap rewrote the file and would restart Xray")
	}
}

func TestVLESSPeersAreNotWireGuardPeers(t *testing.T) {
	peers, dropped, err := netmapPeers([]control.NetmapPeer{vlessPeer("dev-a", vlessUUID1, "100.64.0.3", hex64("a"))}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 0 || len(dropped) != 0 {
		t.Fatalf("peers %v dropped %v: a VLESS device has no WireGuard session and is not an error", peers, dropped)
	}
}

func TestVLESSCapabilityNeedsAPortAndTheOperatorsConsent(t *testing.T) {
	c := withVless(control.CapabilityDesc{}, 0)
	if len(c.Capabilities) != 0 || c.VlessPort != 0 {
		t.Fatal("capability advertised without a port")
	}
	c = withVless(control.CapabilityDesc{Capabilities: []string{"x"}}, 443)
	if c.VlessPort != 443 || len(c.Capabilities) != 2 || c.Capabilities[1] != VlessCapability {
		t.Fatalf("%+v", c)
	}
}
