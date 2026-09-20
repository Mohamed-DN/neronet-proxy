package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
	"github.com/sovereign/proxy/v4/pkg/nat"
)

// The node's side of the netmap.
//
// Three rules decide everything here:
//
//  1. **Default deny before the first netmap.** The enforcement filter is installed
//     when the device comes up, and pkg/acl with no policy loaded drops every packet.
//     A node that cannot reach the control plane and has no usable stored document
//     moves nothing.
//  2. **The document is applied whole or not at all.** It is converted and validated
//     before the device is touched, so a malformed peer leaves the previous peer set
//     in place rather than tearing the overlay down halfway through.
//  3. **Fail-static, then fail-closed.** With the control plane unreachable the node
//     keeps what it has until the document's age passes max_staleness_seconds, and
//     then removes every peer. Revocations are applied the moment they are seen,
//     whatever else is happening.

// netmapFileName is the persisted document, kept next to the identity key.
const netmapFileName = "netmap.json"

// persistedNetmap is what lands on disk. The fetch time is recorded because a
// control plane that never sets generated_at_unix would otherwise leave the node
// with no way to age the document at all.
type persistedNetmap struct {
	FetchedAtUnix int64                   `json:"fetched_at_unix"`
	Netmap        *control.NetmapResponse `json:"netmap"`
}

// netmapManager owns the peer set and the policy the filter enforces.
type netmapManager struct {
	client    *control.Client
	dev       *dataplane.Device
	netfilter *acl.NetstackFilter
	path      string

	// listenPort is the local WireGuard port, reported as part of this node's
	// candidate endpoints.
	listenPort uint16

	// stunServer, when set, is asked for this node's reflexive address.
	stunServer string

	mu sync.Mutex
	// version is the version of the document currently applied. Zero means none has
	// been applied and the node is at default deny.
	version uint64
	peers   []control.NetmapPeer
	// documentAt is the moment the applied document describes: the control plane's
	// generated_at when it set one, otherwise when this node fetched it.
	documentAt time.Time
	// maxStaleness is the bound the applied document carries, in seconds. Zero means
	// the control plane set none and the node never fails closed on age.
	maxStaleness int64
	// failClosed records that staleness has already emptied the peer set, so the
	// node says so once rather than on every tick.
	failClosed bool
	revoked    map[string]bool
}

// netmapHolder lets the heartbeat loop reach a manager that is constructed after it.
//
// The loop starts as soon as registration succeeds and the data plane comes up after,
// because it needs the overlay addresses that registration returned. Both touch the
// manager, so the handover is guarded rather than assumed.
type netmapHolder struct {
	mu sync.RWMutex
	m  *netmapManager
}

func (h *netmapHolder) set(m *netmapManager) {
	h.mu.Lock()
	h.m = m
	h.mu.Unlock()
}

func (h *netmapHolder) get() *netmapManager {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.m
}

// endpoints reports this node's candidate addresses, or nothing when there is no data
// plane to report a port for.
func (h *netmapHolder) endpoints() []control.EndpointDesc {
	m := h.get()
	if m == nil {
		return nil
	}
	return m.Endpoints()
}

// onHeartbeat reacts to one heartbeat response: revocations first, then a fetch if
// the control plane holds a newer version.
func (h *netmapHolder) onHeartbeat(ctx context.Context, nodeID string, resp *control.HeartbeatResponse) {
	m := h.get()
	if m == nil || resp == nil {
		return
	}

	if len(resp.RevokedKeys) > 0 {
		m.ApplyRevocations(resp.RevokedKeys)
	}

	if resp.NetmapVersion > m.Version() {
		fetchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := m.Fetch(fetchCtx, nodeID)
		cancel()
		if err != nil {
			log.Printf("[SOVEREIGN-NODE] Netmap fetch failed: %v (keeping version %d)", err, m.Version())
		}
	}
}

// netmapPathFor puts the stored document next to the identity key, which is the one
// directory a node is guaranteed to be able to write.
func netmapPathFor(identityPath string) string {
	if identityPath == "" {
		return netmapFileName
	}
	return filepath.Join(filepath.Dir(identityPath), netmapFileName)
}

func newNetmapManager(
	client *control.Client,
	dev *dataplane.Device,
	netfilter *acl.NetstackFilter,
	identityPath string,
	listenPort uint16,
	stunServer string,
) *netmapManager {
	return &netmapManager{
		client:     client,
		dev:        dev,
		netfilter:  netfilter,
		path:       netmapPathFor(identityPath),
		listenPort: listenPort,
		stunServer: stunServer,
		revoked:    make(map[string]bool),
	}
}

