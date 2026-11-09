package main

// Interface, address and route configuration over netlink. No `ip` binary is run.

import (
	"errors"
	"fmt"
	"net"
	"net/netip"

	"github.com/jsimonetti/rtnetlink"
	"golang.org/x/sys/unix"
)

// gone reports whether a netlink error means "the thing is already not there", which makes a
// removal idempotent.
func gone(err error) bool {
	return errors.Is(err, unix.ESRCH) || errors.Is(err, unix.ENOENT) ||
		errors.Is(err, unix.ENODEV) || errors.Is(err, unix.EADDRNOTAVAIL)
}

func linkIndex(name string) (uint32, error) {
	ifi, err := net.InterfaceByName(name)
	if err != nil {
		return 0, err
	}
	return uint32(ifi.Index), nil
}

func linkName(idx uint32) (string, error) {
	ifi, err := net.InterfaceByIndex(int(idx))
	if err != nil {
		return "", err
	}
	return ifi.Name, nil
}

// linkUp sets the MTU and brings the interface up.
func linkUp(c *rtnetlink.Conn, idx uint32, mtu int) error {
	err := c.Link.Set(&rtnetlink.LinkMessage{
		Family:     unix.AF_UNSPEC,
		Index:      idx,
		Flags:      unix.IFF_UP,
		Change:     unix.IFF_UP,
		Attributes: &rtnetlink.LinkAttributes{MTU: uint32(mtu)},
	})
	if err != nil {
		return fmt.Errorf("bringing the link up: %w", err)
	}
	return nil
}

// addAddress gives the interface an address with its prefix length, so the connected route
// for the whole overlay prefix exists (a /32 alone would never receive traffic for its peers).
func addAddress(c *rtnetlink.Conn, idx uint32, p netip.Prefix) error {
	family := uint8(unix.AF_INET)
	if p.Addr().Is6() {
		family = unix.AF_INET6
	}
	ip := net.IP(p.Addr().AsSlice())
	err := c.Address.New(&rtnetlink.AddressMessage{
		Family:       family,
		PrefixLength: uint8(p.Bits()),
		Index:        idx,
		Attributes:   &rtnetlink.AddressAttributes{Address: ip, Local: ip},
	})
	if err != nil {
		return fmt.Errorf("adding address %s: %w", p, err)
	}
	return nil
}

// routeMessage builds a main-table unicast route for p. An invalid via makes it on-link.
func routeMessage(p netip.Prefix, via netip.Addr, dev uint32) *rtnetlink.RouteMessage {
	family := uint8(unix.AF_INET)
	if p.Addr().Is6() {
		family = unix.AF_INET6
	}
	m := &rtnetlink.RouteMessage{
		Family:    family,
		DstLength: uint8(p.Bits()),
		Table:     unix.RT_TABLE_MAIN,
		Protocol:  unix.RTPROT_STATIC,
		Type:      unix.RTN_UNICAST,
		Scope:     unix.RT_SCOPE_LINK,
	}
	if p.Bits() != 0 {
		m.Attributes.Dst = net.IP(p.Masked().Addr().AsSlice())
	}
	m.Attributes.OutIface = dev
	if via.IsValid() {
		m.Scope = unix.RT_SCOPE_UNIVERSE
		m.Attributes.Gateway = net.IP(via.AsSlice())
	}
	return m
}

func addRoute(c *rtnetlink.Conn, p netip.Prefix, via netip.Addr, dev uint32) error {
	if err := c.Route.Add(routeMessage(p, via, dev)); err != nil {
		return fmt.Errorf("adding route %s: %w", p, err)
	}
	return nil
}

// delRoute removes a route; a route that is already gone is not an error.
func delRoute(c *rtnetlink.Conn, p netip.Prefix, via netip.Addr, dev uint32) error {
	err := c.Route.Delete(routeMessage(p, via, dev))
	if err != nil && !gone(err) {
		return fmt.Errorf("removing route %s: %w", p, err)
	}
	return nil
}

// listRoutes returns the main-table routes the kernel currently has.
func listRoutes(c *rtnetlink.Conn) ([]routeEntry, error) {
	msgs, err := c.Route.List()
	if err != nil {
		return nil, fmt.Errorf("listing routes: %w", err)
	}
	return routeEntries(msgs), nil
}

// routeEntries converts kernel route messages to routeEntry, keeping unicast routes of the
// main table only.
func routeEntries(msgs []rtnetlink.RouteMessage) []routeEntry {
	var out []routeEntry
	for _, m := range msgs {
		table := uint32(m.Table)
		if m.Attributes.Table != 0 {
			table = m.Attributes.Table
		}
		if table != unix.RT_TABLE_MAIN || m.Type != unix.RTN_UNICAST {
			continue
		}
		dst := netip.IPv4Unspecified()
		if m.Family == unix.AF_INET6 {
			dst = netip.IPv6Unspecified()
		}
		if m.Attributes.Dst != nil {
			a, ok := netip.AddrFromSlice(m.Attributes.Dst)
			if !ok {
				continue
			}
			dst = a.Unmap()
		}
		pfx, err := dst.Prefix(int(m.DstLength))
		if err != nil {
			continue
		}
		e := routeEntry{Dst: pfx, OutIf: m.Attributes.OutIface, Priority: m.Attributes.Priority}
		if m.Attributes.Gateway != nil {
			if gw, ok := netip.AddrFromSlice(m.Attributes.Gateway); ok {
				e.Gateway = gw.Unmap()
			}
		}
		out = append(out, e)
	}
	return out
}

// deleteLink removes an interface by index; a link that is already gone is not an error.
func deleteLink(c *rtnetlink.Conn, idx uint32) error {
	err := c.Link.Delete(idx)
	if err != nil && !gone(err) {
		return fmt.Errorf("deleting the interface: %w", err)
	}
	return nil
}
