package dataplane

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/netip"
	"os"

	"github.com/sovereign/proxy/v4/pkg/acl"
)

// SpikeConfig is the file the -spike-peers flag points at.
//
// It stands in for the netmap the control plane will serve (WP-202) and is shaped
// like it on purpose: one versioned document per node holding the local addresses
// and the complete peer set, not an incremental feed. Nothing here talks to the
// control plane; this WP adds no endpoint.
type SpikeConfig struct {
	// Version is the document version. It has the role the netmap version will
	// have: a node applies a document only when the version moves forward.
	Version uint64 `json:"version"`

	// Addresses are this node's overlay addresses, written with the prefix length
	// of the overlay range (100.64.0.4/10). They are used only when the control
	// plane assigned none, which is the case for a node started without one.
	Addresses []netip.Prefix `json:"addresses"`

	// ListenPort is the local WireGuard UDP port. Zero selects DefaultListenPort.
	ListenPort uint16 `json:"listen_port"`

	// MTU of the overlay interface. Zero selects DefaultMTU.
	MTU int `json:"mtu"`

	// EchoPort, when non-zero, starts the spike echo responder on that overlay TCP
	// port. It exists to be measured against and has no place in a production node.
	EchoPort uint16 `json:"echo_port"`

	// ProbeTarget, when set, is an overlay address this node pings periodically so
	// the measured round trip appears in its log. Spike instrumentation only.
	ProbeTarget string `json:"probe_target,omitempty"`

	// ProbeIntervalSeconds is how often ProbeTarget is pinged. Zero selects 10.
	ProbeIntervalSeconds int `json:"probe_interval_seconds,omitempty"`

	// Policy is the compiled policy the node's filter enforces while it runs on this
	// document.
	//
	// It replaces the spike's `enforce` switch, which turned the filter off. The
	// filter is now installed unconditionally, so a lab that wants to move traffic
	// has to say what it permits -- which is also the only way to measure the
	// transport with enforcement on, and ADR 0020 records that this had never been
	// measured.
	Policy *acl.CompiledPeerPolicy `json:"policy,omitempty"`

	// Peers is the complete peer set. An empty list is valid and means this node
	// talks to nobody.
	Peers []Peer `json:"peers"`
}

// LoadSpikeConfig reads and validates a spike configuration.
//
// Validation is complete before anything is returned: a document with one bad peer
// is rejected as a whole, because applying the good half of a netmap would leave the
// node in a state no operator asked for.
func LoadSpikeConfig(path string) (*SpikeConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("dataplane: reading spike peers file: %w", err)
	}
	return ParseSpikeConfig(raw)
}

// ParseSpikeConfig validates a spike configuration document.
func ParseSpikeConfig(raw []byte) (*SpikeConfig, error) {
	var cfg SpikeConfig
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("dataplane: parsing spike peers file: %w", err)
	}

	for i, p := range cfg.Peers {
		if err := p.validate(); err != nil {
			return nil, fmt.Errorf("dataplane: spike peers file, peer %d: %w", i, err)
		}
	}
	for i, a := range cfg.Addresses {
		if !a.IsValid() {
			return nil, fmt.Errorf("dataplane: spike peers file, address %d is not a valid prefix", i)
		}
	}
	if cfg.ProbeTarget != "" {
		if _, err := netip.ParseAddr(cfg.ProbeTarget); err != nil {
			return nil, fmt.Errorf("dataplane: spike peers file, probe_target %q: %w", cfg.ProbeTarget, err)
		}
	}
	return &cfg, nil
}
