package main

// Platform-independent logic for the profile client: which network state a profile
// implies, how an import source is validated, and how status is shown. Nothing here
// touches the Windows APIs, so it is unit-tested on every platform.

import (
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strings"

	"github.com/sovereign/proxy/v4/pkg/profile"
)

const (
	// profileFileName is the imported profile inside the data directory.
	profileFileName = "profile.conf"
	// maxProfileBytes bounds what import reads. A real profile is well under 1 KiB.
	maxProfileBytes = 64 << 10
)

// dataDirectory returns %ProgramData%\NeroNet, the directory holding the profile and log.
func dataDirectory() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "NeroNet")
}

// profilePath returns the location of the imported profile inside dataDir.
func profilePath(dataDir string) string {
	return filepath.Join(dataDir, profileFileName)
}

// checkImportSource validates a profile source before it is read: it must be a regular
// file with a .conf extension (a wg-quick file) and a plausible size.
func checkImportSource(path string, regular bool, size int64) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("import: no profile path given")
	}
	if !strings.EqualFold(filepath.Ext(path), ".conf") {
		return fmt.Errorf("import: %s is not a .conf profile", path)
	}
	if !regular {
		return fmt.Errorf("import: %s is not a regular file", path)
	}
	if size <= 0 {
		return fmt.Errorf("import: %s is empty", path)
	}
	if size > maxProfileBytes {
		return fmt.Errorf("import: %s is %d bytes; a profile must be at most %d", path, size, maxProfileBytes)
	}
	return nil
}

// loadProfile parses the profile at path. Errors never include key material.
func loadProfile(path string) (*profile.Profile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return profile.Parse(f)
}

// PlannedRoute is one route to install on the tunnel adapter.
type PlannedRoute struct {
	Destination netip.Prefix
	NextHop     netip.Addr
}

// NetworkPlan is the adapter configuration a profile implies.
type NetworkPlan struct {
	Addresses []netip.Prefix
	Routes    []PlannedRoute
	DNS       []netip.Addr
	MTU       int // 0 means the default
}

// planNetwork derives addresses, routes (one per AllowedIPs entry, deduplicated after
// masking) and DNS from a profile. Default routes are refused in this version: a full
// tunnel also routes the gateway's own endpoint into the tunnel, which needs a bypass route
// this client does not install yet.
func planNetwork(p *profile.Profile) (NetworkPlan, error) {
	if len(p.Addresses) == 0 {
		return NetworkPlan{}, errors.New("profile: [Interface] has no Address")
	}
	plan := NetworkPlan{
		Addresses: append([]netip.Prefix(nil), p.Addresses...),
		DNS:       append([]netip.Addr(nil), p.DNS...),
		MTU:       p.MTU,
	}
	seen := map[netip.Prefix]bool{}
	for _, peer := range p.Peers {
		for _, allowed := range peer.AllowedIPs {
			dst := allowed.Masked()
			if dst.Bits() == 0 {
				return NetworkPlan{}, fmt.Errorf("profile: AllowedIPs %s is a default route; full-tunnel profiles are not supported yet", allowed)
			}
			if seen[dst] {
				continue
			}
			seen[dst] = true
			plan.Routes = append(plan.Routes, PlannedRoute{Destination: dst, NextHop: onLinkNextHop(dst.Addr())})
		}
	}
	return plan, nil
}

// onLinkNextHop is the next hop that means "directly on the adapter" for a family.
func onLinkNextHop(addr netip.Addr) netip.Addr {
	if addr.Is4() {
		return netip.IPv4Unspecified()
	}
	return netip.IPv6Unspecified()
}

// dnsByFamily splits DNS servers into IPv4 and IPv6, since the adapter takes them per family.
func dnsByFamily(addrs []netip.Addr) (v4, v6 []netip.Addr) {
	for _, a := range addrs {
		if a.Is4() {
			v4 = append(v4, a)
		} else {
			v6 = append(v6, a)
		}
	}
	return v4, v6
}

// statusReport is what `status` prints. Profile is nil when no profile was loaded.
type statusReport struct {
	Service    string
	Profile    *profile.Profile
	ProfileErr error
}

// formatStatus renders the status without secrets: profile.String() carries no key
// material, and the private key is never printed.
func formatStatus(r statusReport) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Service:  %s\n", r.Service)
	switch {
	case r.Profile != nil:
		fmt.Fprintf(&b, "Profile:  %s\n", r.Profile.String())
		if r.Profile.ConsoleURL != "" {
			fmt.Fprintf(&b, "Console:  %s\n", r.Profile.ConsoleURL)
		}
	case r.ProfileErr != nil:
		fmt.Fprintf(&b, "Profile:  unreadable: %v\n", r.ProfileErr)
	default:
		b.WriteString("Profile:  none (import one with: neronet-windows import <profile.conf>)\n")
	}
	return b.String()
}
