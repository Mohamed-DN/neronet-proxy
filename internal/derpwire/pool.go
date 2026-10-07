// Package derpwire adapts the pinned upstream DERP wire implementation. It contains
// no Tailscale control client: relay URLs, admission and policy belong to NeroNet.
package derpwire

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/url"
	"sync"
	"time"

	"go4.org/mem"
	"tailscale.com/derp"
	"tailscale.com/derp/derphttp"
	"tailscale.com/net/netmon"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const Capability = "derp-v2"

var ErrUnavailable = errors.New("DERP: authenticated relay unavailable")

type Relay struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}
type Handler func(relay string, source [32]byte, packet []byte)

type session struct {
	relay  Relay
	client *derphttp.Client
	cancel context.CancelFunc
	ready  bool
}

// Pool owns one connection per local identity and relay. All peers share it; opening
// a per-peer connection would register the same identity repeatedly at the relay.
type Pool struct {
	mu       sync.Mutex
	private  key.NodePrivate
	tls      *tls.Config
	logf     logger.Logf
	handler  Handler
	monitor  *netmon.Monitor
	ctx      context.Context
	cancel   context.CancelFunc
	relays   []Relay
	sessions map[string]*session
	wg       sync.WaitGroup
	closed   bool
}

func NewPool(private [32]byte, roots *tls.Config, handler Handler, logf func(string, ...any)) (*Pool, error) {
	if private == ([32]byte{}) {
		return nil, errors.New("DERP: private identity is required")
	}
	if roots != nil && roots.InsecureSkipVerify {
		return nil, errors.New("DERP: TLS verification cannot be disabled")
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Pool{private: key.NodePrivateFromRaw32(mem.B(private[:])), tls: roots, logf: logf, handler: handler, monitor: netmon.NewStatic(), ctx: ctx, cancel: cancel, sessions: map[string]*session{}}, nil
}

// Configure replaces the permitted relay set. The first two are receiver homes;
// other relays are opened lazily when a destination advertises a home there.
func (p *Pool) Configure(relays []Relay) error {
	if len(relays) > 32 {
		return errors.New("DERP: too many relays")
	}
	seen := map[string]bool{}
	for _, r := range relays {
		u, err := url.Parse(r.URL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || r.ID == "" || seen[r.ID] {
			return fmt.Errorf("DERP: invalid or duplicate HTTPS relay %q", r.ID)
		}
		seen[r.ID] = true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return errors.New("DERP: closed")
	}
	p.relays = append([]Relay(nil), relays...)
	for id, s := range p.sessions {
		keep := false
		for _, r := range relays {
			if r == s.relay {
				keep = true
				break
			}
		}
		if !keep {
			s.cancel()
			_ = s.client.Close()
			delete(p.sessions, id)
		}
	}
	for _, r := range relays[:min(2, len(relays))] {
		if _, err := p.ensureLocked(r.ID); err != nil {
			return err
		}
	}
	return nil
}

func (p *Pool) ensureLocked(id string) (*session, error) {
	if p.closed {
		return nil, ErrUnavailable
	}
	if s := p.sessions[id]; s != nil {
		return s, nil
	}
	var relay Relay
	for _, r := range p.relays {
		if r.ID == id {
			relay = r
			break
		}
	}
	if relay.ID == "" {
		return nil, ErrUnavailable
	}
	c, err := derphttp.NewClient(p.private, relay.URL, p.logf, p.monitor)
	if err != nil {
		return nil, err
	}
	if p.tls != nil {
		c.TLSConfig = p.tls.Clone()
	}
	ctx, cancel := context.WithCancel(p.ctx)
	c.BaseContext = func() context.Context { return ctx }
	s := &session{relay: relay, client: c, cancel: cancel}
	p.sessions[id] = s
	p.wg.Add(1)
	go p.read(ctx, s)
	return s, nil
}

func (p *Pool) read(ctx context.Context, s *session) {
	defer p.wg.Done()
	for ctx.Err() == nil {
		message, err := s.client.Recv()
		if err != nil {
			p.mu.Lock()
			s.ready = false
			p.mu.Unlock()
			select {
			case <-ctx.Done():
				return
			case <-time.After(500 * time.Millisecond):
				continue
			}
		}
		switch m := message.(type) {
		case derp.ServerInfoMessage:
			// Connect alone is insufficient: the server may reject admission after
			// the client's encrypted identity proof. ServerInfo confirms acceptance.
			p.mu.Lock()
			s.ready = true
			p.mu.Unlock()
		case derp.ReceivedPacket:
			if p.handler != nil {
				p.handler(s.relay.ID, m.Source.Raw32(), append([]byte(nil), m.Data...))
			}
		}
	}
}

func (p *Pool) Send(id string, dest [32]byte, packet []byte) error {
	p.mu.Lock()
	s, err := p.ensureLocked(id)
	ready := err == nil && s.ready
	p.mu.Unlock()
	if !ready {
		return ErrUnavailable
	}
	return s.client.Send(key.NodePublicFromRaw32(mem.B(dest[:])), packet)
}

func (p *Pool) Homes() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var homes []string
	for _, r := range p.relays[:min(2, len(p.relays))] {
		if s := p.sessions[r.ID]; s != nil && s.ready {
			homes = append(homes, r.ID)
		}
	}
	return homes
}

func (p *Pool) Connections() int { p.mu.Lock(); defer p.mu.Unlock(); return len(p.sessions) }

func (p *Pool) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	p.cancel()
	for _, s := range p.sessions {
		s.cancel()
		_ = s.client.Close()
	}
	p.mu.Unlock()
	p.wg.Wait()
	return p.monitor.Close()
}
