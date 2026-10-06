package transport

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.zx2c4.com/wireguard/conn"
)

// DefaultStagger is how long the Mux waits before racing a handshake initiation over the
// next transport. It is RFC 8305's connection attempt delay: long enough that a direct
// path that works answers first, short enough that a blocked one costs a quarter of a
// second and not a retransmission.
const DefaultStagger = 250 * time.Millisecond

// nameSet is an immutable set of transport names.
type nameSet map[string]struct{}

func newNameSet(names []string) nameSet {
	s := make(nameSet, len(names))
	for _, n := range names {
		s[n] = struct{}{}
	}
	return s
}

func (s nameSet) has(name string) bool {
	_, ok := s[name]
	return ok
}

func (s nameSet) equal(o nameSet) bool {
	if len(s) != len(o) {
		return false
	}
	for n := range s {
		if !o.has(n) {
			return false
		}
	}
	return true
}

func (s nameSet) list() []string {
	out := make([]string, 0, len(s))
	for n := range s {
		out = append(out, n)
	}
	return Canonical(out)
}

type counters struct {
	txPackets, txBytes, rxPackets, rxBytes atomic.Uint64
}

// Stats are the packets and bytes a transport has moved since the Mux was built. They
// are counted at the Mux, above the transport, so they cover exactly what wireguard-go
// sent and received, and a transport that is not allowed shows zero.
type Stats struct {
	TxPackets, TxBytes, RxPackets, RxBytes uint64
}

// Mux is a conn.Bind that carries one WireGuard device over several transports at once.
//
// It listens on every allowed transport, accepts WireGuard packets from any of them, and
// sends each packet through the transport its endpoint names. Handshake initiations are
// raced over all of a peer's paths in preference order (see sendInitiation); everything
// else follows wireguard-go's roaming, which moves a peer to the place its last
// authenticated packet came from.
//
// A transport that is not in the allowed set is never opened and never used, and
// withdrawing it takes effect at once: SetAllowed closes it before returning, and Send
// refuses it even if a stale endpoint still names it. There is no fallback to a
// transport the policy does not allow.
type Mux struct {
	cfg     Config
	stagger time.Duration
	clock   clock

	allowed atomic.Pointer[nameSet]

	openMu sync.RWMutex
	open   map[string]Transport
	isOpen bool

	peers *peerTable

	stats [5]counters // indexed by Rank
}

var _ conn.Bind = (*Mux)(nil)

// Option adjusts a Mux.
type Option func(*Mux)

// WithStagger sets the delay between transports when racing a handshake initiation.
func WithStagger(d time.Duration) Option {
	return func(m *Mux) {
		if d > 0 {
			m.stagger = d
		}
	}
}

// NewMux builds a closed Mux that will open the given transports. A name that is not a
// transport this build knows is dropped, so an unknown name allows nothing.
func NewMux(cfg Config, allowed []string, opts ...Option) *Mux {
	m := &Mux{
		cfg:     cfg,
		stagger: DefaultStagger,
		clock:   realClock{},
		open:    map[string]Transport{},
		peers:   newPeerTable(),
	}
	set := newNameSet(Canonical(allowed))
	m.allowed.Store(&set)
	for _, o := range opts {
		o(m)
	}
	return m
}

// Allowed lists the transports currently allowed, in preference order.
func (m *Mux) Allowed() []string { return m.allowed.Load().list() }

// Allows reports whether a transport is currently allowed.
func (m *Mux) Allows(name string) bool { return m.allowed.Load().has(name) }

// SetAllowed replaces the allowed set and reports whether it changed.
//
// A transport that is no longer allowed is closed before this returns, so nothing more
// is sent or accepted over it. A transport newly allowed is not opened here: the caller
// reopens the bind (wireguard-go: a listen_port update), which calls Open again.
func (m *Mux) SetAllowed(names []string) (changed bool) {
	next := newNameSet(Canonical(names))
	prev := m.allowed.Swap(&next)
	if prev != nil && prev.equal(next) {
		return false
	}

	m.openMu.Lock()
	var withdrawn []Transport
	for name, t := range m.open {
		if !next.has(name) {
			withdrawn = append(withdrawn, t)
			delete(m.open, name)
		}
	}
	m.openMu.Unlock()

	for _, t := range withdrawn {
		_ = t.Close()
	}
	return true
}

