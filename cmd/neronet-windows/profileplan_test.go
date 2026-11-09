package main

import (
	"errors"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

// Keys as wg-quick writes them (32 bytes, base64). Test data only.
const (
	testPriv = "YHk3Hc9V+N4Gm5H1T0b6s0zQyVbS3l1v0X3eV4mY2Fk="
	testPub  = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg="
	testPSK  = "FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE="
)

func parseTestProfile(t *testing.T, body string) *profile.Profile {
	t.Helper()
	p, err := profile.Parse(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPlanNetworkBuildsOneRoutePerAllowedIP(t *testing.T) {
	p := parseTestProfile(t, `# NeroNet-Profile: 1
[Interface]
PrivateKey = `+testPriv+`
Address = 100.64.12.34/32, fd7a:115c:a1e0::1234/128
DNS = 100.64.0.1, fd7a:115c:a1e0::53
MTU = 1380

[Peer]
PublicKey = `+testPub+`
Endpoint = gateway.example:51820
AllowedIPs = 100.64.0.0/10, fd7a:115c:a1e0::/48

[Peer]
PublicKey = `+testPub+`
AllowedIPs = 100.64.5.9/10, 192.168.50.0/24
`)
	plan, err := planNetwork(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Addresses) != 2 || plan.MTU != 1380 {
		t.Fatalf("addresses/MTU: %+v", plan)
	}
	// 100.64.5.9/10 masks to 100.64.0.0/10, the same route as the first peer, so it is not repeated.
	wantRoutes := []string{"100.64.0.0/10", "fd7a:115c:a1e0::/48", "192.168.50.0/24"}
	if len(plan.Routes) != len(wantRoutes) {
		t.Fatalf("routes: %+v", plan.Routes)
	}
	for i, r := range plan.Routes {
		if r.Destination.String() != wantRoutes[i] {
			t.Fatalf("route %d: got %s want %s", i, r.Destination, wantRoutes[i])
		}
	}
	if plan.Routes[0].NextHop != netip.IPv4Unspecified() || plan.Routes[1].NextHop != netip.IPv6Unspecified() {
		t.Fatalf("next hops are not on-link: %+v", plan.Routes)
	}
	if len(plan.DNS) != 2 {
		t.Fatalf("dns: %v", plan.DNS)
	}
}

func TestPlanNetworkRefusesDefaultRoute(t *testing.T) {
	p := parseTestProfile(t, `[Interface]
PrivateKey = `+testPriv+`
Address = 100.64.12.34/32

[Peer]
PublicKey = `+testPub+`
AllowedIPs = 0.0.0.0/0
`)
	if _, err := planNetwork(p); err == nil || !strings.Contains(err.Error(), "default route") {
		t.Fatalf("default route accepted: %v", err)
	}
}

func TestPlanNetworkRequiresAnAddress(t *testing.T) {
	p := parseTestProfile(t, `[Interface]
PrivateKey = `+testPriv+`

[Peer]
PublicKey = `+testPub+`
AllowedIPs = 100.64.0.0/10
`)
	if _, err := planNetwork(p); err == nil {
		t.Fatal("profile without Address accepted")
	}
}

func TestDNSByFamilySplitsAddresses(t *testing.T) {
	v4, v6 := dnsByFamily([]netip.Addr{
		netip.MustParseAddr("100.64.0.1"),
		netip.MustParseAddr("fd7a::53"),
		netip.MustParseAddr("1.1.1.1"),
	})
	if len(v4) != 2 || len(v6) != 1 || v6[0].String() != "fd7a::53" {
		t.Fatalf("v4=%v v6=%v", v4, v6)
	}
}

func TestCheckImportSource(t *testing.T) {
	ok := filepath.Join("C:", "Users", "me", "laptop.conf")
	if err := checkImportSource(ok, true, 300); err != nil {
		t.Fatal(err)
	}
	if err := checkImportSource(filepath.Join("C:", "Users", "me", "LAPTOP.CONF"), true, 300); err != nil {
		t.Fatalf("upper-case extension rejected: %v", err)
	}
	cases := map[string]struct {
		path    string
		regular bool
		size    int64
	}{
		"empty path":      {"", true, 300},
		"wrong extension": {"laptop.txt", true, 300},
		"directory":       {"laptop.conf", false, 300},
		"empty file":      {"laptop.conf", true, 0},
		"oversized file":  {"laptop.conf", true, maxProfileBytes + 1},
	}
	for name, c := range cases {
		if err := checkImportSource(c.path, c.regular, c.size); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestProfilePathStaysInDataDirectory(t *testing.T) {
	dir := filepath.Join("C:", "ProgramData", "NeroNet")
	if got := profilePath(dir); filepath.Dir(got) != dir || filepath.Base(got) != "profile.conf" {
		t.Fatalf("profilePath = %s", got)
	}
}

func TestFormatStatusNeverPrintsKeys(t *testing.T) {
	p := parseTestProfile(t, `# NeroNet-Profile: 1
# NeroNet-Console: https://console.example/me
# NeroNet-Device: dev-0123abcd
[Interface]
PrivateKey = `+testPriv+`
Address = 100.64.12.34/32

[Peer]
PublicKey = `+testPub+`
PresharedKey = `+testPSK+`
Endpoint = gateway.example:51820
AllowedIPs = 100.64.0.0/10
`)
	out := formatStatus(statusReport{Service: "running", Profile: p})
	for _, secret := range []string{testPriv, testPSK, testPub} {
		if strings.Contains(out, secret) {
			t.Fatalf("status leaks key material: %s", out)
		}
	}
	for _, want := range []string{"Service:  running", "dev-0123abcd", "https://console.example/me"} {
		if !strings.Contains(out, want) {
			t.Fatalf("status lacks %q:\n%s", want, out)
		}
	}
}

func TestFormatStatusStates(t *testing.T) {
	if out := formatStatus(statusReport{Service: "not installed"}); !strings.Contains(out, "import one") {
		t.Fatalf("no-profile hint missing: %s", out)
	}
	out := formatStatus(statusReport{Service: "stopped", ProfileErr: errors.New("access denied")})
	if !strings.Contains(out, "unreadable: access denied") {
		t.Fatalf("unreadable profile not reported: %s", out)
	}
}
