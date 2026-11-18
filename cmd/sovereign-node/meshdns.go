package main

import (
	"log"
	"net/netip"
	"os"
	"strings"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
	"github.com/sovereign/proxy/v4/pkg/dns"
)

// Mesh names for profile devices (ADR 0034). A gateway that serves at least one profile
// device answers mesh names at 100.100.100.100:53 in its userspace stack, from the
// names the console puts in the netmap. It is on by default; SOVEREIGN_MESH_DNS=off
// restores the exit-only behaviour exactly.

// meshDNSEnabled reads SOVEREIGN_MESH_DNS: anything but off, false, 0 or no is on.
func meshDNSEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("SOVEREIGN_MESH_DNS"))) {
	case "off", "false", "0", "no":
		return false
	}
	return true
}

// SetMeshDNS records whether this node answers mesh names and the resolver that
// answers everything else. Called once, before the first document is applied.
func (m *netmapManager) SetMeshDNS(enabled bool, upstream netip.AddrPort) {
	m.applyMu.Lock()
	m.meshDNSEnabled = enabled
	m.meshDNSUpstream = upstream
	m.applyMu.Unlock()
}

// installMeshDNS gives the data plane the names of the document's peers. A node that
// serves no profile device, or has the feature off, installs none, which removes the
// resolver. Callers hold applyMu.
func (m *netmapManager) installMeshDNS(doc *control.NetmapResponse, kept []dataplane.Peer) {
	if m.setMeshDNS == nil {
		return
	}
	keptKeys := make(map[string]bool, len(kept))
	serves := false
	for _, p := range kept {
		keptKeys[normaliseKey(p.PublicKey)] = true
		serves = serves || p.Profile
	}
	if !m.meshDNSEnabled || !serves || doc == nil {
		if err := m.setMeshDNS(nil); err != nil {
			log.Printf("[SOVEREIGN-NODE] Mesh names: could not remove the resolver: %v", err)
		}
		return
	}
	// A revoked or dropped peer's name does not resolve.
	peers := make([]control.NetmapPeer, 0, len(doc.Peers))
	for _, p := range doc.Peers {
		if keptKeys[normaliseKey(p.PublicKeyHex)] {
			peers = append(peers, p)
		}
	}
	if m.names == nil {
		m.names = dns.NewServer(dns.Config{SingleAnswer: true})
	}
	m.names.UpdateNetmap(doc.Self, peers, doc.DNS)
	if err := m.setMeshDNS(&dataplane.MeshDNS{Answer: m.names.AnswerFor, AnswerExit: m.names.AnswerForExit, Upstream: m.meshDNSUpstream}); err != nil {
		// The names stop resolving; nothing that carries traffic depends on them.
		log.Printf("[SOVEREIGN-NODE] Mesh names: could not install the resolver: %v", err)
	}
}
