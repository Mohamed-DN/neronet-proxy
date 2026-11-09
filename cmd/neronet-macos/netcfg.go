package main

import (
	"net/netip"
	"strconv"
)

// Absolute paths: launchd's PATH is minimal, and these two commands are part of macOS itself.
const (
	ifconfigBin = "/sbin/ifconfig"
	routeBin    = "/sbin/route"
)

// ifconfigArgs returns the argv lists that give iface its addresses, set its MTU and bring it
// up. Addresses are added with "alias" so that a second address does not replace the first.
// Each argv[0] is an absolute path, ready for exec.
func ifconfigArgs(iface string, addrs []netip.Prefix, mtu int) [][]string {
	var cmds [][]string
	for _, p := range addrs {
		a := p.Addr()
		if a.Is4() {
			cmds = append(cmds, []string{ifconfigBin, iface, "inet", a.String(), a.String(),
				"netmask", v4Netmask(p.Bits()), "alias"})
		} else {
			cmds = append(cmds, []string{ifconfigBin, iface, "inet6", a.String(),
				"prefixlen", strconv.Itoa(p.Bits()), "alias"})
		}
	}
	return append(cmds, []string{ifconfigBin, iface, "mtu", strconv.Itoa(mtu), "up"})
}

// v4Netmask renders an IPv4 prefix length as the dotted mask ifconfig expects.
func v4Netmask(bits int) string {
	m := uint32(0xffffffff) << (32 - bits)
	return netip.AddrFrom4([4]byte{byte(m >> 24), byte(m >> 16), byte(m >> 8), byte(m)}).String()
}

// routeAddArgs sends prefix into the interface iface.
func routeAddArgs(prefix netip.Prefix, iface string) []string {
	return routeArgs("add", prefix, iface)
}

// routeDelArgs removes the route added by routeAddArgs.
func routeDelArgs(prefix netip.Prefix, iface string) []string {
	return routeArgs("delete", prefix, iface)
}

func routeArgs(action string, prefix netip.Prefix, iface string) []string {
	argv := []string{routeBin, "-n", action}
	if prefix.Addr().Is6() {
		argv = append(argv, "-inet6")
	}
	return append(argv, "-net", prefix.Masked().String(), "-interface", iface)
}

// endpointRouted reports whether a peer's endpoint would itself be sent into the tunnel by
// one of the allowed prefixes. Such a profile would loop its own handshake packets, so it is
// refused: a full-tunnel profile needs a bypass route for the endpoint, which v0 does not add.
func endpointRouted(endpoint netip.Addr, allowed []netip.Prefix) bool {
	for _, p := range allowed {
		if p.Contains(endpoint) {
			return true
		}
	}
	return false
}
