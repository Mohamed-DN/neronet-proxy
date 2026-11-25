package meshnode

import (
	"log"
	"net/netip"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
	"github.com/sovereign/proxy/v4/pkg/dns"
)

// Mesh names for profile devices (ADR 0034). A gateway that serves at least one profile
// device answers mesh names at 100.100.100.100:53 in its userspace stack, from the
// names the console puts in the netmap. It is on by default; SOVEREIGN_MESH_DNS=off
// restores the exit-only behaviour exactly.

// SetMeshDNS records whether this node answers mesh names and the resolver that
// answers everything else. Called once, before the first document is applied.
func (m *netmapManager) SetMeshDNS(enabled bool, upstream netip.AddrPort) {
	m.applyMu.Lock()
	m.meshDNSEnabled = enabled
	m.meshDNSUpstream = upstream
	m.applyMu.Unlock()
}

// NamesSink is told the mesh names of the netmap in force: the document and the peers that are kept
// (a revoked or dropped peer is not among them). It is called with nil and no peers when the netmap
// goes stale, so that whoever resolves names for a computer stops answering from a document that no
// longer holds.
type NamesSink func(doc *control.NetmapResponse, peers []control.NetmapPeer)

// SetNamesSink hands the names of every applied netmap to sink. It is independent of SetMeshDNS: a node
// that resolves names for its own computer serves no device and answers none for others.
func (m *netmapManager) SetNamesSink(sink NamesSink) {
	m.applyMu.Lock()
	m.namesSink = sink
	m.applyMu.Unlock()
}

// installMeshDNS gives the data plane the names of the document's peers. A node that
// serves no profile device, or has the feature off, installs none, which removes the
// resolver. Callers hold applyMu.
func (m *netmapManager) installMeshDNS(doc *control.NetmapResponse, kept []dataplane.Peer) {
	m.tellNamesSink(doc, kept)
	if m.setMeshDNS == nil {
		return
	}
	keptKeys := make(map[string]bool, len(kept))
	serves := false
	for _, p := range kept {
		keptKeys[normaliseKey(p.PublicKey)] = true
		serves = serves || p.Profile
	}
	serves = serves || len(m.vless.served) > 0
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

func (m *netmapManager) tellNamesSink(doc *control.NetmapResponse, kept []dataplane.Peer) {
	if m.namesSink == nil {
		return
	}
	if doc == nil {
		m.namesSink(nil, nil)
		return
	}
	keptKeys := make(map[string]bool, len(kept))
	for _, p := range kept {
		keptKeys[normaliseKey(p.PublicKey)] = true
	}
	peers := make([]control.NetmapPeer, 0, len(doc.Peers))
	for _, p := range doc.Peers {
		if keptKeys[normaliseKey(p.PublicKeyHex)] {
			peers = append(peers, p)
		}
	}
	m.namesSink(doc, peers)
}
