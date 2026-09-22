// Package derp provides the DERP-v4 relay client and a fallback manager.
//
// FallbackManager watches the direct WireGuard UDP path to each peer. When it
// has not heard from a peer for more than directPathTimeout, it automatically
// connects (or re-uses an existing connection) to the nearest DERP relay
// announced by the control plane and tunnels WireGuard packets through it.
//
// The relay is treated as a transparent bidirectional byte pipe for WireGuard
// UDP datagrams: the encrypted packet is forwarded as the DERP frame payload.
// No plaintext is ever exposed to the relay.
//
// Direct path resumes as soon as WireGuard reports a successful handshake: the
// fallback is torn down and the relay connection released back to the pool.
//
// The 10-second threshold means a peer behind a symmetric NAT that cannot be
// reached via STUN will have a relay path within one WireGuard handshake cycle.

package derp

import (
	"context"
	"log"
	"sync"
	"time"
)

// directPathTimeout is how long since the last received packet from a peer
// before the fallback relay is engaged.
const directPathTimeout = 10 * time.Second

// FallbackState describes the current path to a peer.
type FallbackState int

const (
	// FallbackDirect is the normal state: WireGuard UDP is working.
	FallbackDirect FallbackState = iota
	// FallbackRelay is active: packets are forwarded via a DERP relay.
	FallbackRelay
)

// PeerPath tracks the fallback state for a single peer.
type PeerPath struct {
	mu          sync.Mutex
	peerPubKey  [PubKeySize]byte
	state       FallbackState
	lastDirect  time.Time
	relayClient *Client // non-nil when FallbackRelay is active
}

// FallbackManager supervises peer paths and engages relays automatically.
//
// Usage:
//
//	mgr := NewFallbackManager(relayURL, selfPubKey, handler, nil)
//	mgr.Start(ctx)
//	mgr.RecordDirectRecv(peerPub)  // call whenever WG delivers a packet
//	mgr.Stop()
type FallbackManager struct {
	mu sync.Mutex

	selfPubKey [PubKeySize]byte
	relayURLs  []string // in preference order; first reachable is chosen

	// onRelayPacket is called for each packet received over a relay connection.
	// The caller forwards it to the WireGuard device.
	onRelayPacket PacketHandler

	paths   map[[PubKeySize]byte]*PeerPath
	clients []*Client // live relay clients keyed to relay position

	wg     sync.WaitGroup
	cancel context.CancelFunc
}

// NewFallbackManager creates a FallbackManager.
//
// relayURLs are tried in order; the first that responds is used.
// onRelayPacket receives packets delivered by an active relay client.
func NewFallbackManager(
	relayURLs []string,
	selfPubKey [PubKeySize]byte,
	onRelayPacket PacketHandler,
) *FallbackManager {
	return &FallbackManager{
		selfPubKey:    selfPubKey,
		relayURLs:     relayURLs,
		onRelayPacket: onRelayPacket,
		paths:         make(map[[PubKeySize]byte]*PeerPath),
	}
}

// Start begins the background loop that monitors peer paths.
func (m *FallbackManager) Start(ctx context.Context) {
	ctx, m.cancel = context.WithCancel(ctx)
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.loop(ctx)
	}()
}

// Stop shuts down the manager and closes all relay clients.
func (m *FallbackManager) Stop() {
	if m.cancel != nil {
		m.cancel()
	}
	m.wg.Wait()

	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.clients {
		_ = c.Close()
	}
	m.clients = nil
}

// RecordDirectRecv must be called whenever WireGuard delivers an authenticated
// packet from a peer. It refreshes the liveness timestamp so the manager knows
// the direct path is still working.
func (m *FallbackManager) RecordDirectRecv(peerPubKey [PubKeySize]byte) {
	m.mu.Lock()
	p := m.ensurePath(peerPubKey)
	m.mu.Unlock()

	p.mu.Lock()
	p.lastDirect = time.Now()
	if p.state == FallbackRelay {
		// Direct path has recovered — tear down the relay.
		log.Printf("[DERP-FALLBACK] Direct path recovered to peer %x — releasing relay", peerPubKey[:4])
		p.state = FallbackDirect
		if p.relayClient != nil {
			_ = p.relayClient.Close()
			p.relayClient = nil
		}
	}
	p.mu.Unlock()
}

// SendViaRelay forwards an encrypted WireGuard packet to a peer through the
// active relay. Returns an error if no relay is currently engaged.
func (m *FallbackManager) SendViaRelay(peerPubKey [PubKeySize]byte, packet []byte) error {
	m.mu.Lock()
	p := m.paths[peerPubKey]
	m.mu.Unlock()

	if p == nil {
		return nil // peer not yet known
	}

	p.mu.Lock()
	c := p.relayClient
	p.mu.Unlock()

	if c == nil {
		return nil // no relay active; WireGuard will handle it
	}
	return c.SendTo(peerPubKey, packet)
}

// RelayActive reports whether a relay is currently engaged for peerPubKey.
func (m *FallbackManager) RelayActive(peerPubKey [PubKeySize]byte) bool {
	m.mu.Lock()
	p := m.paths[peerPubKey]
	m.mu.Unlock()

	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state == FallbackRelay
}

// ActiveRelayCount returns the number of peers currently using a relay.
func (m *FallbackManager) ActiveRelayCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, p := range m.paths {
		p.mu.Lock()
		if p.state == FallbackRelay {
			n++
		}
		p.mu.Unlock()
	}
	return n
}

// UpdateRelayURLs replaces the relay list with a fresh one from the control
// plane. Called when a new netmap is applied.
func (m *FallbackManager) UpdateRelayURLs(urls []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.relayURLs = urls
}

// --- internal ---

func (m *FallbackManager) ensurePath(pub [PubKeySize]byte) *PeerPath {
	if p, ok := m.paths[pub]; ok {
		return p
	}
	p := &PeerPath{
		peerPubKey: pub,
		state:      FallbackDirect,
		lastDirect: time.Now(),
	}
	m.paths[pub] = p
	return p
}

// loop runs the periodic check. It looks at each tracked peer and engages a
// relay if the direct path has been silent for directPathTimeout.
func (m *FallbackManager) loop(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.mu.Lock()
			peers := make([]*PeerPath, 0, len(m.paths))
			for _, p := range m.paths {
				peers = append(peers, p)
			}
			relayURLs := m.relayURLs
			m.mu.Unlock()

			for _, p := range peers {
				m.checkPeer(ctx, p, relayURLs)
			}
		}
	}
}

func (m *FallbackManager) checkPeer(ctx context.Context, p *PeerPath, relayURLs []string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.state == FallbackRelay {
		return // already relaying
	}

	if time.Since(p.lastDirect) < directPathTimeout {
		return // direct path is alive
	}

	if len(relayURLs) == 0 {
		return // no relay to fall back to
	}

	log.Printf("[DERP-FALLBACK] Direct path to peer %x silent for %.1fs — engaging relay %s",
		p.peerPubKey[:4], time.Since(p.lastDirect).Seconds(), relayURLs[0])

	c := NewClient(relayURLs[0], m.selfPubKey, m.onRelayPacket, nil)

	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if err := c.Connect(dialCtx); err != nil {
		log.Printf("[DERP-FALLBACK] Relay connect to %s failed: %v", relayURLs[0], err)
		return
	}

	p.state = FallbackRelay
	p.relayClient = c

	m.mu.Lock()
	m.clients = append(m.clients, c)
	m.mu.Unlock()

	log.Printf("[DERP-FALLBACK] Relay engaged for peer %x via %s", p.peerPubKey[:4], relayURLs[0])
}
