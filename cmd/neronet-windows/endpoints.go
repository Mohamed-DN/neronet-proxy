package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"strconv"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

// lookupFunc resolves a host name. It is a parameter so tests need no network.
type lookupFunc func(ctx context.Context, host string) ([]netip.Addr, error)

// resolveEndpoints turns each peer's Endpoint into the "ip:port" form wireguard-go expects.
// Literal addresses are used as they are; host names are resolved and IPv4 is preferred.
// A peer without an Endpoint gets "" (left unset, as profile.UAPI expects).
func resolveEndpoints(ctx context.Context, lookup lookupFunc, peers []profile.Peer) ([]string, error) {
	out := make([]string, len(peers))
	for i, peer := range peers {
		if peer.Endpoint == "" {
			continue
		}
		host, portStr, err := net.SplitHostPort(peer.Endpoint)
		if err != nil {
			return nil, fmt.Errorf("peer %d: endpoint %q: %v", i+1, peer.Endpoint, err)
		}
		port, err := parsePort(portStr)
		if err != nil {
			return nil, fmt.Errorf("peer %d: endpoint %q: %v", i+1, peer.Endpoint, err)
		}
		addr, err := netip.ParseAddr(host)
		if err != nil {
			addrs, lerr := lookup(ctx, host)
			if lerr != nil {
				return nil, fmt.Errorf("peer %d: resolve %s: %w", i+1, host, lerr)
			}
			addr, err = pickAddr(addrs)
			if err != nil {
				return nil, fmt.Errorf("peer %d: resolve %s: %w", i+1, host, err)
			}
		}
		out[i] = netip.AddrPortFrom(addr, port).String()
	}
	return out, nil
}

func parsePort(s string) (uint16, error) {
	port, err := strconv.ParseUint(s, 10, 16)
	if err != nil || port < 1 {
		return 0, fmt.Errorf("bad port %q", s)
	}
	return uint16(port), nil
}

// pickAddr prefers the first IPv4 address, then the first IPv6 address.
func pickAddr(addrs []netip.Addr) (netip.Addr, error) {
	var v6 netip.Addr
	for _, a := range addrs {
		if a.Is4() {
			return a, nil
		}
		if !v6.IsValid() && a.IsValid() {
			v6 = a
		}
	}
	if !v6.IsValid() {
		return netip.Addr{}, fmt.Errorf("no addresses")
	}
	return v6, nil
}
