// Package transport is the layer under WireGuard that decides how its packets travel.
//
// WireGuard stays the only cryptography (ADR 0022). A transport moves WireGuard's
// already-encrypted packets and nothing else: it never sees plaintext and never
// replaces a key. Each transport is a package that registers itself here at init, so a
// build that does not link it does not contain it, and the Mux (a conn.Bind) lets
// wireguard-go use all the allowed ones at once.
//
// There are four switches, in the order a packet meets them:
//
//  1. Build. A transport that is not linked in is not in Built(). udp and derp are
//     always linked; the disguising ones sit behind the build tags notransport_obfs,
//     notransport_quic and notransport_tls (one file per transport in
//     cmd/sovereign-node, see transports_*.go).
//  2. Deployment. SOVEREIGN_TRANSPORTS on the control plane is the ceiling.
//  3. Organisation. organizations.allowed_transports, a subset of the ceiling.
//  4. Node. The netmap offers, per peer, the intersection of the organisation's list
//     with what both nodes were built with (Intersect).
//
// A transport that is not allowed is never opened, never used to send and never
// accepted from: there is no fallback to it. If no allowed transport reaches a peer,
// there is no path.
package transport

import (
	"crypto/tls"
	"errors"

	"golang.zx2c4.com/wireguard/conn"
)

// The registered names. Endpoints spell them as URL schemes: udp://203.0.113.7:51820,
// derp://eu-central/<peer key>.
const (
	UDP  = "udp"
	Obfs = "obfs"
	QUIC = "quic"
	TLS  = "tls"
	DERP = "derp"
)

// Order is the preference order, fastest first, most disguised and most relayed last.
// A node tries transports in this order and the netmap lists them in it. It is also the
// closed set of names: Register refuses anything else, so a typo fails at start-up
// instead of silently offering nothing.
var Order = []string{UDP, Obfs, QUIC, TLS, DERP}

// Rank is the position of a transport in Order, or len(Order) for an unknown name.
func Rank(name string) int {
	for i, n := range Order {
		if n == name {
			return i
		}
	}
	return len(Order)
}

// Relay is one DERP relay the control plane announced.
type Relay struct {
	// Region names the relay in endpoints (derp://<region>/<peer>).
	Region string `json:"region"`
	// URL is the relay's WebSocket address, ws:// or wss://.
	URL string `json:"url"`
}

// Config is what a transport needs from the node that is not in an endpoint.
type Config struct {
	// SelfKey is this node's WireGuard public key. DERP registers a session under it.
	SelfKey [32]byte

	// Relays are the DERP relays this node may reach. Only the derp transport reads it.
	Relays []Relay

	// TLSConfig is used for wss:// relays. Nil means the system roots.
	TLSConfig *tls.Config

	// Logf receives diagnostics. Nil discards them.
	Logf func(format string, args ...any)
}

func (c Config) logf(format string, args ...any) {
	if c.Logf != nil {
		c.Logf(format, args...)
	}
}

// Transport carries WireGuard packets one way. It is a conn.Bind without
// ParseEndpoint: parsing an endpoint needs no open socket and is a function of the
// Spec, so it works while the transport is closed.
//
// Open and Close may be called repeatedly on the same value only if the transport
// says so; the Mux asks the Spec for a fresh one on every Open.
type Transport interface {
	Open(port uint16) (fns []conn.ReceiveFunc, actualPort uint16, err error)
	Close() error
	SetMark(mark uint32) error
	Send(bufs [][]byte, ep conn.Endpoint) error
}

// Reconfigurer is implemented by a transport that can take new settings (DERP: the
// relay list) without being closed.
type Reconfigurer interface {
	Reconfigure(cfg Config)
}

// Spec describes one transport to the registry.
type Spec struct {
	// Name is one of the names in Order.
	Name string

	// New builds a closed transport.
	New func(cfg Config) (Transport, error)

	// ParseEndpoint turns the part of an endpoint after "<name>://" into the
	// transport's own endpoint.
	ParseEndpoint func(addr string) (conn.Endpoint, error)

	// BatchSize is the most buffers one Send call may carry.
	BatchSize int
}

// Errors the Mux returns. They are values so a caller can tell a refusal from a
// failure.
var (
	// ErrNotAllowed means the transport is not in the allowed set: the policy never
	// permitted it, or it was withdrawn. It is the fail-closed answer, and nothing
	// retries it over another transport.
	ErrNotAllowed = errors.New("transport: not allowed by policy")
	// ErrNoPath means the peer has no path on any allowed transport.
	ErrNoPath = errors.New("transport: no path to the peer on any allowed transport")
	// ErrNotBuilt means the transport is not linked into this binary.
	ErrNotBuilt = errors.New("transport: not built into this binary")
)
