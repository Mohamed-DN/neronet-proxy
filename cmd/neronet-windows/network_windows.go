//go:build windows
// +build windows

package main

import (
	"fmt"

	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"
)

// applyNetwork configures the Wintun adapter identified by luid: its addresses, one route
// per planned destination, and DNS servers per address family.
func applyNetwork(luid winipcfg.LUID, plan NetworkPlan) error {
	if err := luid.SetIPAddresses(plan.Addresses); err != nil {
		return fmt.Errorf("set adapter addresses: %w", err)
	}

	routes := make([]*winipcfg.RouteData, 0, len(plan.Routes))
	for _, r := range plan.Routes {
		routes = append(routes, &winipcfg.RouteData{
			Destination: r.Destination,
			NextHop:     r.NextHop,
			Metric:      0,
		})
	}
	if err := luid.SetRoutes(routes); err != nil {
		return fmt.Errorf("set routes: %w", err)
	}

	v4, v6 := dnsByFamily(plan.DNS)
	if len(v4) > 0 {
		if err := luid.SetDNS(winipcfg.AddressFamily(windows.AF_INET), v4, nil); err != nil {
			return fmt.Errorf("set IPv4 DNS: %w", err)
		}
	}
	if len(v6) > 0 {
		if err := luid.SetDNS(winipcfg.AddressFamily(windows.AF_INET6), v6, nil); err != nil {
			return fmt.Errorf("set IPv6 DNS: %w", err)
		}
	}
	return nil
}
