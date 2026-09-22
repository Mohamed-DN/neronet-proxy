// Package dataplane carries node traffic inside a WireGuard tunnel.
//
// The node has no data plane: the SOCKS5 and HTTP proxies dial targets directly and
// the overlay address the control plane assigns is configured nowhere. This package
// is the transport that decision D2 selects, wireguard-go, in the two modes the
// target architecture describes:
//
//   - ModeNetstack runs the whole IP stack in userspace (gVisor). It needs no
//     capabilities and no device node, which is what the staging containers (uid
//     10001) can have.
//   - ModeTUN uses a kernel TUN interface, for hosts and virtual machines where the
//     node holds CAP_NET_ADMIN and /dev/net/tun.
//
// The WireGuard static key is the node's existing X25519 identity key, so a peer's
// WireGuard public key is the public key the control plane already stores.
//
// Everything here is off unless a caller builds a Device, and the node only does
// that when -dataplane names a mode.
package dataplane

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"

	"github.com/sovereign/proxy/v4/pkg/dataplane/daita"
	"github.com/sovereign/proxy/v4/pkg/dataplane/stealth"
)

// Mode selects how the tunnel is attached to an IP stack.
type Mode string

const (
	// ModeOff means no data plane at all: the node behaves as it did before this
	// package existed.
	ModeOff Mode = "off"
	// ModeNetstack runs a userspace IP stack. No capabilities required.
	ModeNetstack Mode = "netstack"
	// ModeTUN uses a kernel TUN interface. Requires /dev/net/tun and CAP_NET_ADMIN.
	ModeTUN Mode = "tun"
)

// ParseMode converts a flag or environment value into a Mode.
func ParseMode(s string) (Mode, error) {
	switch Mode(strings.ToLower(strings.TrimSpace(s))) {
	case "", ModeOff:
		return ModeOff, nil
	case ModeNetstack:
		return ModeNetstack, nil
	case ModeTUN:
		return ModeTUN, nil
	default:
		return ModeOff, fmt.Errorf("unknown data plane mode %q: expected off, netstack or tun", s)
	}
}

// DefaultMTU leaves room for the WireGuard header inside a 1500 byte path.
const DefaultMTU = 1420

// DefaultListenPort is the UDP port a node binds when its configuration names none.
const DefaultListenPort = 51820

var (
	// ErrModeOff is returned by New when the configuration selects no data plane.
	ErrModeOff = errors.New("dataplane: mode is off")
	// ErrNoAddresses is returned when no overlay address was supplied. A device
	// without an address cannot receive anything, so this is a configuration
	// error rather than a degraded start.
	ErrNoAddresses = errors.New("dataplane: no overlay addresses configured")
	// ErrClosed is returned by operations on a closed Device.
	ErrClosed = errors.New("dataplane: device is closed")
)

// Config describes the local end of the tunnel.
type Config struct {
	Mode Mode

	// PrivateKey is the node's X25519 identity private key.
	PrivateKey [32]byte

	// Addresses are the overlay addresses of this node, with the prefix length of
	// the overlay range (for example 100.64.0.4/10). ModeNetstack uses the address;
	// ModeTUN uses the whole prefix, so that the peers in the range route over the
	// interface.
	Addresses []netip.Prefix

	// ListenPort is the UDP port for WireGuard. Zero asks the kernel for an
	// ephemeral port, which only makes sense for a node nobody dials first;
	// ListenPort reports what was chosen.
	ListenPort uint16

	// MTU of the overlay interface. Zero selects DefaultMTU.
	MTU int

	// InterfaceName is used in ModeTUN only. Empty selects "nero0".
	InterfaceName string

	// Filter, when set, decides packet by packet what may leave and what may be
	// delivered. Nil means no enforcement, which is what the spike measurements
	// run with. Production wiring passes an ACL-backed filter; see ACLFilter.
	Filter PacketFilter

	// Verbose turns on wireguard-go's own logging. Handshake failures are
	// invisible without it.
	Verbose bool

	// Logf receives wireguard-go log lines. Nil discards them.
	Logf func(format string, args ...any)

	// Stealth, when non-nil, enables AmneziaWG obfuscation and DPI protection.
	Stealth *stealth.Config

	// TransportMgr coordinates per-peer multi-protocol transport selection.
	TransportMgr *stealth.TransportManager

	// DaitaMode selects the DAITA protection level: "off", "balanced", or "paranoid".
	DaitaMode string
}

