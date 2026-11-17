package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

// testKey returns a 32-byte WireGuard-shaped key filled with seed, in base64.
func testKey(seed byte) string {
	return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{seed}, 32))
}

func mustParse(t *testing.T, text string) *profile.Profile {
	t.Helper()
	p, err := profile.Parse(strings.NewReader(text))
	if err != nil {
		t.Fatalf("profile.Parse: %v", err)
	}
	return p
}

func sampleProfileText(address, allowed string) string {
	return fmt.Sprintf(`# NeroNet-Profile: 1
# NeroNet-Console: https://console.example/me
# NeroNet-Device: dev-0123abcd
[Interface]
PrivateKey = %s
Address = %s
DNS = 10.99.0.1
MTU = 1380

[Peer]
PublicKey = %s
PresharedKey = %s
Endpoint = 10.77.42.10:51820
AllowedIPs = %s
PersistentKeepalive = 25
`, testKey(1), address, testKey(2), testKey(3), allowed)
}

func TestTunnelRoutes(t *testing.T) {
	p := mustParse(t, sampleProfileText("10.99.0.2/32", "10.99.0.0/24, 10.99.0.0/24, 192.168.50.7/16"))
	got := tunnelRoutes(p)
	want := []netip.Prefix{netip.MustParsePrefix("10.99.0.0/24"), netip.MustParsePrefix("192.168.0.0/16")}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("tunnelRoutes = %v, want %v", got, want)
	}
}

func TestTunnelRoutesSkipsOwnAddressPrefix(t *testing.T) {
	// With a /24 address the kernel already installs 10.99.0.0/24 when the address is added.
	p := mustParse(t, sampleProfileText("10.99.0.2/24", "10.99.0.0/24, 192.168.50.7/16"))
	got := tunnelRoutes(p)
	if len(got) != 1 || got[0] != netip.MustParsePrefix("192.168.0.0/16") {
		t.Fatalf("tunnelRoutes = %v, want only 192.168.0.0/16", got)
	}
}

func TestTunnelRoutesDefaultAndIPv6(t *testing.T) {
	p := mustParse(t, sampleProfileText("10.99.0.2/32", "0.0.0.0/0, ::/0"))
	got := tunnelRoutes(p)
	if len(got) != 2 || got[0].String() != "0.0.0.0/0" || got[1].String() != "::/0" {
		t.Fatalf("tunnelRoutes = %v", got)
	}
}

func TestBypassForPicksLongestPrefix(t *testing.T) {
	const tun = 9
	routes := []routeEntry{
		{Dst: netip.MustParsePrefix("0.0.0.0/0"), Gateway: netip.MustParseAddr("10.77.42.1"), OutIf: 2},
		{Dst: netip.MustParsePrefix("10.77.42.0/24"), OutIf: 2},
		{Dst: netip.MustParsePrefix("0.0.0.0/0"), OutIf: tun},
	}
	hop, ok := bypassFor(netip.MustParseAddr("10.77.42.10"), routes, tun)
	if !ok || hop.OutIf != 2 || hop.Gateway.IsValid() {
		t.Fatalf("on-link endpoint: got %+v ok=%v, want the connected route on dev 2", hop, ok)
	}
	hop, ok = bypassFor(netip.MustParseAddr("8.8.8.8"), routes, tun)
	if !ok || hop.OutIf != 2 || hop.Gateway != netip.MustParseAddr("10.77.42.1") {
		t.Fatalf("remote endpoint: got %+v ok=%v, want the default route via 10.77.42.1", hop, ok)
	}
}

func TestBypassForIgnoresTunnelAndReportsNoRoute(t *testing.T) {
	const tun = 9
	routes := []routeEntry{{Dst: netip.MustParsePrefix("0.0.0.0/0"), OutIf: tun}}
	if _, ok := bypassFor(netip.MustParseAddr("8.8.8.8"), routes, tun); ok {
		t.Fatal("a route only through the tunnel must not be used as a bypass")
	}
	if _, ok := bypassFor(netip.MustParseAddr("2001:db8::1"), routes, tun); ok {
		t.Fatal("an IPv6 endpoint must not match IPv4 routes")
	}
}

