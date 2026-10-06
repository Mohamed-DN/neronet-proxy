package transport

import (
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
)

// timer and clock exist so the staggered fallback can be driven by a fake clock in
// tests. time.AfterFunc satisfies the first.
type timer interface{ Stop() bool }

type clock interface {
	AfterFunc(d time.Duration, f func()) timer
}

type realClock struct{}

func (realClock) AfterFunc(d time.Duration, f func()) timer { return time.AfterFunc(d, f) }

// PathSpec is one place a peer may be reached: a transport and an address in that
// transport's own notation ("203.0.113.7:51820" for udp, "eu-central/<peer key>" for
// derp).
type PathSpec struct {
	Transport string
	Address   string
}

// candidate is a parsed PathSpec.
type candidate struct {
	tr   string
	addr string
	ep   conn.Endpoint
}

func (c candidate) same(tr string, ep conn.Endpoint) bool {
	return c.tr == tr && c.ep.DstToString() == ep.DstToString()
}

// attempt is one handshake initiation raced over the peer's paths.
type attempt struct {
	index    uint32
	answered bool
	timers   []timer
}

// peerState is what the Mux knows about one WireGuard peer: where it may be reached, and
// how the last initiation toward it fared.
type peerState struct {
	key  string // lower-case hex of the peer's public key
	pub  [32]byte
	mac1 [32]byte

	mu    sync.Mutex
	paths []candidate // preference order

	// fails counts initiations in a row that nothing answered. It rotates which path an
	// initiation tries first, so a path that swallows the initiation (or whose return
	// leg is blocked) cannot be the first choice for ever: the responder consumes the
	// first copy it receives, and a second identical copy is dropped as a replay, so
	// without the rotation a path that is up in one direction only would win every
	// race and never complete.
	fails   int
	winner  string // transport that answered the last initiation
	attempt *attempt
}

type peerTable struct {
	mu      sync.RWMutex
	byKey   map[string]*peerState
	pending map[uint32]*peerState // sender index of the latest initiation -> peer
}

func newPeerTable() *peerTable {
	return &peerTable{
		byKey:   make(map[string]*peerState),
		pending: make(map[uint32]*peerState),
	}
}

func normaliseKey(key string) (string, [32]byte, error) {
	var pub [32]byte
	k := strings.ToLower(strings.TrimSpace(key))
	raw, err := hex.DecodeString(k)
	if err != nil || len(raw) != 32 {
		return "", pub, fmt.Errorf("transport: peer key %q is not 32 bytes of hex", key)
	}
	copy(pub[:], raw)
	return k, pub, nil
}

// SetPeerPaths declares where a peer may be reached. Paths are tried in transport
// preference order (Order); within one transport they keep the order given. A path on a
// transport that is not allowed, or not built, is an error, not a silent omission: the
// caller filters by policy first, and a path that slipped through is a bug to find.
//
// The peer's state, and so the endpoint wireguard-go already holds for it, survives a
// second call: only the path list changes.
func (m *Mux) SetPeerPaths(key string, specs []PathSpec) error {
	k, pub, err := normaliseKey(key)
	if err != nil {
		return err
	}

	allowed := m.allowed.Load()
	paths := make([]candidate, 0, len(specs))
	for _, s := range specs {
		name := strings.ToLower(strings.TrimSpace(s.Transport))
		spec, ok := lookup(name)
		if !ok {
			return fmt.Errorf("%w: %q", ErrNotBuilt, name)
		}
		if !allowed.has(name) {
			return fmt.Errorf("%w: %q", ErrNotAllowed, name)
		}
		ep, err := spec.ParseEndpoint(s.Address)
		if err != nil {
			return fmt.Errorf("transport: %s endpoint %q: %w", name, s.Address, err)
		}
		paths = append(paths, candidate{tr: name, addr: s.Address, ep: ep})
	}
	sort.SliceStable(paths, func(i, j int) bool { return Rank(paths[i].tr) < Rank(paths[j].tr) })

	m.peers.mu.Lock()
	ps, known := m.peers.byKey[k]
	if !known {
		ps = &peerState{key: k, pub: pub, mac1: mac1Key(pub)}
		m.peers.byKey[k] = ps
	}
	m.peers.mu.Unlock()

	ps.mu.Lock()
	ps.paths = paths
	ps.mu.Unlock()
	return nil
}

