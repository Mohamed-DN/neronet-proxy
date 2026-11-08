package derp

import (
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"

	"github.com/sovereign/proxy/v4/internal/derpwire"
	"github.com/sovereign/proxy/v4/pkg/transport"
	"golang.zx2c4.com/wireguard/conn"
)

type endpoint struct {
	relay string
	key   [32]byte
}

func (e *endpoint) ClearSrc()           {}
func (e *endpoint) SrcToString() string { return "" }
func (e *endpoint) DstToString() string { return e.relay + "/" + hex.EncodeToString(e.key[:]) }
func (e *endpoint) DstToBytes() []byte  { return []byte(e.DstToString()) }
func (e *endpoint) DstIP() netip.Addr   { return netip.Addr{} }
func (e *endpoint) SrcIP() netip.Addr   { return netip.Addr{} }

func parse(s string) (conn.Endpoint, error) {
	id, pub, ok := strings.Cut(s, "/")
	if !ok || id == "" || strings.ContainsAny(id, " /?#:\\") {
		return nil, errors.New("DERP: invalid relay ID")
	}
	decoded, err := hex.DecodeString(pub)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("DERP: invalid peer identity")
	}
	e := &endpoint{relay: id}
	copy(e.key[:], decoded)
	return e, nil
}

type received struct {
	endpoint *endpoint
	packet   []byte
}
type bind struct {
	cfg     transport.Config
	mu      sync.Mutex
	pool    *derpwire.Pool
	packets chan received
	closed  chan struct{}
	once    sync.Once
}

func (b *bind) Open(uint16) ([]conn.ReceiveFunc, uint16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.packets = make(chan received, 256)
	b.closed = make(chan struct{})
	p, err := derpwire.NewPool(b.cfg.PrivateKey, b.cfg.TLSConfig, func(relay string, src [32]byte, payload []byte) {
		select {
		case b.packets <- received{&endpoint{relay, src}, payload}:
		case <-b.closed:
		default:
		}
	}, b.cfg.Logf)
	if err != nil {
		return nil, 0, err
	}
	b.pool = p
	if err := p.Configure(relays(b.cfg)); err != nil {
		_ = p.Close()
		return nil, 0, err
	}
	return []conn.ReceiveFunc{b.receive}, 0, nil
}

func relays(cfg transport.Config) []derpwire.Relay {
	out := make([]derpwire.Relay, 0, len(cfg.Relays))
	for _, r := range cfg.Relays {
		out = append(out, derpwire.Relay{ID: r.Region, URL: r.URL})
	}
	return out
}

func (b *bind) receive(packets [][]byte, sizes []int, endpoints []conn.Endpoint) (int, error) {
	select {
	case <-b.closed:
		return 0, net.ErrClosed
	case p := <-b.packets:
		if len(p.packet) > len(packets[0]) {
			return 0, errors.New("DERP: receive buffer too short")
		}
		copy(packets[0], p.packet)
		sizes[0] = len(p.packet)
		endpoints[0] = p.endpoint
		return 1, nil
	}
}

func (b *bind) Send(packets [][]byte, ep conn.Endpoint) error {
	e, ok := ep.(*endpoint)
	if !ok {
		return conn.ErrWrongEndpointType
	}
	b.mu.Lock()
	p := b.pool
	b.mu.Unlock()
	if p == nil {
		return net.ErrClosed
	}
	for _, packet := range packets {
		if err := p.Send(e.relay, e.key, packet); err != nil {
			return err
		}
	}
	return nil
}

func (b *bind) SetMark(uint32) error { return nil }
func (b *bind) Close() error {
	b.mu.Lock()
	p := b.pool
	b.pool = nil
	b.mu.Unlock()
	b.once.Do(func() {
		if b.closed != nil {
			close(b.closed)
		}
	})
	if p != nil {
		return p.Close()
	}
	return nil
}
func (b *bind) Reconfigure(cfg transport.Config) {
	b.mu.Lock()
	b.cfg = cfg
	p := b.pool
	b.mu.Unlock()
	if p != nil {
		_ = p.Configure(relays(cfg))
	}
}
func (b *bind) Homes() []string {
	b.mu.Lock()
	p := b.pool
	b.mu.Unlock()
	if p == nil {
		return nil
	}
	return p.Homes()
}

func init() {
	transport.Register(transport.Spec{Name: transport.DERP, New: func(cfg transport.Config) (transport.Transport, error) { return &bind{cfg: cfg}, nil }, ParseEndpoint: parse, BatchSize: 1})
}
