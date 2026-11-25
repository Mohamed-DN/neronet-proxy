package meshnode

import (
	"context"
	"errors"
	"log"
	"math/rand/v2"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/dataplane"
)

// Round trips to the devices this gateway serves (ADR 0042).
//
// The console used to show the gateway's HTTP round trip to the console as a device's
// "response time", and a profile device had none. The gateway now pings each profile
// device it serves through its own netstack. A reply is a number; a ping nobody answered
// within the timeout is "no reply" (a null value with the time it was tried), never a
// number and never "offline": Windows blocks ping by default, so a connected device may
// legitimately not answer. A peer whose last handshake is not recent is not pinged at all.

const (
	// probeInterval is the time between sweeps; each sweep is jittered by probeJitter
	// either way so a fleet of gateways does not ping in step.
	probeInterval = 30 * time.Second
	probeJitter   = 0.2
	// probeTimeout is how long one ping may wait for its reply.
	probeTimeout = 3 * time.Second
	// probeConcurrency bounds the pings in flight at once.
	probeConcurrency = 8
	// probeHandshakeWindow is how recent a handshake must be for a peer to be pinged. It
	// is the control plane's own connected window (services/ProfileHandshake.js).
	probeHandshakeWindow = 180 * time.Second
)

// pinger is what the data plane offers: dataplane.Device.Ping.
type pinger interface {
	Ping(ctx context.Context, dst netip.Addr) (time.Duration, error)
}

// probeTarget is one peer to ping: its node id, overlay address and last handshake.
type probeTarget struct {
	PeerID        string
	Addr          netip.Addr
	LastHandshake time.Time
}

// rttSample is one measurement. RTTMillis is nil when the ping got no reply.
type rttSample struct {
	RTTMillis *float64
	At        time.Time
}

type peerProber struct {
	ping        pinger
	timeout     time.Duration
	concurrency int
	window      time.Duration
	now         func() time.Time

	mu      sync.Mutex
	samples map[string]rttSample
}

func newPeerProber(p pinger) *peerProber {
	return &peerProber{
		ping:        p,
		timeout:     probeTimeout,
		concurrency: probeConcurrency,
		window:      probeHandshakeWindow,
		now:         time.Now,
		samples:     map[string]rttSample{},
	}
}

// fresh reports whether a target's handshake is recent enough to be pinged.
func (p *peerProber) fresh(t probeTarget) bool {
	if t.LastHandshake.IsZero() {
		return false
	}
	age := p.now().Sub(t.LastHandshake)
	return age >= -5*time.Second && age <= p.window
}

// measure pings one target. ok is false when the attempt says nothing about the peer:
// the data plane is closing or the node is shutting down. A timeout or an unreachable
// peer is a sample with no value.
func (p *peerProber) measure(ctx context.Context, t probeTarget) (rttSample, bool) {
	pingCtx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	rtt, err := p.ping.Ping(pingCtx, t.Addr)
	at := p.now()
	if ctx.Err() != nil || errors.Is(err, dataplane.ErrClosed) || errors.Is(err, dataplane.ErrPingUnsupported) {
		return rttSample{}, false
	}
	if err != nil {
		return rttSample{At: at}, true
	}
	ms := float64(rtt.Microseconds()) / 1000
	return rttSample{RTTMillis: &ms, At: at}, true
}

// sweep pings every target with a recent handshake, at most p.concurrency at a time, and
// stores the results. Samples of peers that are no longer targets are dropped.
func (p *peerProber) sweep(ctx context.Context, targets []probeTarget) {
	live := map[string]bool{}
	var wg sync.WaitGroup
	slots := make(chan struct{}, max(p.concurrency, 1))
	for _, t := range targets {
		live[t.PeerID] = true
		if !p.fresh(t) {
			// A stale peer is not pinged, and what an earlier ping said about it is
			// not kept: the value would outlive the connection it described.
			p.mu.Lock()
			delete(p.samples, t.PeerID)
			p.mu.Unlock()
			continue
		}
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			wg.Wait()
			return
		}
		wg.Add(1)
		go func(t probeTarget) {
			defer wg.Done()
			defer func() { <-slots }()
			if sample, ok := p.measure(ctx, t); ok {
				p.mu.Lock()
				p.samples[t.PeerID] = sample
				p.mu.Unlock()
			}
		}(t)
	}
	wg.Wait()
	p.mu.Lock()
	for id := range p.samples {
		if !live[id] {
			delete(p.samples, id)
		}
	}
	p.mu.Unlock()
}

// Sample is the latest measurement for a peer.
func (p *peerProber) Sample(peerID string) (rttSample, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	s, ok := p.samples[peerID]
	return s, ok
}

// probeNow pings one target on demand (the console's connection test). It refuses a stale
// peer the same way the sweep does and says so: the second result is false.
func (p *peerProber) probeNow(ctx context.Context, t probeTarget) (rttSample, bool) {
	if !p.fresh(t) {
		return rttSample{At: p.now()}, true
	}
	sample, ok := p.measure(ctx, t)
	if ok {
		p.mu.Lock()
		p.samples[t.PeerID] = sample
		p.mu.Unlock()
	}
	return sample, ok
}

