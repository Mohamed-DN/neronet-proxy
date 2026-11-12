package main

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/sovereign/proxy/v4/internal/derpwire"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
	"github.com/sovereign/proxy/v4/pkg/transport"
)

// documentTransports reads the installation's transport policy from a netmap.
//
// Only a document that names no policy version is legacy, and legacy means UDP. A
// version this node does not implement is a policy it cannot read: it allows
// nothing. Reading it as legacy would hand UDP back to every older node the moment
// a newer control plane denied it.
func documentTransports(doc *control.NetmapResponse) ([]string, []transport.Relay, error) {
	if doc == nil {
		return nil, nil, nil
	}
	switch doc.TransportPolicyVersion {
	case "":
		return []string{transport.UDP}, nil, nil
	case derpwire.Capability:
	default:
		return []string{}, nil, nil
	}
	allowed := transport.Intersect(transport.Built(), doc.AllowedTransports)
	if !transport.Contains(allowed, transport.DERP) {
		return allowed, nil, nil
	}
	if len(doc.RelayCandidates) > 32 {
		return nil, nil, fmt.Errorf("too many relay candidates")
	}
	seen := map[string]bool{}
	var relays []transport.Relay
	for _, r := range doc.RelayCandidates {
		if r.Capability != derpwire.Capability {
			continue
		}
		u, err := url.Parse(r.URL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || r.RelayID == "" || strings.ContainsAny(r.RelayID, " /?#:\\") || seen[r.RelayID] {
			return nil, nil, fmt.Errorf("invalid DERP relay candidate")
		}
		seen[r.RelayID] = true
		relays = append(relays, transport.Relay{Region: r.RelayID, URL: r.URL})
	}
	return allowed, relays, nil
}

func peerTransportPaths(peer control.NetmapPeer, documents ...*control.NetmapResponse) ([]transport.PathSpec, error) {
	allowed := []string{transport.UDP}
	var relays []transport.Relay
	if len(documents) > 0 && documents[0] != nil && documents[0].TransportPolicyVersion != "" {
		global, r, err := documentTransports(documents[0])
		if err != nil {
			return nil, err
		}
		allowed = transport.Intersect(global, peer.AllowedTransports)
		relays = r
	}
	var paths []transport.PathSpec
	if transport.Contains(allowed, transport.UDP) {
		for _, address := range peer.Endpoints {
			if strings.TrimSpace(address) != "" {
				paths = append(paths, transport.PathSpec{Transport: transport.UDP, Address: strings.TrimSpace(address)})
			}
		}
	}
	if transport.Contains(allowed, transport.DERP) {
		if len(peer.RelayHomes) > 2 {
			return nil, fmt.Errorf("peer advertises more than two DERP homes")
		}
		for _, home := range peer.RelayHomes {
			for _, relay := range relays {
				if home.RelayID == relay.Region {
					paths = append(paths, transport.PathSpec{Transport: transport.DERP, Address: relay.Region + "/" + normaliseKey(peer.PublicKeyHex)})
					break
				}
			}
		}
	}
	return paths, nil
}

func (h *netmapHolder) transportReport(request *control.HeartbeatRequest) {
	request.TransportReportVersion = derpwire.Capability
	request.RelayHomes = nil
	request.PeerPaths = nil
	m := h.get()
	if m == nil || m.mux == nil {
		return
	}
	now := time.Now()
	for _, id := range m.mux.RelayHomes() {
		request.RelayHomes = append(request.RelayHomes, control.RelayHome{RelayID: id, ObservedAtUnix: now.Unix()})
	}
	m.mu.Lock()
	peers := append([]control.NetmapPeer(nil), m.peers...)
	revoked := make(map[string]uint64, len(m.revoked))
	for k, v := range m.revoked {
		revoked[k] = v
	}
	failClosed := m.failClosed
	m.mu.Unlock()
	request.PeerPaths = peerPathReport(peers, revoked, failClosed, m.dev.SampleAuthenticatedPaths(), m.mux, now)
}

// pathView is what the report reads from the transport multiplexer.
type pathView interface {
	PeerPaths(key string) []string
	PeerAllows(key, address string) bool
}

// peerPathReport turns the device's authenticated WireGuard state into the heartbeat's
// peer path observations, for the peers of the current document that are not revoked.
// The handshake time and counters come from wireguard-go itself; nothing else in the
// node can say whether a peer is actually talking to it.
func peerPathReport(peers []control.NetmapPeer, revoked map[string]uint64, failClosed bool,
	statuses []dataplane.PathStatus, mux pathView, now time.Time) []control.PeerPathObservation {
	type entry struct {
		id      string
		profile bool
	}
	known := map[string]entry{}
	if !failClosed {
		for _, p := range peers {
			if _, isRevoked := revoked[normaliseKey(p.PublicKeyHex)]; !isRevoked {
				known[normaliseKey(p.PublicKeyHex)] = entry{id: p.NodeID, profile: p.Profile}
			}
		}
	}
	var out []control.PeerPathObservation
	for _, status := range statuses {
		peer, ok := known[normaliseKey(status.PublicKey)]
		if !ok {
			continue
		}
		observation := control.PeerPathObservation{PeerID: peer.id, WGRxBytes: strconv.FormatUint(status.RxBytes, 10), WGTxBytes: strconv.FormatUint(status.TxBytes, 10), State: "unknown", Reason: "waiting_for_authenticated_evidence"}
		if !status.LastHandshake.IsZero() {
			stamp := status.LastHandshake.Unix()
			observation.LastHandshakeUnix = &stamp
		}
		if peer.profile {
			// A profile device (ADR 0029) has no declared path by design: the gateway
			// answers it wherever its handshake came from. Its handshake time is what the
			// control plane reads to say whether the device is connected.
			observation.State = "profile"
			observation.Reason = ""
		} else if len(mux.PeerPaths(status.PublicKey)) == 0 {
			observation.State = "no_path"
			observation.Reason = "policy_has_no_candidate"
		} else if !status.ObservedAt.IsZero() && mux.PeerAllows(status.PublicKey, status.Endpoint) {
			observation.Transport = transport.Scheme(status.Endpoint)
			observation.ObservedAtUnix = status.ObservedAt.Unix()
			observation.State = "observed"
			observation.Reason = ""
			if observation.Transport == transport.DERP {
				address := strings.TrimPrefix(status.Endpoint, "derp://")
				observation.RelayID, _, _ = strings.Cut(address, "/")
			}
			if now.Sub(status.ObservedAt) > 60*time.Second {
				observation.State = "stale"
				observation.Reason = "observation_expired"
			}
		}
		out = append(out, observation)
	}
	return out
}