// Reconfigure passes new settings (the relay list) to every open transport that takes
// them, and keeps them for the transports opened later.
func (m *Mux) Reconfigure(update func(*Config)) {
	m.openMu.Lock()
	update(&m.cfg)
	cfg := m.cfg
	var targets []Reconfigurer
	for _, t := range m.open {
		if r, ok := t.(Reconfigurer); ok {
			targets = append(targets, r)
		}
	}
	m.openMu.Unlock()

	for _, r := range targets {
		r.Reconfigure(cfg)
	}
}

// Open starts every allowed transport. The port is the UDP port; the one reported back
// is the UDP transport's, or zero when UDP is not allowed.
//
// A transport that fails to open is logged and left out, so a transport whose port is
// taken does not take the others down; if nothing at all opens, the first error is
// returned.
func (m *Mux) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	m.openMu.Lock()
	defer m.openMu.Unlock()

	if m.isOpen {
		return nil, 0, conn.ErrBindAlreadyOpen
	}

	allowed := m.allowed.Load()
	var (
		fns      []conn.ReceiveFunc
		actual   uint16
		firstErr error
		opened   = map[string]Transport{}
	)

	for _, name := range Order {
		if !allowed.has(name) {
			continue
		}
		spec, ok := lookup(name)
		if !ok {
			// Allowed by policy but not linked into this binary. The node reports what it
			// was built with, so the control plane does not offer it; if it does anyway,
			// this is the node saying no.
			m.cfg.logf("[transport] %s is allowed but not built into this binary", name)
			continue
		}

		t, err := spec.New(m.cfg)
		if err != nil {
			firstErr = firstError(firstErr, fmt.Errorf("transport %s: %w", name, err))
			m.cfg.logf("[transport] %s could not be created: %v", name, err)
			continue
		}
		tfns, p, err := t.Open(port)
		if err != nil {
			_ = t.Close()
			firstErr = firstError(firstErr, fmt.Errorf("transport %s: %w", name, err))
			m.cfg.logf("[transport] %s could not be opened: %v", name, err)
			continue
		}

		for _, fn := range tfns {
			fns = append(fns, m.wrapReceive(name, fn))
		}
		if name == UDP {
			actual = p
		}
		opened[name] = t
	}

	if len(opened) == 0 && firstErr != nil {
		return nil, 0, firstErr
	}

	m.open = opened
	m.isOpen = true
	return fns, actual, nil
}

func firstError(prev, next error) error {
	if prev != nil {
		return prev
	}
	return next
}

// Close closes every open transport and cancels everything scheduled. The peers' paths
// are kept, so a reopened Mux resumes with the same peers.
func (m *Mux) Close() error {
	m.openMu.Lock()
	open := m.open
	m.open = map[string]Transport{}
	m.isOpen = false
	m.openMu.Unlock()

	m.peers.mu.RLock()
	all := make([]*peerState, 0, len(m.peers.byKey))
	for _, ps := range m.peers.byKey {
		all = append(all, ps)
	}
	m.peers.mu.RUnlock()
	for _, ps := range all {
		m.dropAttempt(ps)
	}

	var err error
	for _, t := range open {
		err = errors.Join(err, t.Close())
	}
	return err
}

// SetMark sets the packet mark on every open transport that supports one.
func (m *Mux) SetMark(mark uint32) error {
	m.openMu.RLock()
	defer m.openMu.RUnlock()

	var err error
	for _, t := range m.open {
		err = errors.Join(err, t.SetMark(mark))
	}
	return err
}

// BatchSize is the largest batch of any built transport, in every state, so that
// wireguard-go sizes its buffers once.
func (m *Mux) BatchSize() int { return maxBatch() }

// ParseEndpoint parses "<transport>://<address>", a bare "host:port" (which is UDP), a
// "peer://<key>" declared with SetPeerPaths, or "none://". A transport that is not
// allowed is refused rather than parsed: an endpoint on it could only ever be used to
// send.
func (m *Mux) ParseEndpoint(s string) (conn.Endpoint, error) {
	scheme, addr, found := strings.Cut(s, "://")
	if !found {
		scheme, addr = UDP, s
	}
	scheme = strings.ToLower(scheme)

	switch scheme {
	case "none":
		return &endpoint{tr: trNone}, nil
	case "peer":
		k, _, err := normaliseKey(addr)
		if err != nil {
			return nil, err
		}
		ps := m.peerByKey(k)
		if ps == nil {
			return nil, fmt.Errorf("transport: no paths were declared for peer %.8s", k)
		}
		return newPeerLevel(ps), nil
	}

	if !m.allowed.Load().has(scheme) {
		return nil, fmt.Errorf("%w: %q", ErrNotAllowed, scheme)
	}
	spec, ok := lookup(scheme)
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrNotBuilt, scheme)
	}
	inner, err := spec.ParseEndpoint(addr)
	if err != nil {
		return nil, err
	}
	return newConcrete(scheme, inner), nil
}

