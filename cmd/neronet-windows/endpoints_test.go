package main

import (
	"context"
	"errors"
	"net/netip"
	"testing"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

func fakeLookup(table map[string][]netip.Addr) lookupFunc {
	return func(_ context.Context, host string) ([]netip.Addr, error) {
		addrs, ok := table[host]
		if !ok {
			return nil, errors.New("no such host")
		}
		return addrs, nil
	}
}

func TestResolveEndpointsUsesLiteralsAndPrefersIPv4(t *testing.T) {
	peers := []profile.Peer{
		{Endpoint: "203.0.113.7:51820"},
		{Endpoint: "[2001:db8::1]:51820"},
		{Endpoint: "gateway.example:51820"},
		{}, // no endpoint: left unset
	}
	lookup := fakeLookup(map[string][]netip.Addr{
		"gateway.example": {netip.MustParseAddr("2001:db8::53"), netip.MustParseAddr("198.51.100.9")},
	})
	got, err := resolveEndpoints(context.Background(), lookup, peers)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"203.0.113.7:51820", "[2001:db8::1]:51820", "198.51.100.9:51820", ""}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("endpoint %d: got %q want %q", i, got[i], want[i])
		}
	}
}

func TestResolveEndpointsFallsBackToIPv6WhenNoIPv4(t *testing.T) {
	peers := []profile.Peer{{Endpoint: "gw.example:443"}}
	lookup := fakeLookup(map[string][]netip.Addr{"gw.example": {netip.MustParseAddr("2001:db8::53")}})
	got, err := resolveEndpoints(context.Background(), lookup, peers)
	if err != nil {
		t.Fatal(err)
	}
	if got[0] != "[2001:db8::53]:443" {
		t.Fatalf("got %q", got[0])
	}
}

func TestResolveEndpointsReportsLookupFailures(t *testing.T) {
	peers := []profile.Peer{{Endpoint: "missing.example:51820"}}
	if _, err := resolveEndpoints(context.Background(), fakeLookup(nil), peers); err == nil {
		t.Fatal("lookup failure not reported")
	}
	empty := fakeLookup(map[string][]netip.Addr{"missing.example": {}})
	if _, err := resolveEndpoints(context.Background(), empty, peers); err == nil {
		t.Fatal("empty answer not reported")
	}
}

func TestResolveEndpointsRejectsBadPorts(t *testing.T) {
	for _, ep := range []string{"203.0.113.7", "203.0.113.7:0", "203.0.113.7:70000", "203.0.113.7:abc"} {
		peers := []profile.Peer{{Endpoint: ep}}
		if _, err := resolveEndpoints(context.Background(), fakeLookup(nil), peers); err == nil {
			t.Fatalf("endpoint %q accepted", ep)
		}
	}
}
