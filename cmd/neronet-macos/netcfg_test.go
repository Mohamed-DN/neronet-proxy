package main

import (
	"context"
	"net/netip"
	"reflect"
	"testing"
)

func mustPrefix(t *testing.T, s string) netip.Prefix {
	t.Helper()
	p, err := netip.ParsePrefix(s)
	if err != nil {
		t.Fatalf("ParsePrefix(%q): %v", s, err)
	}
	return p
}

func TestIfconfigArgs(t *testing.T) {
	addrs := []netip.Prefix{mustPrefix(t, "100.64.12.34/32"), mustPrefix(t, "fd00:4e45::1/64")}
	got := ifconfigArgs("utun3", addrs, 1420)
	want := [][]string{
		{"/sbin/ifconfig", "utun3", "inet", "100.64.12.34", "100.64.12.34", "netmask", "255.255.255.255", "alias"},
		{"/sbin/ifconfig", "utun3", "inet6", "fd00:4e45::1", "prefixlen", "64", "alias"},
		{"/sbin/ifconfig", "utun3", "mtu", "1420", "up"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ifconfigArgs:\n got %q\nwant %q", got, want)
	}
}

func TestIfconfigArgsNoAddressStillBringsUp(t *testing.T) {
	got := ifconfigArgs("utun0", nil, 1280)
	want := [][]string{{"/sbin/ifconfig", "utun0", "mtu", "1280", "up"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestV4Netmask(t *testing.T) {
	cases := map[int]string{0: "0.0.0.0", 10: "255.192.0.0", 24: "255.255.255.0", 32: "255.255.255.255"}
	for bits, want := range cases {
		if got := v4Netmask(bits); got != want {
			t.Errorf("v4Netmask(%d) = %s, want %s", bits, got, want)
		}
	}
}

func TestRouteArgs(t *testing.T) {
	cases := []struct {
		name string
		got  []string
		want []string
	}{
		{
			"v4 add",
			routeAddArgs(mustPrefix(t, "100.64.0.0/10"), "utun3"),
			[]string{"/sbin/route", "-n", "add", "-net", "100.64.0.0/10", "-interface", "utun3"},
		},
		{
			"v4 delete masks host bits",
			routeDelArgs(mustPrefix(t, "10.1.2.3/24"), "utun3"),
			[]string{"/sbin/route", "-n", "delete", "-net", "10.1.2.0/24", "-interface", "utun3"},
		},
		{
			"v6 add",
			routeAddArgs(mustPrefix(t, "fd00:4e45::/64"), "utun3"),
			[]string{"/sbin/route", "-n", "add", "-inet6", "-net", "fd00:4e45::/64", "-interface", "utun3"},
		},
		{
			"v6 delete",
			routeDelArgs(mustPrefix(t, "fd00:4e45::/64"), "utun9"),
			[]string{"/sbin/route", "-n", "delete", "-inet6", "-net", "fd00:4e45::/64", "-interface", "utun9"},
		},
	}
	for _, c := range cases {
		if !reflect.DeepEqual(c.got, c.want) {
			t.Errorf("%s:\n got %q\nwant %q", c.name, c.got, c.want)
		}
	}
}

func TestEndpointRouted(t *testing.T) {
	gw := netip.MustParseAddr("203.0.113.5")
	if endpointRouted(gw, []netip.Prefix{mustPrefix(t, "100.64.0.0/10")}) {
		t.Error("gateway outside AllowedIPs reported as routed")
	}
	if !endpointRouted(gw, []netip.Prefix{mustPrefix(t, "0.0.0.0/0")}) {
		t.Error("full tunnel 0.0.0.0/0 must report the endpoint as routed")
	}
	if endpointRouted(gw, []netip.Prefix{mustPrefix(t, "fd00:4e45::/64")}) {
		t.Error("IPv6 prefix must not match an IPv4 endpoint")
	}
}

func TestResolveEndpointLiterals(t *testing.T) {
	ctx := context.Background()
	got, err := resolveEndpoint(ctx, "203.0.113.5:51820")
	if err != nil || got.String() != "203.0.113.5:51820" {
		t.Fatalf("v4 literal: %v %v", got, err)
	}
	got, err = resolveEndpoint(ctx, "[2001:db8::5]:51820")
	if err != nil || got.String() != "[2001:db8::5]:51820" {
		t.Fatalf("v6 literal: %v %v", got, err)
	}
	for _, bad := range []string{"203.0.113.5", "203.0.113.5:0", "203.0.113.5:70000", "203.0.113.5:x"} {
		if _, err := resolveEndpoint(ctx, bad); err == nil {
			t.Errorf("resolveEndpoint(%q) accepted a bad endpoint", bad)
		}
	}
}