// Version reports the version currently applied.
func (m *netmapManager) Version() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.version
}

// Fetch asks the control plane for a document and applies it.
//
// An unchanged answer is not an error and changes nothing. A fetch that fails leaves
// the node on what it already holds: that is the fail-static behaviour, and it is why
// the error is returned rather than acted on.
func (m *netmapManager) Fetch(ctx context.Context, nodeID string) error {
	netmap, err := m.client.Netmap(ctx, nodeID, m.Version())
	if err != nil {
		return err
	}
	if netmap.Unchanged {
		return nil
	}
	return m.Apply(netmap, time.Now())
}

// Apply installs a document. The conversion happens before the device is touched.
func (m *netmapManager) Apply(netmap *control.NetmapResponse, fetchedAt time.Time) error {
	if netmap == nil {
		return errors.New("netmap: nil document")
	}

	m.mu.Lock()
	revoked := make(map[string]bool, len(m.revoked))
	for k := range m.revoked {
		revoked[k] = true
	}
	m.mu.Unlock()

	for _, key := range netmap.RevokedKeys {
		revoked[normaliseKey(key)] = true
	}

	peers, dropped, err := netmapPeers(netmap.Peers, revoked)
	if err != nil {
		return err
	}

	if err := m.dev.SetPeers(peers); err != nil {
		return err
	}

	// The filter is what decides whether a packet passes; the peer set only decides
	// whether it can be carried. A netmap that named a peer the policy denies would
	// still move nothing, because this is the policy the filter enforces.
	m.netfilter.UpdatePolicy(netmap.ACL)

	m.mu.Lock()
	m.version = netmap.Version
	m.peers = netmap.Peers
	m.documentAt = documentTime(netmap, fetchedAt)
	m.maxStaleness = netmap.MaxStalenessSeconds
	m.failClosed = false
	m.revoked = revoked
	m.mu.Unlock()

	log.Printf("[SOVEREIGN-NODE] Netmap version %d applied: %d peer(s)%s, policy %s, routes %d, staleness bound %ds",
		netmap.Version, len(peers), droppedNote(dropped), policyNote(netmap.ACL), len(netmap.Routes), netmap.MaxStalenessSeconds)

	if err := m.persist(netmap, fetchedAt); err != nil {
		// Persistence is what lets the node come back without a control plane. Losing
		// it costs that and nothing else, so it is reported and not fatal.
		log.Printf("[SOVEREIGN-NODE] Could not persist the netmap to %s: %v", m.path, err)
	}

	return nil
}

// ApplyRevocations removes revoked peers at once, without waiting for a new document.
//
// A revocation is the one update that cannot wait for a version to advance: the point
// of revoking a key is that the tunnel it holds open stops now.
func (m *netmapManager) ApplyRevocations(keys []string) {
	m.mu.Lock()
	newly := 0
	for _, key := range keys {
		k := normaliseKey(key)
		if k == "" || m.revoked[k] {
			continue
		}
		m.revoked[k] = true
		newly++
	}
	if newly == 0 {
		m.mu.Unlock()
		return
	}
	revoked := make(map[string]bool, len(m.revoked))
	for k := range m.revoked {
		revoked[k] = true
	}
	current := m.peers
	m.mu.Unlock()

	peers, dropped, err := netmapPeers(current, revoked)
	if err != nil {
		log.Printf("[SOVEREIGN-NODE] Could not rebuild the peer set after a revocation: %v", err)
		return
	}
	if err := m.dev.SetPeers(peers); err != nil {
		log.Printf("[SOVEREIGN-NODE] Could not apply %d revocation(s) to the data plane: %v", newly, err)
		return
	}

	log.Printf("[SOVEREIGN-NODE] %d peer key(s) revoked: %d peer(s) remain%s", newly, len(peers), droppedNote(dropped))
}

// EnforceStaleness removes every peer once the applied document is older than the
// bound the control plane set. It reports whether it changed anything.
func (m *netmapManager) EnforceStaleness(now time.Time) bool {
	m.mu.Lock()
	netmapMaxAge := m.stalenessLocked()
	if m.version == 0 || m.failClosed || m.documentAt.IsZero() || netmapMaxAge <= 0 {
		m.mu.Unlock()
		return false
	}
	age := now.Sub(m.documentAt)
	if age < netmapMaxAge {
		m.mu.Unlock()
		return false
	}
	m.failClosed = true
	m.mu.Unlock()

	if err := m.dev.SetPeers(nil); err != nil {
		log.Printf("[SOVEREIGN-NODE] Could not remove peers after the netmap went stale: %v", err)
		return false
	}

	log.Printf("[SOVEREIGN-NODE] Netmap is %s old, past the %s staleness bound: every peer removed (fail-closed)",
		age.Round(time.Second), netmapMaxAge)
	return true
}

