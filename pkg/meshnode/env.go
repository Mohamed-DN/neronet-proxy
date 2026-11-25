package meshnode

import (
	"encoding/json"
	"fmt"
	"log"
	"net/netip"
	"os"
	"strings"

	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// What the node binary reads from its environment. The node itself (Run, Start, the data plane, the
// netmap manager) reads nothing from the environment: main calls these and hands the answers over in
// Params, so that a program that embeds the node (the app) never depends on variables it did not set.

// awgParamsFromEnv reads the fallback parameter set. The error never carries the value.
func awgParamsFromEnv() (*dataplane.AWGParams, error) {
	raw := strings.TrimSpace(os.Getenv("SOVEREIGN_AWG_PARAMS"))
	if raw == "" {
		return nil, nil
	}
	var p dataplane.AWGParams
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("SOVEREIGN_AWG_PARAMS is not a parameter object (jc, jmin, jmax, s1-s4, h1-h4)")
	}
	if err := p.Validate(); err != nil {
		return nil, fmt.Errorf("SOVEREIGN_AWG_PARAMS: %w", err)
	}
	return &p, nil
}

// meshDNSEnabled reads SOVEREIGN_MESH_DNS: anything but off, false, 0 or no is on.
func meshDNSEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("SOVEREIGN_MESH_DNS"))) {
	case "off", "false", "0", "no":
		return false
	}
	return true
}

// exitDNSFromEnv is SOVEREIGN_EXIT_DNS (host:port or an address) when set and valid, the zero value
// otherwise (the node then uses the host's own resolver).
func exitDNSFromEnv() netip.AddrPort {
	if v := strings.TrimSpace(os.Getenv("SOVEREIGN_EXIT_DNS")); v != "" {
		if ap, err := netip.ParseAddrPort(v); err == nil {
			return ap
		}
		if a, err := netip.ParseAddr(v); err == nil {
			return netip.AddrPortFrom(a, 53)
		}
		log.Printf("[SOVEREIGN-NODE] SOVEREIGN_EXIT_DNS=%q is not an address; using the host's resolver", v)
	}
	return netip.AddrPort{}
}

// ExitDNSFromEnv, AWGParamsFromEnv and MeshDNSFromEnv are what the binary hands to Run.
func ExitDNSFromEnv() netip.AddrPort { return exitDNSFromEnv() }

// AWGParamsFromEnv is the fallback AmneziaWG parameter set (SOVEREIGN_AWG_PARAMS), nil if none.
func AWGParamsFromEnv() (*dataplane.AWGParams, error) { return awgParamsFromEnv() }

// MeshDNSFromEnv is whether the node answers mesh names (SOVEREIGN_MESH_DNS): anything but off is on.
func MeshDNSFromEnv() bool { return meshDNSEnabled() }