func (c *Config) applyDefaults() {
	if c.MTU == 0 {
		c.MTU = DefaultMTU
	}
	if c.InterfaceName == "" {
		c.InterfaceName = "nero0"
	}
}

// Peer is one reachable node in the overlay.
type Peer struct {
	// PublicKey is the peer's X25519 identity public key, hex encoded, exactly as
	// the control plane stores it.
	PublicKey string `json:"public_key"`

	// Endpoint is the peer's UDP address (host:port). Empty means the peer is only
	// reachable once it has spoken first, or over a relay.
	Endpoint string `json:"endpoint"`

	// AllowedIPs are the overlay prefixes this peer may use as a source address and
	// that are routed to it.
	AllowedIPs []netip.Prefix `json:"allowed_ips"`

	// PersistentKeepalive in seconds. Zero disables it. A node behind NAT needs a
	// non-zero value for the mapping to survive.
	PersistentKeepalive uint16 `json:"persistent_keepalive,omitempty"`

	// PresharedKey is hex encoded and optional. Rosenpass will drive this field;
	// nothing sets it yet.
	PresharedKey string `json:"preshared_key,omitempty"`

	// Transport specifies the peer's preferred transport protocol ("wireguard", "amneziawg", "openvpn", "vless").
	Transport string `json:"transport,omitempty"`

	// Stealth carries AmneziaWG parameters when Transport is "amneziawg".
	Stealth *stealth.Config `json:"stealth,omitempty"`
}

func (p Peer) validate() error {
	if _, err := decodeKey(p.PublicKey); err != nil {
		return fmt.Errorf("peer public key: %w", err)
	}
	if p.PresharedKey != "" {
		if _, err := decodeKey(p.PresharedKey); err != nil {
			return fmt.Errorf("peer %.8s preshared key: %w", p.PublicKey, err)
		}
	}
	if len(p.AllowedIPs) == 0 {
		return fmt.Errorf("peer %.8s has no allowed IPs: it would never be selected for any packet", p.PublicKey)
	}
	if p.Endpoint != "" {
		if _, _, err := net.SplitHostPort(p.Endpoint); err != nil {
			return fmt.Errorf("peer %.8s endpoint %q: %w", p.PublicKey, p.Endpoint, err)
		}
	}
	return nil
}

func decodeKey(s string) ([32]byte, error) {
	var k [32]byte
	raw, err := hex.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return k, fmt.Errorf("not hex: %w", err)
	}
	if len(raw) != 32 {
		return k, fmt.Errorf("is %d bytes, expected 32", len(raw))
	}
	copy(k[:], raw)
	return k, nil
}

// backend is the part of a Device that differs between the two modes.
type backend interface {
	tunDevice() tun.Device
	dialContext(ctx context.Context, network, address string) (net.Conn, error)
	listen(network, address string) (net.Listener, error)
	ping(ctx context.Context, dst netip.Addr) (time.Duration, error)
	close() error
}

// Device is a running WireGuard tunnel with an IP stack attached.
//
// It is safe for concurrent use. Close is idempotent.
type Device struct {
	mode      Mode
	addresses []netip.Prefix
	filter    *filteredTUN

	wg           *device.Device
	backing      backend
	transportMgr *stealth.TransportManager
	daitaShaper  *daita.Shaper

	mu     sync.Mutex
	closed bool
}