// StalenessBound is the bound the applied document carries, or zero when no document
// has been applied.
func (m *netmapManager) StalenessBound() time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stalenessLocked()
}

func (m *netmapManager) stalenessLocked() time.Duration {
	if m.maxStaleness <= 0 {
		return 0
	}
	return time.Duration(m.maxStaleness) * time.Second
}

// WatchStaleness checks the applied document's age until the context ends.
//
// A separate loop rather than a check on the heartbeat, because the case it exists for
// is precisely the one where no heartbeat is coming back.
func (m *netmapManager) WatchStaleness(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 10 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			m.EnforceStaleness(now)
		}
	}
}

// readPersistedNetmap reads the stored document without applying it.
//
// Separate from LoadPersisted because the device has to be built before a document can
// be applied, and the device's MTU and listen port come out of the document: the
// caller needs to look before it can act.
func readPersistedNetmap(path string) (*persistedNetmap, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var stored persistedNetmap
	if err := json.Unmarshal(raw, &stored); err != nil {
		return nil, fmt.Errorf("stored netmap at %s is not readable: %w", path, err)
	}
	if stored.Netmap == nil {
		return nil, fmt.Errorf("stored netmap at %s carries no document", path)
	}
	return &stored, nil
}

// LoadPersisted applies the stored document when it is still inside its staleness
// bound.
//
// This is what a node restarted with the control plane down comes up on. A document
// that is too old, unreadable or absent leaves the node at default deny, which is the
// only safe answer: an expired peer set is a peer set the operator may have revoked.
func (m *netmapManager) LoadPersisted(now time.Time) (bool, error) {
	stored, err := readPersistedNetmap(m.path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}

	fetchedAt := time.Unix(stored.FetchedAtUnix, 0)
	at := documentTime(stored.Netmap, fetchedAt)
	bound := time.Duration(stored.Netmap.MaxStalenessSeconds) * time.Second
	age := now.Sub(at)

	if bound > 0 && age >= bound {
		log.Printf("[SOVEREIGN-NODE] Stored netmap is %s old, past its %s bound: staying at default deny",
			age.Round(time.Second), bound)
		return false, nil
	}

	if err := m.Apply(stored.Netmap, fetchedAt); err != nil {
		return false, err
	}

	log.Printf("[SOVEREIGN-NODE] Loaded the stored netmap from %s (version %d, age %s)",
		m.path, stored.Netmap.Version, age.Round(time.Second))
	return true, nil
}