func TestBypassForTieBreaksOnPriority(t *testing.T) {
	routes := []routeEntry{
		{Dst: netip.MustParsePrefix("10.1.0.0/16"), OutIf: 3, Priority: 100},
		{Dst: netip.MustParsePrefix("10.1.0.0/16"), OutIf: 4, Priority: 50},
	}
	hop, ok := bypassFor(netip.MustParseAddr("10.1.2.3"), routes, 9)
	if !ok || hop.OutIf != 4 {
		t.Fatalf("got %+v, want the lower-priority route on dev 4", hop)
	}
}

func TestValidIfaceName(t *testing.T) {
	for name, want := range map[string]bool{
		"neronet0":          true,
		"wg-0_x":            true,
		"":                  false,
		"bad name":          false,
		"x; drop":           false,
		"sixteen-chars-xyz": false,
	} {
		if got := validIfaceName(name); got != want {
			t.Errorf("validIfaceName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestKillSwitchRuleset(t *testing.T) {
	eps := []netip.AddrPort{
		netip.MustParseAddrPort("10.77.42.10:51820"),
		netip.MustParseAddrPort("[2001:db8::1]:51821"),
	}
	got, err := killSwitchRuleset("neronet0", eps)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{
		"table inet neronet {",
		"type filter hook output priority filter; policy drop;",
		`oifname "lo" accept`,
		`oifname "neronet0" accept`,
		"ip daddr 10.77.42.10 udp dport 51820 accept",
		"ip6 daddr 2001:db8::1 udp dport 51821 accept",
	} {
		if !strings.Contains(got, line) {
			t.Errorf("ruleset lacks %q:\n%s", line, got)
		}
	}
	if strings.Contains(got, "input") || strings.Contains(got, "forward") {
		t.Errorf("ruleset must only filter output:\n%s", got)
	}
}

func TestKillSwitchRulesetRejectsBadInterfaceName(t *testing.T) {
	if _, err := killSwitchRuleset(`x" accept; drop`, nil); err == nil {
		t.Fatal("expected an error for an interface name that could inject nft syntax")
	}
}

func TestDNSCommands(t *testing.T) {
	got := dnsCommands("neronet0", []netip.Addr{netip.MustParseAddr("10.99.0.1"), netip.MustParseAddr("fd00::1")})
	want := [][]string{
		{"dns", "neronet0", "10.99.0.1", "fd00::1"},
		{"domain", "neronet0", "~."},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("dnsCommands = %v, want %v", got, want)
	}
}

func TestResolveEndpointsLiteralsNeedNoDNS(t *testing.T) {
	p := mustParse(t, sampleProfileText("10.99.0.2/32", "10.99.0.0/24"))
	uapi, resolved, err := resolveEndpoints(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if len(uapi) != 1 || uapi[0] != "10.77.42.10:51820" {
		t.Fatalf("uapi endpoints = %q", uapi)
	}
	if len(resolved) != 1 || resolved[0] != netip.MustParseAddrPort("10.77.42.10:51820") {
		t.Fatalf("resolved = %v", resolved)
	}

	// A peer without an endpoint is left unset, and so is its UAPI slot.
	p.Peers = append(p.Peers, profile.Peer{PublicKey: p.Peers[0].PublicKey, AllowedIPs: p.Peers[0].AllowedIPs})
	uapi, resolved, err = resolveEndpoints(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if len(uapi) != 2 || uapi[1] != "" || len(resolved) != 1 {
		t.Fatalf("with a second peer without endpoint: uapi=%q resolved=%v", uapi, resolved)
	}
}

func TestResolveEndpointsIPv6Literal(t *testing.T) {
	p := mustParse(t, strings.Replace(sampleProfileText("10.99.0.2/32", "10.99.0.0/24"),
		"Endpoint = 10.77.42.10:51820", "Endpoint = [2001:db8::1]:51820", 1))
	uapi, _, err := resolveEndpoints(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if uapi[0] != "[2001:db8::1]:51820" {
		t.Fatalf("uapi endpoint = %q", uapi[0])
	}
}

func TestParseUAPIGet(t *testing.T) {
	privHex := hex.EncodeToString(bytes.Repeat([]byte{1}, 32))
	pskHex := hex.EncodeToString(bytes.Repeat([]byte{3}, 32))
	peerHex := hex.EncodeToString(bytes.Repeat([]byte{2}, 32))
	reply := strings.Join([]string{
		"private_key=" + privHex,
		"listen_port=51820",
		"public_key=" + peerHex,
		"preshared_key=" + pskHex,
		"endpoint=10.77.42.10:51820",
		"last_handshake_time_sec=1700000000",
		"last_handshake_time_nsec=5",
		"tx_bytes=100",
		"rx_bytes=200",
		"persistent_keepalive_interval=25",
		"allowed_ip=10.99.0.0/24",
		"public_key=" + hex.EncodeToString(bytes.Repeat([]byte{4}, 32)),
		"tx_bytes=0",
		"rx_bytes=0",
		"persistent_keepalive_interval=0",
		"allowed_ip=0.0.0.0/0",
		"errno=0",
		"",
	}, "\n")

	ds, err := parseUAPIGet(strings.NewReader(reply))
	if err != nil {
		t.Fatal(err)
	}
	if ds.ListenPort != 51820 || len(ds.Peers) != 2 {
		t.Fatalf("device = %+v", ds)
	}
	p := ds.Peers[0]
	if p.PublicKey != base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32)) {
		t.Errorf("public key = %q", p.PublicKey)
	}
	if p.Endpoint != "10.77.42.10:51820" || p.RxBytes != 200 || p.TxBytes != 100 || p.Keepalive != 25 {
		t.Errorf("peer = %+v", p)
	}
	if !p.LastHandshake.Equal(time.Unix(1700000000, 5)) {
		t.Errorf("handshake = %v", p.LastHandshake)
	}
	if fmt.Sprint(p.AllowedIPs) != "[10.99.0.0/24]" {
		t.Errorf("allowed ips = %v", p.AllowedIPs)
	}
	if !ds.Peers[1].LastHandshake.IsZero() {
		t.Errorf("second peer has never shipped a handshake, got %v", ds.Peers[1].LastHandshake)
	}

	// Secrets must not survive parsing, in any form.
	dump := fmt.Sprintf("%+v", ds)
	for _, secret := range []string{privHex, pskHex, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))} {
		if strings.Contains(dump, secret) {
			t.Fatalf("parsed status contains a secret: %s", dump)
		}
	}
}

func TestParseUAPIGetErrors(t *testing.T) {
	if _, err := parseUAPIGet(strings.NewReader("errno=-22\n\n")); err == nil {
		t.Error("errno != 0 must be an error")
	}
	if _, err := parseUAPIGet(strings.NewReader("garbage\n\n")); err == nil {
		t.Error("a line without '=' must be an error")
	}
	if _, err := parseUAPIGet(strings.NewReader("listen_port=abc\n\n")); err == nil {
		t.Error("a non-numeric port must be an error")
	}
}

func TestFormatHandshake(t *testing.T) {
	now := time.Unix(1700000100, 0)
	if got := formatHandshake(time.Time{}, now); got != "never" {
		t.Errorf("zero handshake = %q", got)
	}
	if got := formatHandshake(now.Add(-90*time.Second), now); got != "1m30s ago" {
		t.Errorf("handshake 90s ago = %q", got)
	}
}