// New brings up a tunnel. The device has no peers until SetPeers is called, so it
// sends and receives nothing on return.
func New(cfg Config) (*Device, error) {
	if cfg.Mode == ModeOff {
		return nil, ErrModeOff
	}
	cfg.applyDefaults()

	if len(cfg.Addresses) == 0 {
		return nil, ErrNoAddresses
	}
	for _, a := range cfg.Addresses {
		if !a.Addr().IsValid() {
			return nil, fmt.Errorf("dataplane: invalid overlay address %q", a)
		}
	}

	var (
		back backend
		err  error
	)
	switch cfg.Mode {
	case ModeNetstack:
		back, err = newNetstackBackend(cfg)
	case ModeTUN:
		back, err = newTUNBackend(cfg)
	default:
		return nil, fmt.Errorf("dataplane: unsupported mode %q", cfg.Mode)
	}
	if err != nil {
		return nil, err
	}

	var shaper *daita.Shaper
	if cfg.DaitaMode != "" && cfg.DaitaMode != daita.ModeOff {
		var localVIP netip.Addr
		if len(cfg.Addresses) > 0 {
			localVIP = cfg.Addresses[0].Addr()
		}
		shaper, _ = daita.NewShaper(cfg.DaitaMode, cfg.MTU, localVIP, netip.Addr{}, nil)
	}

	filtered := newFilteredTUN(back.tunDevice(), cfg.Filter, shaper)

	level := device.LogLevelError
	if cfg.Verbose {
		level = device.LogLevelVerbose
	}
	logger := newLogger(level, cfg.Logf)

	bind := conn.NewDefaultBind()
	if cfg.Stealth != nil {
		obf, err := stealth.NewObfuscator(*cfg.Stealth)
		if err == nil {
			bind = newStealthBind(bind, obf, cfg.TransportMgr)
		}
	}

	wgDev := device.NewDevice(filtered, bind, logger)

	uapi := fmt.Sprintf("private_key=%s\nlisten_port=%d\n",
		hex.EncodeToString(cfg.PrivateKey[:]), cfg.ListenPort)
	if err := wgDev.IpcSet(uapi); err != nil {
		wgDev.Close()
		_ = filtered.Close()
		return nil, fmt.Errorf("dataplane: configuring wireguard device: %w", err)
	}

	if err := wgDev.Up(); err != nil {
		wgDev.Close()
		_ = filtered.Close()
		return nil, fmt.Errorf("dataplane: bringing wireguard device up: %w", err)
	}

	return &Device{
		mode:         cfg.Mode,
		addresses:    append([]netip.Prefix(nil), cfg.Addresses...),
		filter:       filtered,
		wg:           wgDev,
		backing:      back,
		transportMgr: cfg.TransportMgr,
		daitaShaper:  shaper,
	}, nil
}

// Mode reports which backend is running.
func (d *Device) Mode() Mode { return d.mode }

// DaitaShaper returns the active DAITA traffic shaper, if enabled.
func (d *Device) DaitaShaper() *daita.Shaper { return d.daitaShaper }

// Addresses returns the overlay prefixes configured on the device.
func (d *Device) Addresses() []netip.Prefix {
	return append([]netip.Prefix(nil), d.addresses...)
}

// LocalAddr returns the first overlay address, which is the one a peer dials.
func (d *Device) LocalAddr() netip.Addr {
	if len(d.addresses) == 0 {
		return netip.Addr{}
	}
	return d.addresses[0].Addr()
}

