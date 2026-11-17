package main

import (
	"fmt"
	"net"
	"net/netip"
	"testing"

	"github.com/jsimonetti/rtnetlink"
	"golang.org/x/sys/unix"
)

func TestGoneRecognisesAbsentObjects(t *testing.T) {
	for _, err := range []error{
		fmt.Errorf("delete: %w", unix.ESRCH),
		unix.ENOENT,
		unix.ENODEV,
	} {
		if !gone(err) {
			t.Errorf("gone(%v) = false, want true", err)
		}
	}
	if gone(unix.EPERM) {
		t.Error("EPERM must not count as gone")
	}
}

func TestRouteEntriesKeepsMainUnicastOnly(t *testing.T) {
	msgs := []rtnetlink.RouteMessage{
		{ // default via gateway in the main table
			Family: unix.AF_INET, DstLength: 0, Table: unix.RT_TABLE_MAIN, Type: unix.RTN_UNICAST,
			Attributes: rtnetlink.RouteAttributes{Gateway: net.IP{10, 77, 42, 1}, OutIface: 2},
		},
		{ // connected route, no destination attribute
			Family: unix.AF_INET, DstLength: 24, Table: unix.RT_TABLE_MAIN, Type: unix.RTN_UNICAST,
			Attributes: rtnetlink.RouteAttributes{Dst: net.IP{10, 77, 42, 0}, OutIface: 2, Priority: 0},
		},
		{ // local table: not ours to choose from
			Family: unix.AF_INET, DstLength: 32, Table: unix.RT_TABLE_LOCAL, Type: unix.RTN_LOCAL,
			Attributes: rtnetlink.RouteAttributes{Dst: net.IP{10, 77, 42, 20}, OutIface: 1},
		},
		{ // a table number above 255 travels in the attribute
			Family: unix.AF_INET, DstLength: 8, Table: 0, Type: unix.RTN_UNICAST,
			Attributes: rtnetlink.RouteAttributes{Dst: net.IP{10, 0, 0, 0}, Table: unix.RT_TABLE_LOCAL, OutIface: 1},
		},
		{ // IPv6 default
			Family: unix.AF_INET6, DstLength: 0, Table: unix.RT_TABLE_MAIN, Type: unix.RTN_UNICAST,
			Attributes: rtnetlink.RouteAttributes{Gateway: net.ParseIP("fe80::1"), OutIface: 2},
		},
	}
	got := routeEntries(msgs)
	if len(got) != 3 {
		t.Fatalf("routeEntries kept %d routes, want 3: %+v", len(got), got)
	}
	if got[0].Dst != netip.MustParsePrefix("0.0.0.0/0") || got[0].Gateway != netip.MustParseAddr("10.77.42.1") || got[0].OutIf != 2 {
		t.Errorf("default route = %+v", got[0])
	}
	if got[1].Dst != netip.MustParsePrefix("10.77.42.0/24") || got[1].Gateway.IsValid() {
		t.Errorf("connected route = %+v", got[1])
	}
	if got[2].Dst != netip.MustParsePrefix("::/0") || got[2].Gateway != netip.MustParseAddr("fe80::1") {
		t.Errorf("IPv6 default = %+v", got[2])
	}
}

func TestRouteMessageShape(t *testing.T) {
	m := routeMessage(netip.MustParsePrefix("10.99.0.7/24"), netip.Addr{}, 5)
	if m.DstLength != 24 || m.Table != unix.RT_TABLE_MAIN || m.Scope != unix.RT_SCOPE_LINK || m.Attributes.OutIface != 5 {
		t.Errorf("on-link route = %+v", m)
	}
	if m.Attributes.Dst.String() != "10.99.0.0" {
		t.Errorf("destination not masked: %v", m.Attributes.Dst)
	}
	if m.Attributes.Gateway != nil {
		t.Errorf("on-link route must not carry a gateway")
	}

	gw := routeMessage(netip.MustParsePrefix("0.0.0.0/0"), netip.MustParseAddr("10.77.42.1"), 2)
	if gw.Scope != unix.RT_SCOPE_UNIVERSE || gw.Attributes.Dst != nil || gw.Attributes.Gateway.String() != "10.77.42.1" {
		t.Errorf("default route via gateway = %+v", gw)
	}
}
