package main

import (
	"net/netip"
	"strings"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

func TestSearchDomain(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"absent", "[Interface]\nPrivateKey = x\n", "", false},
		{"present, mixed case", "# NeroNet-Search: Corp.Example\n", "corp.example", false},
		{"same twice", "# NeroNet-Search: a.example\n# NeroNet-Search: a.example\n", "a.example", false},
		{"two different", "# NeroNet-Search: a.example\n# NeroNet-Search: b.example\n", "", true},
		{"not a domain", "# NeroNet-Search: a/b\n", "", true},
		{"label too long", "# NeroNet-Search: " + strings.Repeat("a", 64) + ".example\n", "", true},
		{"empty value", "# NeroNet-Search:\n", "", true},
	}
	for _, c := range cases {
		got, err := searchDomain([]byte(c.in))
		if (err != nil) != c.wantErr {
			t.Errorf("%s: err = %v, wantErr %v", c.name, err, c.wantErr)
			continue
		}
		if got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestSearchLineIsAcceptedByProfileParser(t *testing.T) {
	// The strict parser must keep working on a profile that carries the CLI's search line.
	key := strings.Repeat("A", 43) + "="
	text := "# NeroNet-Profile: 1\n# NeroNet-Search: corp.example\n[Interface]\nPrivateKey = " + key +
		"\nAddress = 100.64.12.34/32\nDNS = 100.64.0.1\n\n[Peer]\nPublicKey = " + key +
		"\nEndpoint = 203.0.113.5:51820\nAllowedIPs = 100.64.0.0/10\n"
	if _, err := profile.Parse(strings.NewReader(text)); err != nil {
		t.Fatalf("profile.Parse rejected a profile with NeroNet-Search: %v", err)
	}
}

func TestResolverPath(t *testing.T) {
	got, err := resolverPath("corp.example")
	if err != nil || got != "/etc/resolver/corp.example" {
		t.Fatalf("resolverPath = %q, %v", got, err)
	}
	for _, bad := range []string{"", "../etc", "a/b", "Corp Example"} {
		if _, err := resolverPath(bad); err == nil {
			t.Errorf("resolverPath(%q) accepted a bad domain", bad)
		}
	}
}

func TestResolverFile(t *testing.T) {
	servers := []netip.Addr{netip.MustParseAddr("100.64.0.1"), netip.MustParseAddr("fd00:4e45::53")}
	want := "nameserver 100.64.0.1\nnameserver fd00:4e45::53\n"
	if got := resolverFile(servers); got != want {
		t.Fatalf("resolverFile = %q, want %q", got, want)
	}
	if got := resolverFile(nil); got != "" {
		t.Fatalf("resolverFile(nil) = %q, want empty", got)
	}
}