// SetPeers replaces the peer set in one operation.
//
// Peers are replaced rather than merged because the netmap is a complete document:
// a peer the control plane stopped sending is a peer this node must stop talking to,
// and an incremental update cannot express that. The whole set is validated before
// anything is applied, so a malformed entry leaves the previous peers in place
// instead of tearing down the overlay halfway through.
func (d *Device) SetPeers(peers []Peer) error {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return ErrClosed
	}

	seen := make(map[string]struct{}, len(peers))
	for i, p := range peers {
		if err := p.validate(); err != nil {
			return fmt.Errorf("dataplane: peer %d: %w", i, err)
		}
		key := strings.ToLower(strings.TrimSpace(p.PublicKey))
		if _, dup := seen[key]; dup {
			return fmt.Errorf("dataplane: peer %d: public key %.8s appears twice", i, key)
		}
		seen[key] = struct{}{}
	}

	var b strings.Builder
	b.WriteString("replace_peers=true\n")
	for _, p := range peers {
		fmt.Fprintf(&b, "public_key=%s\n", strings.ToLower(strings.TrimSpace(p.PublicKey)))
		fmt.Fprintf(&b, "replace_allowed_ips=true\n")
		for _, aip := range p.AllowedIPs {
			fmt.Fprintf(&b, "allowed_ip=%s\n", aip.String())
		}
		if p.Endpoint != "" {
			fmt.Fprintf(&b, "endpoint=%s\n", p.Endpoint)
		}
		if p.PresharedKey != "" {
			fmt.Fprintf(&b, "preshared_key=%s\n", strings.ToLower(strings.TrimSpace(p.PresharedKey)))
		}
		fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", p.PersistentKeepalive)
	}

	if err := d.wg.IpcSet(b.String()); err != nil {
		return fmt.Errorf("dataplane: applying %d peer(s): %w", len(peers), err)
	}

	if d.transportMgr != nil {
		for _, p := range peers {
			var st stealth.Config
			if p.Stealth != nil {
				st = *p.Stealth
			}
			d.transportMgr.SetPeerTransport(p.PublicKey, p.Transport, st)
		}
	}

	return nil
}

// UpdatePeerPSK installs or rotates the WireGuard pre-shared key for a specific peer.
// This is called by the post-quantum key exchange (Rosenpass) every rotation interval (2 minutes).
func (d *Device) UpdatePeerPSK(peerPubHex string, pskHex string) error {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return ErrClosed
	}

	pubKey := strings.ToLower(strings.TrimSpace(peerPubHex))
	if _, err := decodeKey(pubKey); err != nil {
		return fmt.Errorf("dataplane: invalid peer public key: %w", err)
	}

	psk := strings.ToLower(strings.TrimSpace(pskHex))
	if psk != "" {
		if _, err := decodeKey(psk); err != nil {
			return fmt.Errorf("dataplane: invalid preshared key: %w", err)
		}
	}

	uapi := fmt.Sprintf("public_key=%s\npreshared_key=%s\n", pubKey, psk)
	if err := d.wg.IpcSet(uapi); err != nil {
		return fmt.Errorf("dataplane: updating peer %.8s PSK: %w", pubKey, err)
	}
	return nil
}

// DialContext opens a connection to an overlay address through the tunnel.
func (d *Device) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return nil, ErrClosed
	}
	return d.backing.dialContext(ctx, network, address)
}

// Listen accepts connections addressed to this node's overlay address.
func (d *Device) Listen(network, address string) (net.Listener, error) {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return nil, ErrClosed
	}
	return d.backing.listen(network, address)
}

// Ping sends one ICMP echo request through the tunnel and waits for the reply.
//
// It is only implemented in ModeNetstack: a kernel TUN interface is reachable by
// the host's own ping, so duplicating that here would add a privileged path for no
// benefit.
func (d *Device) Ping(ctx context.Context, dst netip.Addr) (time.Duration, error) {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return 0, ErrClosed
	}
	return d.backing.ping(ctx, dst)
}

// Stats reports what the enforcement filter dropped.
func (d *Device) Stats() FilterStats { return d.filter.stats() }

// ListenPort reports the UDP port wireguard-go is actually bound to, which is not
// the configured one when the configuration asked for an ephemeral port.
func (d *Device) ListenPort() (uint16, error) {
	raw, err := d.wg.IpcGet()
	if err != nil {
		return 0, fmt.Errorf("dataplane: reading device state: %w", err)
	}
	for _, line := range strings.Split(raw, "\n") {
		if value, ok := strings.CutPrefix(strings.TrimSpace(line), "listen_port="); ok {
			port, convErr := strconv.ParseUint(value, 10, 16)
			if convErr != nil {
				return 0, fmt.Errorf("dataplane: device reported listen port %q: %w", value, convErr)
			}
			return uint16(port), nil
		}
	}
	return 0, errors.New("dataplane: device reported no listen port")
}