// persist writes the document with mode 0600, next to the identity key.
//
// Through a temporary file and a rename, so an interrupted write cannot leave a
// half-written document that the next start would read as the fleet's peer set.
func (m *netmapManager) persist(netmap *control.NetmapResponse, fetchedAt time.Time) error {
	raw, err := json.Marshal(persistedNetmap{FetchedAtUnix: fetchedAt.Unix(), Netmap: netmap})
	if err != nil {
		return err
	}

	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, m.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Endpoints reports this node's candidate addresses for the heartbeat.
func (m *netmapManager) Endpoints() []control.EndpointDesc {
	return discoverEndpoints(m.listenPort, m.stunServer)
}

// --- Conversion --------------------------------------------------------------

func normaliseKey(key string) string {
	return strings.ToLower(strings.TrimSpace(key))
}

// netmapPeers converts the document's peers into device peers.
//
// It returns the peers it dropped rather than silently omitting them: a revoked peer
// and a malformed one mean very different things, and a node that quietly carries
// fewer peers than the control plane sent is a node nobody can debug.
func netmapPeers(in []control.NetmapPeer, revoked map[string]bool) (peers []dataplane.Peer, dropped []string, err error) {
	for i, p := range in {
		key := normaliseKey(p.PublicKeyHex)
		if revoked[key] {
			dropped = append(dropped, fmt.Sprintf("%s revoked", p.NodeID))
			continue
		}

		allowed := make([]netip.Prefix, 0, len(p.AllowedIPs))
		for _, raw := range p.AllowedIPs {
			prefix, parseErr := netip.ParsePrefix(strings.TrimSpace(raw))
			if parseErr != nil {
				return nil, nil, fmt.Errorf("netmap peer %d (%s): allowed ip %q: %w", i, p.NodeID, raw, parseErr)
			}
			allowed = append(allowed, prefix)
		}

		// WireGuard holds one endpoint per peer and learns a better one from the
		// first packet it receives. The first candidate is the one to try; the rest
		// exist for a coordinator that does not yet exist (WP-204).
		endpoint := ""
		for _, candidate := range p.Endpoints {
			candidate = strings.TrimSpace(candidate)
			if candidate == "" {
				continue
			}
			if _, _, splitErr := net.SplitHostPort(candidate); splitErr != nil {
				return nil, nil, fmt.Errorf("netmap peer %d (%s): endpoint %q: %w", i, p.NodeID, candidate, splitErr)
			}
			if endpoint == "" {
				endpoint = candidate
			}
		}

		peers = append(peers, dataplane.Peer{
			PublicKey:           key,
			Endpoint:            endpoint,
			AllowedIPs:          allowed,
			PersistentKeepalive: p.KeepaliveSeconds,
		})
	}

	return peers, dropped, nil
}

func documentTime(netmap *control.NetmapResponse, fetchedAt time.Time) time.Time {
	if netmap.GeneratedAtUnix > 0 {
		return time.Unix(netmap.GeneratedAtUnix, 0)
	}
	return fetchedAt
}

func droppedNote(dropped []string) string {
	if len(dropped) == 0 {
		return ""
	}
	return fmt.Sprintf(" (%s)", strings.Join(dropped, ", "))
}

func policyNote(policy *acl.CompiledPeerPolicy) string {
	if policy == nil {
		// Not an aside: a document with no policy leaves the filter at default deny,
		// so the node has peers it cannot send anything to.
		return "absent (default deny)"
	}
	return fmt.Sprintf("epoch %d, %d inbound / %d outbound rule(s)",
		policy.Epoch, len(policy.InboundRules), len(policy.OutboundRules))
}

// --- Endpoint discovery ------------------------------------------------------

// discoverEndpoints lists the addresses a peer could plausibly dial this node at.
//
// Loopback, link-local and unspecified addresses are left out: they mean something
// different on every machine that reads them, so handing one to a peer sends it to
// itself. The control plane rejects them as well, and doing it here too keeps the
// heartbeat honest rather than relying on the far side to clean up.
func discoverEndpoints(listenPort uint16, stunServer string) []control.EndpointDesc {
	if listenPort == 0 {
		return nil
	}

	var out []control.EndpointDesc

	ifaces, err := net.Interfaces()
	if err != nil {
		log.Printf("[SOVEREIGN-NODE] Could not enumerate interfaces for endpoint discovery: %v", err)
	}

	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, addrErr := iface.Addrs()
		if addrErr != nil {
			continue
		}
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			addr, ok := netip.AddrFromSlice(ipNet.IP)
			if !ok {
				continue
			}
			addr = addr.Unmap()
			if addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsUnspecified() {
				continue
			}
			// The overlay addresses are inside the tunnel. Advertising one as a place
			// to reach the tunnel would be a loop.
			if isOverlayAddr(addr) {
				continue
			}
			out = append(out, control.EndpointDesc{
				IPAddress: addr.String(),
				Port:      uint32(listenPort),
				Protocol:  "udp",
			})
		}
	}

	if stunServer != "" {
		if reflexive, stunErr := nat.QuerySTUN(stunServer, 3*time.Second, nil); stunErr == nil && reflexive != nil {
			addr, ok := netip.AddrFromSlice(reflexive.IP)
			if ok && !addr.Unmap().IsUnspecified() {
				// The reflexive *address* is measured; the port is not. STUN mapped a
				// probe socket, not the WireGuard socket, so its mapped port belongs
				// to the probe. Pairing the measured address with the configured
				// listen port is a candidate, which is what an endpoint is, and it is
				// only correct through a NAT that preserves ports. Discovering the
				// WireGuard socket's own mapping needs the bind that WP-204 adds.
				out = append(out, control.EndpointDesc{
					IPAddress:        addr.Unmap().String(),
					Port:             uint32(listenPort),
					Protocol:         "udp",
					IsSTUNDiscovered: true,
				})
			}
		} else if stunErr != nil {
			log.Printf("[SOVEREIGN-NODE] STUN endpoint discovery against %s failed: %v", stunServer, stunErr)
		}
	}

	return out
}

// overlayRanges are the mesh's own address ranges, which are inside the tunnel.
var overlayRanges = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("fd7a:115c:a1e0::/48"),
}

func isOverlayAddr(addr netip.Addr) bool {
	for _, prefix := range overlayRanges {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}