// Send sends WireGuard packets to an endpoint.
//
// A handshake initiation is raced over the peer's paths. Everything else goes through
// the one transport the endpoint names.
func (m *Mux) Send(bufs [][]byte, e conn.Endpoint) error {
	ep, ok := e.(*endpoint)
	if !ok {
		return conn.ErrWrongEndpointType
	}

	var rest [][]byte
	var err error
	for i, b := range bufs {
		if !isInitiation(b) {
			if rest != nil {
				rest = append(rest, b)
			}
			continue
		}
		if rest == nil {
			rest = append(make([][]byte, 0, len(bufs)), bufs[:i]...)
		}
		err = errors.Join(err, m.sendInitiation(ep, b))
	}
	if rest == nil {
		// No initiation among them: the common case, with no copying.
		return m.sendConcrete(ep, bufs)
	}
	if len(rest) > 0 {
		err = errors.Join(err, m.sendConcrete(ep, rest))
	}
	return err
}

// sendConcrete sends through the transport an endpoint names; a peer-level endpoint
// resolves to the peer's first usable path.
func (m *Mux) sendConcrete(ep *endpoint, bufs [][]byte) error {
	switch {
	case ep.tr == trNone:
		return ErrNoPath
	case ep.inner != nil:
		return m.sendOne(ep.tr, ep.inner, bufs)
	}

	ps := ep.peer.Load()
	if ps == nil {
		return ErrNoPath
	}
	cands := m.candidates(ps, nil)
	if len(cands) == 0 {
		return ErrNoPath
	}
	return m.sendOne(cands[0].tr, cands[0].ep, bufs)
}

// sendOne is the only place a packet leaves the Mux, and so the only place the policy has
// to be enforced on the way out.
func (m *Mux) sendOne(tr string, inner conn.Endpoint, bufs [][]byte) error {
	if !m.allowed.Load().has(tr) {
		return fmt.Errorf("%w: %q", ErrNotAllowed, tr)
	}

	m.openMu.RLock()
	t := m.open[tr]
	m.openMu.RUnlock()
	if t == nil {
		return net.ErrClosed
	}

	err := t.Send(bufs, inner)
	if err == nil {
		c := &m.stats[Rank(tr)]
		var total uint64
		for _, b := range bufs {
			total += uint64(len(b))
		}
		c.txPackets.Add(uint64(len(bufs)))
		c.txBytes.Add(total)
	}
	return err
}

// wrapReceive tags what a transport receives with the transport, drops it if the
// transport has been withdrawn since it was opened, and notes handshake answers.
func (m *Mux) wrapReceive(name string, fn conn.ReceiveFunc) conn.ReceiveFunc {
	c := &m.stats[Rank(name)]

	return func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		n, err := fn(packets, sizes, eps)
		if err != nil {
			return n, err
		}

		if !m.allowed.Load().has(name) {
			// Withdrawn between the packet arriving and this call: it is not delivered.
			for i := 0; i < n; i++ {
				sizes[i] = 0
			}
			return n, nil
		}

		for i := 0; i < n; i++ {
			if sizes[i] == 0 {
				continue
			}
			pkt := packets[i][:sizes[i]]
			c.rxPackets.Add(1)
			c.rxBytes.Add(uint64(len(pkt)))

			if len(pkt) == sizeResponse || len(pkt) == sizeCookie {
				if idx, ok := answerIndex(pkt); ok {
					m.onAnswer(name, idx)
				}
			}
			eps[i] = newConcrete(name, eps[i])
		}
		return n, nil
	}
}

// Stats returns the per-transport counters, keyed by transport name. Transports that
// moved nothing are present with zeros.
func (m *Mux) Stats() map[string]Stats {
	out := make(map[string]Stats, len(Order))
	for i, name := range Order {
		c := &m.stats[i]
		out[name] = Stats{
			TxPackets: c.txPackets.Load(),
			TxBytes:   c.txBytes.Load(),
			RxPackets: c.rxPackets.Load(),
			RxBytes:   c.rxBytes.Load(),
		}
	}
	return out
}