// PeerStatus is one line of the device's view of a peer.
type PeerStatus struct {
	PublicKey       string
	Endpoint        string
	LastHandshake   time.Time
	RxBytes         uint64
	TxBytes         uint64
	AllowedIPsCount int
}

// Peers reports what wireguard-go currently holds, which is the only honest source
// for "is the tunnel actually up": a configured peer that never handshook has a zero
// LastHandshake.
func (d *Device) Peers() ([]PeerStatus, error) {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return nil, ErrClosed
	}

	raw, err := d.wg.IpcGet()
	if err != nil {
		return nil, fmt.Errorf("dataplane: reading device state: %w", err)
	}
	return parsePeerStatus(raw), nil
}

func parsePeerStatus(raw string) []PeerStatus {
	var (
		out     []PeerStatus
		current *PeerStatus
	)
	flush := func() {
		if current != nil {
			out = append(out, *current)
			current = nil
		}
	}
	for _, line := range strings.Split(raw, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch key {
		case "public_key":
			flush()
			current = &PeerStatus{PublicKey: value}
		case "endpoint":
			if current != nil {
				current.Endpoint = value
			}
		case "last_handshake_time_sec":
			if current != nil {
				var sec int64
				fmt.Sscanf(value, "%d", &sec)
				if sec > 0 {
					current.LastHandshake = time.Unix(sec, 0)
				}
			}
		case "rx_bytes":
			if current != nil {
				fmt.Sscanf(value, "%d", &current.RxBytes)
			}
		case "tx_bytes":
			if current != nil {
				fmt.Sscanf(value, "%d", &current.TxBytes)
			}
		case "allowed_ip":
			if current != nil {
				current.AllowedIPsCount++
			}
		}
	}
	flush()
	return out
}

// Close tears the tunnel down. It is safe to call more than once.
func (d *Device) Close() error {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return nil
	}
	d.closed = true
	d.mu.Unlock()

	// wireguard-go closes the tun device it was given, which is the filtered
	// wrapper around the backend. Closing the backend again here is what makes the
	// second close happen, so it is not done.
	d.wg.Close()
	return d.filter.Close()
}

// InjectRelayPacket delivers a raw WireGuard UDP datagram received over a DERP
// relay connection to the local WireGuard engine via loopback.
//
// The packet is an encrypted WireGuard datagram — the relay is fully opaque and
// never sees the plaintext. WireGuard will authenticate it exactly as if it had
// arrived from the peer's real UDP endpoint; a tampered or replayed datagram is
// silently dropped by WireGuard's normal replay protection.
//
// The injection is performed by sending the datagram to 127.0.0.1:<listenPort>,
// which is the socket the WireGuard engine is already bound to. This path uses
// no internal wireguard-go APIs and requires no modifications to the library.
func (d *Device) InjectRelayPacket(payload []byte) error {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return ErrClosed
	}

	port, err := d.ListenPort()
	if err != nil {
		return fmt.Errorf("dataplane: inject relay: %w", err)
	}

	// Send via loopback: the WireGuard engine's UDP Bind picks this up
	// as an inbound WireGuard datagram from the loopback address.
	conn, err := net.Dial("udp4", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return fmt.Errorf("dataplane: inject relay dial: %w", err)
	}
	defer conn.Close()

	_, err = conn.Write(payload)
	return err
}

func newLogger(level int, logf func(format string, args ...any)) *device.Logger {
	if logf == nil {
		return device.NewLogger(device.LogLevelSilent, "")
	}
	l := &device.Logger{
		Verbosef: func(string, ...any) {},
		Errorf:   func(format string, args ...any) { logf("[dataplane] "+format, args...) },
	}
	if level >= device.LogLevelVerbose {
		l.Verbosef = func(format string, args ...any) { logf("[dataplane] "+format, args...) }
	}
	return l
}