// jittered spreads d by +-probeJitter.
func jittered(d time.Duration, r func() float64) time.Duration {
	return time.Duration(float64(d) * (1 - probeJitter + 2*probeJitter*r()))
}

// Run sweeps until ctx ends. targets is read at each sweep, so the peer set follows the
// netmap. The first sweep waits one jittered interval: a gateway that has just started
// has no handshake yet.
func (p *peerProber) Run(ctx context.Context, targets func() []probeTarget, interval time.Duration) {
	if interval <= 0 {
		interval = probeInterval
	}
	for {
		timer := time.NewTimer(jittered(interval, rand.Float64))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		p.sweep(ctx, targets())
	}
}

// profileProbeTargets are the profile devices of the current netmap that this gateway can
// ping: not revoked, with an overlay address, and with the handshake wireguard-go holds.
// A fail-closed node pings nothing.
func profileProbeTargets(peers []control.NetmapPeer, revoked map[string]uint64, failClosed bool, statuses []dataplane.PeerStatus) []probeTarget {
	if failClosed {
		return nil
	}
	handshakes := map[string]time.Time{}
	for _, s := range statuses {
		handshakes[normaliseKey(s.PublicKey)] = s.LastHandshake
	}
	var out []probeTarget
	for _, peer := range peers {
		// AmneziaWG devices are carried on their own wireguard device, which the netstack
		// this gateway pings through does not hold: a ping to them would never be answered
		// and "no reply" would be a claim about the device. They are not measured.
		if !peer.Profile || peer.AccessMethod == "amneziawg" {
			continue
		}
		key := normaliseKey(peer.PublicKeyHex)
		if _, gone := revoked[key]; gone {
			continue
		}
		addr, ok := overlayAddress(peer.AllowedIPs)
		if !ok {
			continue
		}
		out = append(out, probeTarget{PeerID: peer.NodeID, Addr: addr, LastHandshake: handshakes[key]})
	}
	return out
}

// overlayAddress is the peer's own address: the first single-host prefix it may use.
func overlayAddress(allowed []string) (netip.Addr, bool) {
	for _, a := range allowed {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(a))
		if err != nil {
			continue
		}
		if prefix.Addr().Is4() && prefix.Bits() == 32 {
			return prefix.Addr(), true
		}
	}
	for _, a := range allowed {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(a))
		if err == nil && prefix.Addr().Is6() && prefix.Bits() == 128 {
			return prefix.Addr(), true
		}
	}
	return netip.Addr{}, false
}

// probeTargets reads the manager's current peers and the device's handshakes.
func (m *netmapManager) probeTargets() []probeTarget {
	m.mu.Lock()
	peers := append([]control.NetmapPeer(nil), m.peers...)
	revoked := make(map[string]uint64, len(m.revoked))
	for k, v := range m.revoked {
		revoked[k] = v
	}
	failClosed := m.failClosed
	m.mu.Unlock()
	statuses, err := m.dev.Peers()
	if err != nil {
		return nil
	}
	return profileProbeTargets(peers, revoked, failClosed, statuses)
}

// probeSource is what the poll loop needs from the control plane.
type probeSource interface {
	PollProbes(ctx context.Context) ([]control.ProbeRequest, error)
	SendProbeResult(ctx context.Context, result control.ProbeResult) error
}

// answerProbes runs the connection tests the console asked for and reports each. A peer
// this gateway does not serve is answered "no reply": it cannot be reached from here.
func answerProbes(ctx context.Context, src probeSource, prober *peerProber, targets func() []probeTarget, requests []control.ProbeRequest) {
	byID := map[string]probeTarget{}
	for _, t := range targets() {
		byID[t.PeerID] = t
	}
	var wg sync.WaitGroup
	for _, request := range requests {
		wg.Add(1)
		go func(request control.ProbeRequest) {
			defer wg.Done()
			result := control.ProbeResult{RequestID: request.RequestID}
			if target, ok := byID[request.PeerID]; ok {
				sample, measured := prober.probeNow(ctx, target)
				if !measured {
					return
				}
				result.Replied = sample.RTTMillis != nil
				result.RTTMillis = sample.RTTMillis
			}
			sendCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			if err := src.SendProbeResult(sendCtx, result); err != nil {
				log.Printf("[SOVEREIGN-NODE] Probe result %s not delivered: %v", request.RequestID, err)
			}
		}(request)
	}
	wg.Wait()
}

// probePollLoop holds the control plane's probe poll open for as long as this node serves
// profile devices, and answers what it is handed at once. After a failure it waits before
// asking again, so a control plane that is down is not hammered.
func probePollLoop(ctx context.Context, src probeSource, prober *peerProber, targets func() []probeTarget, retry time.Duration) {
	for ctx.Err() == nil {
		if len(targets()) == 0 {
			// Not a gateway (or no device yet): nothing to hold a request open for.
			if !sleepCtx(ctx, retry) {
				return
			}
			continue
		}
		requests, err := src.PollProbes(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if !sleepCtx(ctx, retry) {
				return
			}
			continue
		}
		if len(requests) > 0 {
			answerProbes(ctx, src, prober, targets, requests)
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