// RemovePeer forgets a peer's paths and cancels anything still scheduled for it.
func (m *Mux) RemovePeer(key string) {
	k, _, err := normaliseKey(key)
	if err != nil {
		return
	}

	m.peers.mu.Lock()
	ps := m.peers.byKey[k]
	delete(m.peers.byKey, k)
	m.peers.mu.Unlock()

	if ps != nil {
		m.dropAttempt(ps)
	}
}

// PeerEndpoint is the endpoint string to give wireguard-go for a peer declared with
// SetPeerPaths. It names the peer, not a place, so the Mux decides where each packet
// goes.
func PeerEndpoint(key string) string {
	return "peer://" + strings.ToLower(strings.TrimSpace(key))
}

// NoEndpoint is the endpoint string for a peer that has no path: every send to it
// fails. wireguard-go cannot unset an endpoint, and one it learned by roaming would
// otherwise keep carrying packets after the policy that allowed them was withdrawn.
const NoEndpoint = "none://"

// PeerPaths lists a peer's declared paths as endpoint strings, for diagnostics and
// tests.
func (m *Mux) PeerPaths(key string) []string {
	k, _, err := normaliseKey(key)
	if err != nil {
		return nil
	}
	m.peers.mu.RLock()
	ps := m.peers.byKey[k]
	m.peers.mu.RUnlock()
	if ps == nil {
		return nil
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	out := make([]string, 0, len(ps.paths))
	for _, c := range ps.paths {
		out = append(out, c.tr+"://"+c.addr)
	}
	return out
}

func (m *Mux) peerByKey(k string) *peerState {
	m.peers.mu.RLock()
	defer m.peers.mu.RUnlock()
	return m.peers.byKey[k]
}

// identify finds the configured peer an initiation is addressed to, by checking its MAC1
// against each peer's public key. An initiation carries no other plaintext identifier of
// its destination, and the endpoint object wireguard-go passes to Send may have been
// replaced by roaming since the peer was configured.
func (m *Mux) identify(init []byte) *peerState {
	m.peers.mu.RLock()
	defer m.peers.mu.RUnlock()
	for _, ps := range m.peers.byKey {
		if initiationIsFor(init, ps.mac1) {
			return ps
		}
	}
	return nil
}

// dropAttempt cancels the timers of a peer's outstanding initiation and forgets its
// index.
func (m *Mux) dropAttempt(ps *peerState) {
	ps.mu.Lock()
	a := ps.attempt
	ps.attempt = nil
	if a != nil {
		for _, t := range a.timers {
			t.Stop()
		}
		a.timers = nil
	}
	ps.mu.Unlock()

	if a != nil {
		m.peers.mu.Lock()
		if m.peers.pending[a.index] == ps {
			delete(m.peers.pending, a.index)
		}
		m.peers.mu.Unlock()
	}
}

// ConfirmAuthenticated is called only by the WireGuard state sampler after a new
// authenticated handshake or receive counter. A wire type or receiver index is public
// and cannot prove liveness, so the receive path never calls this method.
func (m *Mux) ConfirmAuthenticated(key, address string) bool {
	k, _, err := normaliseKey(key)
	if err != nil {
		return false
	}
	ps := m.peerByKey(k)
	if ps == nil {
		return false
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	tr, addr, ok := strings.Cut(address, "://")
	if !ok || !m.Allows(tr) {
		return false
	}
	permitted := false
	for _, path := range ps.paths {
		if path.tr == tr && path.ep.DstToString() == addr {
			permitted = true
			break
		}
	}
	if !permitted {
		return false
	}
	if a := ps.attempt; a != nil && !a.answered {
		a.answered = true
		for _, t := range a.timers {
			t.Stop()
		}
		a.timers = nil
		ps.fails = 0
		ps.winner = tr
	}
	return true
}

// candidates is the peer's paths for one initiation, in the order to try them: the
// place the packet would go anyway first within its transport (it may be a roamed
// address more current than the configured ones), transports in preference order, the
// whole list rotated by the number of unanswered initiations. Paths on a transport that
// is not allowed or not open are left out.
func (m *Mux) candidates(ps *peerState, own *endpoint) []candidate {
	ps.mu.Lock()
	list := make([]candidate, len(ps.paths), len(ps.paths)+1)
	copy(list, ps.paths)
	fails := ps.fails
	ps.mu.Unlock()

	if own != nil && own.inner != nil && own.tr != trNone {
		dup := false
		for _, c := range list {
			if c.same(own.tr, own.inner) {
				dup = true
				break
			}
		}
		if !dup {
			at := len(list)
			for i, c := range list {
				if Rank(c.tr) >= Rank(own.tr) {
					at = i
					break
				}
			}
			list = append(list, candidate{})
			copy(list[at+1:], list[at:])
			list[at] = candidate{tr: own.tr, addr: own.inner.DstToString(), ep: own.inner}
		}
	}

	allowed := m.allowed.Load()
	m.openMu.RLock()
	usable := list[:0]
	for _, c := range list {
		if _, isOpen := m.open[c.tr]; isOpen && allowed.has(c.tr) {
			usable = append(usable, c)
		}
	}
	m.openMu.RUnlock()

	if len(usable) > 1 && fails > 0 {
		r := fails % len(usable)
		usable = append(usable[r:len(usable):len(usable)], usable[:r]...)
	}
	return usable
}

// sendInitiation sends one handshake initiation toward a peer, racing it over the
// peer's paths (Happy Eyeballs, RFC 8305). The first path in preference order gets it at
// once; each later path gets a copy a further m.stagger on, unless a handshake answer
// has arrived by then. The responder consumes the first copy to reach it and drops the
// rest as replays, and wireguard-go's own roaming moves the peer to whichever path the
// answer came back on, so no selection state lives anywhere but in the packets.
//
// A path that is allowed in principle but not usable now is skipped, so one dead
// transport never delays the handshake by its slot in the queue.
func (m *Mux) sendInitiation(ep *endpoint, buf []byte) error {
	ps := ep.peer.Load()
	if ps == nil {
		if ps = m.identify(buf); ps != nil {
			ep.peer.Store(ps)
		}
	}
	if ps == nil {
		// Not a peer the Mux was told about: send it where the endpoint says, if the
		// endpoint says anything.
		return m.sendConcrete(ep, [][]byte{buf})
	}

	index := initiationIndex(buf)

	// The previous initiation, if nothing answered it, counts as a failure before the
	// order of paths for this one is worked out: the first choice moves on this very
	// initiation, not the next.
	ps.mu.Lock()
	prev := ps.attempt
	if prev != nil {
		if !prev.answered {
			ps.fails++
		}
		for _, t := range prev.timers {
			t.Stop()
		}
		prev.timers = nil
	}
	att := &attempt{index: index}
	ps.attempt = att
	ps.mu.Unlock()

	m.peers.mu.Lock()
	if prev != nil && m.peers.pending[prev.index] == ps {
		delete(m.peers.pending, prev.index)
	}
	m.peers.pending[index] = ps
	m.peers.mu.Unlock()

	cands := m.candidates(ps, ep)
	if len(cands) == 0 {
		return ErrNoPath
	}

	copyOf := append([]byte(nil), buf...)

	var (
		lastErr error
		sent    bool
		slot    int
	)
	for _, c := range cands {
		if !sent {
			if err := m.sendOne(c.tr, c.ep, [][]byte{buf}); err != nil {
				lastErr = err
				continue
			}
			sent = true
			continue
		}

		slot++
		cand := c
		t := m.clock.AfterFunc(time.Duration(slot)*m.stagger, func() {
			ps.mu.Lock()
			skip := att.answered || ps.attempt != att
			ps.mu.Unlock()
			if skip {
				return
			}
			_ = m.sendOne(cand.tr, cand.ep, [][]byte{copyOf})
		})

		ps.mu.Lock()
		if att.answered || ps.attempt != att {
			t.Stop()
		} else {
			att.timers = append(att.timers, t)
		}
		ps.mu.Unlock()
	}

	if !sent {
		// Nothing could be sent now. Anything scheduled still goes out; report the
		// failure only if nothing is pending either.
		if slot == 0 {
			if lastErr == nil {
				lastErr = ErrNoPath
			}
			return lastErr
		}
	}
	return nil
}
