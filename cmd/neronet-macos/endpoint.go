package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"strconv"
)

// resolveEndpoint turns a profile's "host:port" into the "ip:port" that wireguard-go's UAPI
// takes. It runs before the tunnel exists, so it uses the system resolver. IPv4 is preferred.
func resolveEndpoint(ctx context.Context, endpoint string) (netip.AddrPort, error) {
	host, portStr, err := net.SplitHostPort(endpoint)
	if err != nil {
		return netip.AddrPort{}, fmt.Errorf("endpoint %q: %w", endpoint, err)
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil || port == 0 {
		return netip.AddrPort{}, fmt.Errorf("endpoint %q: bad port", endpoint)
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return netip.AddrPortFrom(ip, uint16(port)), nil
	}
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return netip.AddrPort{}, fmt.Errorf("resolve %s: %w", host, err)
	}
	if len(addrs) == 0 {
		return netip.AddrPort{}, fmt.Errorf("resolve %s: no address", host)
	}
	chosen := addrs[0]
	for _, a := range addrs {
		if a.Is4() {
			chosen = a
			break
		}
	}
	return netip.AddrPortFrom(chosen, uint16(port)), nil
}
