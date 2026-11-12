package main

import (
	"fmt"
	"log"
	"net/netip"
	"os"
	"strings"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// Exit nodes, the node's side (ADR 0032).
//
// The document names, for each client of an exit, where its internet traffic leaves:
//
//   - on the gateway, a profile device's entry carries `exit`: via "self" (the gateway
//     is the exit) or via "mesh" naming the exit node;
//   - on a mesh exit, `exit_clients` lists the devices behind the gateway that leave
//     through it.
//
// This file turns that into the data plane's EgressTable. Two things can make a chosen
// exit unusable here, and both drop the client's internet traffic rather than send it
// anywhere else: this node is the exit but its operator did not start it with
// -enable-exit, or the exit is a mesh node that is not in the peer set holding the
// default route (down, quarantined, revoked).

// SetExit records the operator's consent to be an exit and the resolver that answers
// clients' DNS. Called once, before the first document is applied.
func (m *netmapManager) SetExit(enabled bool, dns netip.AddrPort) {
	m.applyMu.Lock()
	m.exitEnabled = enabled
	m.exitDNS = dns
	m.applyMu.Unlock()
}

// exitDNSUpstream is SOVEREIGN_EXIT_DNS (host:port or an address) when set, otherwise
// the host's own resolver.
func exitDNSUpstream() (netip.AddrPort, bool) {
	if v := strings.TrimSpace(os.Getenv("SOVEREIGN_EXIT_DNS")); v != "" {
		if ap, err := netip.ParseAddrPort(v); err == nil {
			return ap, true
		}
		if a, err := netip.ParseAddr(v); err == nil {
			return netip.AddrPortFrom(a, 53), true
		}
		log.Printf("[SOVEREIGN-NODE] SOVEREIGN_EXIT_DNS=%q is not an address; using the host's resolver", v)
	}
	return dataplane.SystemResolver()
}

var (
	defaultRoute4 = netip.MustParsePrefix("0.0.0.0/0")
	defaultRoute6 = netip.MustParsePrefix("::/0")
)

// installEgress gives the data plane this node's exit clients. Callers hold applyMu.
func (m *netmapManager) installEgress(doc *control.NetmapResponse, kept []dataplane.Peer) {
	if m.setEgress == nil {
		return
	}
	table, summary := egressTable(doc, kept, m.exitEnabled)
	if err := m.setEgress(table, m.exitDNS); err != nil {
		// The previous table stays; a client keeps its old exit or none, never a new
		// path that was not checked.
		log.Printf("[SOVEREIGN-NODE] Exit: could not install the egress table: %v", err)
		return
	}
	if table.Len() > 0 {
		log.Printf("[SOVEREIGN-NODE] Exit: %s", summary)
	}
}

// egressTable builds the table and a one-line summary for the log.
func egressTable(doc *control.NetmapResponse, kept []dataplane.Peer, exitEnabled bool) (*dataplane.EgressTable, string) {
	table := dataplane.NewEgressTable()
	if doc == nil {
		return table, ""
	}

	// The mesh exit is the kept peer that holds the default route; the control plane
	// gives it to at most one peer. Every other routed prefix is a subnet behind a mesh
	// node and never internet.
	keptKeys := make(map[string]bool, len(kept))
	for _, p := range kept {
		keptKeys[normaliseKey(p.PublicKey)] = true
		for _, pfx := range p.AllowedIPs {
			if pfx == defaultRoute4 || pfx == defaultRoute6 || pfx.IsSingleIP() {
				continue
			}
			table.AddMeshRoute(pfx)
		}
	}
	meshExit := ""
	for _, p := range doc.Peers {
		if !keptKeys[normaliseKey(p.PublicKeyHex)] {
			continue
		}
		for _, raw := range p.AllowedIPs {
			if pfx, err := netip.ParsePrefix(strings.TrimSpace(raw)); err == nil && pfx == defaultRoute4 {
				meshExit = p.NodeID
			}
		}
	}

	counts := map[dataplane.EgressVia]int{}
	add := func(id string, addrs []string, via dataplane.EgressVia, allowLAN bool, rules []control.InternetRule) {
		c := &dataplane.EgressClient{ID: id, Via: via, AllowLAN: allowLAN, Rules: internetRules(rules)}
		n := 0
		for _, raw := range addrs {
			pfx, err := netip.ParsePrefix(strings.TrimSpace(raw))
			if err != nil || !pfx.IsSingleIP() {
				continue
			}
			table.AddClient(pfx.Addr(), c)
			n++
		}
		if n > 0 {
			counts[via]++
		}
	}

	// Profile devices of this gateway.
	for _, p := range doc.Peers {
		if !p.Profile || p.Exit == nil || !keptKeys[normaliseKey(p.PublicKeyHex)] {
			continue
		}
		via := dataplane.EgressNone
		switch p.Exit.Via {
		case "self":
			if exitEnabled {
				via = dataplane.EgressLocal
			}
		case "mesh":
			if p.Exit.NodeID != "" && p.Exit.NodeID == meshExit {
				via = dataplane.EgressMesh
			}
		}
		add(p.NodeID, p.AllowedIPs, via, p.Exit.AllowLAN, p.Exit.InternetRules)
	}

	// Clients behind another node that leave through this one.
	for _, c := range doc.ExitClients {
		via := dataplane.EgressNone
		if exitEnabled {
			via = dataplane.EgressLocal
		}
		add(c.NodeID, c.AllowedIPs, via, c.AllowLAN, c.InternetRules)
	}

	summary := ""
	if table.Len() > 0 {
		summary = fmt.Sprintf("%d client(s) leave from this host, %d through mesh exit %s, %d with an unusable exit (dropped)",
			counts[dataplane.EgressLocal], counts[dataplane.EgressMesh], orNone(meshExit), counts[dataplane.EgressNone])
	}
	return table, summary
}

func internetRules(in []control.InternetRule) []dataplane.InternetRule {
	out := make([]dataplane.InternetRule, 0, len(in))
	for _, r := range in {
		pfx, err := netip.ParsePrefix(strings.TrimSpace(r.CIDR))
		if err != nil {
			// A rule that cannot be read is a rule whose intent is unknown. Dropping the
			// whole destination space is the safe reading of a broken DROP and the only
			// reading of a broken ACCEPT that does not widen anything.
			out = append(out, dataplane.InternetRule{Prefix: defaultRoute4, PortHi: 65535}, dataplane.InternetRule{Prefix: defaultRoute6, PortHi: 65535})
			continue
		}
		rule := dataplane.InternetRule{Prefix: pfx.Masked(), PortLo: r.PortStart, PortHi: r.PortEnd, Accept: strings.EqualFold(r.Action, "ACCEPT")}
		if rule.PortHi == 0 && rule.PortLo == 0 {
			rule.PortHi = 65535
		}
		switch strings.ToUpper(r.Protocol) {
		case "TCP":
			rule.Proto = dataplane.ProtoTCP
		case "UDP":
			rule.Proto = dataplane.ProtoUDP
		case "ALL", "":
		default:
			// ICMP and anything else never leave through an exit; the rule names nothing.
			continue
		}
		out = append(out, rule)
	}
	return out
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}
