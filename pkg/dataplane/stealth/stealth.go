package stealth

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"sync"
)

// Supported transport protocols in NeroNet v4
const (
	TransportWireGuard = "wireguard"
	TransportAmneziaWG = "amneziawg"
	TransportOpenVPN   = "openvpn"
	TransportVLESS     = "vless"
)

// Standard WireGuard message types (RFC WireGuard protocol)
const (
	TypeMessageInitiation = 1
	TypeMessageResponse   = 2
	TypeMessageCookie     = 3
	TypeMessageData       = 4
)

// Standard WireGuard packet exact sizes
const (
	SizeMessageInitiation = 148
	SizeMessageResponse   = 92
	SizeMessageCookie     = 64
	MinMessageData        = 32
)

// Config defines the AmneziaWG stealth obfuscation parameters.
type Config struct {
	// Jc is the number of randomized junk packets sent before initiation.
	Jc uint32 `json:"jc"`

	// Jmin is the minimum byte size of junk packets.
	Jmin uint32 `json:"jmin"`

	// Jmax is the maximum byte size of junk packets.
	Jmax uint32 `json:"jmax"`

	// S1 is the random padding size appended to handshake initiation.
	S1 uint32 `json:"s1"`

	// S2 is the random padding size appended to handshake response.
	S2 uint32 `json:"s2"`

	// H1..H4 are the custom magic headers replacing standard types 1..4.
	H1 uint32 `json:"h1"`
	H2 uint32 `json:"h2"`
	H3 uint32 `json:"h3"`
	H4 uint32 `json:"h4"`

	// Disguise specifies the fake protocol envelope ('none', 'dns', 'quic').
	Disguise string `json:"disguise"`
}

// DefaultConfig returns robust, battle-tested defaults for AmneziaWG obfuscation.
func DefaultConfig() Config {
	return Config{
		Jc:       4,
		Jmin:     40,
		Jmax:     128,
		S1:       56,
		S2:       48,
		H1:       0xa1b2c3d4,
		H2:       0xd4c3b2a1,
		H3:       0xe5f60718,
		H4:       0x1807f6e5,
		Disguise: "none",
	}
}

// Validate checks whether the stealth configuration parameters are valid.
func (c *Config) Validate() error {
	if c.Jmin > c.Jmax {
		return errors.New("stealth: jmin cannot be greater than jmax")
	}
	if c.H1 == 0 || c.H2 == 0 || c.H3 == 0 || c.H4 == 0 {
		return errors.New("stealth: custom magic headers H1..H4 must be non-zero")
	}
	if c.H1 == c.H2 || c.H1 == c.H3 || c.H1 == c.H4 || c.H2 == c.H3 || c.H2 == c.H4 || c.H3 == c.H4 {
		return errors.New("stealth: custom magic headers H1..H4 must be unique")
	}
	return nil
}

// Obfuscator performs AmneziaWG packet wrapping and unwrapping.
type Obfuscator struct {
	cfg Config
}

// NewObfuscator instantiates a stealth obfuscator with the given configuration.
func NewObfuscator(cfg Config) (*Obfuscator, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Obfuscator{cfg: cfg}, nil
}

// Wrap transforms an outbound standard WireGuard packet into an AmneziaWG stealth packet.
func (o *Obfuscator) Wrap(packet []byte) []byte {
	if len(packet) < 4 {
		return packet
	}

	msgType := binary.LittleEndian.Uint32(packet[:4])
	var out []byte

	switch msgType {
	case TypeMessageInitiation:
		// Handshake Initiation: Replace header with H1, append S1 random bytes
		padLen := int(o.cfg.S1)
		out = make([]byte, len(packet)+padLen)
		copy(out, packet)
		binary.LittleEndian.PutUint32(out[:4], o.cfg.H1)
		if padLen > 0 {
			_, _ = rand.Read(out[len(packet):])
		}

	case TypeMessageResponse:
		// Handshake Response: Replace header with H2, append S2 random bytes
		padLen := int(o.cfg.S2)
		out = make([]byte, len(packet)+padLen)
		copy(out, packet)
		binary.LittleEndian.PutUint32(out[:4], o.cfg.H2)
		if padLen > 0 {
			_, _ = rand.Read(out[len(packet):])
		}

	case TypeMessageCookie:
		// Cookie: Replace header with H3
		out = make([]byte, len(packet))
		copy(out, packet)
		binary.LittleEndian.PutUint32(out[:4], o.cfg.H3)

	case TypeMessageData:
		// Transport Data: Replace header with H4
		out = make([]byte, len(packet))
		copy(out, packet)
		binary.LittleEndian.PutUint32(out[:4], o.cfg.H4)

	default:
		// Unknown or already obfuscated, pass through
		return packet
	}

	// Apply protocol disguise envelope if configured
	switch o.cfg.Disguise {
	case "dns":
		// Prepend 12-byte DNS transaction header
		dnsHdr := make([]byte, 12)
		_, _ = rand.Read(dnsHdr[:2]) // Random Transaction ID
		dnsHdr[2] = 0x01             // Standard query flag
		dnsHdr[3] = 0x00             //
		dnsHdr[5] = 0x01             // 1 question
		out = append(dnsHdr, out...)
	case "quic":
		// Prepend 1-byte QUIC short header flag
		quicHdr := []byte{0x40} // QUIC fixed bit set, 1-RTT packet flag
		out = append(quicHdr, out...)
	}

	return out
}

// Unwrap transforms an inbound AmneziaWG stealth packet back into a standard WireGuard packet.
// Returns (cleanPacket, isJunk). If isJunk is true, the packet should be silently discarded.
func (o *Obfuscator) Unwrap(packet []byte) ([]byte, bool) {
	if len(packet) < 4 {
		return nil, true
	}

	data := packet

	// Strip protocol disguise envelope if configured
	switch o.cfg.Disguise {
	case "dns":
		if len(data) < 16 {
			return nil, true
		}
		data = data[12:]
	case "quic":
		if len(data) < 5 {
			return nil, true
		}
		data = data[1:]
	}

	if len(data) < 4 {
		return nil, true
	}

	magic := binary.LittleEndian.Uint32(data[:4])

	switch magic {
	case o.cfg.H1:
		// Handshake Initiation: check size, truncate S1 padding, restore Type 1
		expectedMin := SizeMessageInitiation
		if len(data) < expectedMin {
			return nil, true
		}
		out := make([]byte, SizeMessageInitiation)
		copy(out, data[:SizeMessageInitiation])
		binary.LittleEndian.PutUint32(out[:4], TypeMessageInitiation)
		return out, false

	case o.cfg.H2:
		// Handshake Response: check size, truncate S2 padding, restore Type 2
		expectedMin := SizeMessageResponse
		if len(data) < expectedMin {
			return nil, true
		}
		out := make([]byte, SizeMessageResponse)
		copy(out, data[:SizeMessageResponse])
		binary.LittleEndian.PutUint32(out[:4], TypeMessageResponse)
		return out, false

	case o.cfg.H3:
		// Cookie reply: restore Type 3
		if len(data) < SizeMessageCookie {
			return nil, true
		}
		out := make([]byte, len(data))
		copy(out, data)
		binary.LittleEndian.PutUint32(out[:4], TypeMessageCookie)
		return out, false

	case o.cfg.H4:
		// Data packet: restore Type 4
		if len(data) < MinMessageData {
			return nil, true
		}
		out := make([]byte, len(data))
		copy(out, data)
		binary.LittleEndian.PutUint32(out[:4], TypeMessageData)
		return out, false

	case TypeMessageInitiation, TypeMessageResponse, TypeMessageCookie, TypeMessageData:
		// Standard WireGuard packet allowed as fallback
		return data, false

	default:
		// Junk packet or unknown packet: discard
		return nil, true
	}
}

// GenerateJunk creates Jc randomized junk packets of lengths between Jmin and Jmax.
func (o *Obfuscator) GenerateJunk() [][]byte {
	if o.cfg.Jc == 0 {
		return nil
	}

	junkPackets := make([][]byte, 0, o.cfg.Jc)
	diff := int64(o.cfg.Jmax - o.cfg.Jmin)

	for i := uint32(0); i < o.cfg.Jc; i++ {
		var sz int
		if diff <= 0 {
			sz = int(o.cfg.Jmin)
		} else {
			n, err := rand.Int(rand.Reader, big.NewInt(diff+1))
			if err != nil {
				sz = int(o.cfg.Jmin)
			} else {
				sz = int(o.cfg.Jmin) + int(n.Int64())
			}
		}

		pkt := make([]byte, sz)
		_, _ = rand.Read(pkt)
		// Ensure first 4 bytes do not accidentally match any magic or standard header
		if len(pkt) >= 4 {
			h := binary.LittleEndian.Uint32(pkt[:4])
			if h == o.cfg.H1 || h == o.cfg.H2 || h == o.cfg.H3 || h == o.cfg.H4 ||
				h == TypeMessageInitiation || h == TypeMessageResponse ||
				h == TypeMessageCookie || h == TypeMessageData {
				binary.LittleEndian.PutUint32(pkt[:4], 0xdeadbeef)
			}
		}
		junkPackets = append(junkPackets, pkt)
	}

	return junkPackets
}

// TransportManager coordinates multi-protocol transport configurations across mesh peers.
type TransportManager struct {
	mu             sync.RWMutex
	localTransport string
	localStealth   Config
	peerTransports map[string]string // peerPubHex -> transport ("wireguard", "amneziawg", "openvpn", "vless")
	peerStealth    map[string]Config // peerPubHex -> Config
}

// NewTransportManager initializes a multi-protocol transport manager.
func NewTransportManager(localTransport string, localStealth Config) *TransportManager {
	if localTransport == "" {
		localTransport = TransportWireGuard
	}
	return &TransportManager{
		localTransport: localTransport,
		localStealth:   localStealth,
		peerTransports: make(map[string]string),
		peerStealth:    make(map[string]Config),
	}
}

// SetPeerTransport updates the preferred transport and stealth configuration for a peer.
func (m *TransportManager) SetPeerTransport(peerPubHex string, transport string, stealth Config) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if transport == "" {
		transport = m.localTransport
	}
	m.peerTransports[peerPubHex] = transport
	m.peerStealth[peerPubHex] = stealth
}

// GetEffectiveTransport returns the negotiated transport and stealth config for a given peer.
func (m *TransportManager) GetEffectiveTransport(peerPubHex string) (string, Config) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	t, ok := m.peerTransports[peerPubHex]
	if !ok || t == "" {
		t = m.localTransport
	}

	s, ok := m.peerStealth[peerPubHex]
	if !ok || s.H1 == 0 {
		s = m.localStealth
	}

	return t, s
}

// OpenVPNProfileConfig represents parameters for OpenVPN fallback encapsulation.
type OpenVPNProfileConfig struct {
	RemoteHost string
	RemotePort uint16
	Proto      string // "tcp" or "udp"
	Cipher     string // "AES-256-GCM"
}

// GenerateOpenVPNConfig generates a client configuration stanza for OpenVPN fallback.
func GenerateOpenVPNConfig(cfg OpenVPNProfileConfig) string {
	proto := cfg.Proto
	if proto == "" {
		proto = "tcp"
	}
	port := cfg.RemotePort
	if port == 0 {
		port = 443
	}
	cipher := cfg.Cipher
	if cipher == "" {
		cipher = "AES-256-GCM"
	}

	return fmt.Sprintf(`client
dev tun
proto %s
remote %s %d
resolv-retry infinite
nobind
persist-key
persist-tun
cipher %s
auth SHA256
verb 3
`, proto, cfg.RemoteHost, port, cipher)
}

// VLESSProfileConfig represents parameters for VLESS / Xray WebSocket/TLS fallback.
type VLESSProfileConfig struct {
	UUID       string
	RemoteHost string
	RemotePort uint16
	Path       string
	Sni        string
}

// GenerateVLESSURI formats a client connection URI for VLESS fallback over TLS.
func GenerateVLESSURI(cfg VLESSProfileConfig) string {
	port := cfg.RemotePort
	if port == 0 {
		port = 443
	}
	path := cfg.Path
	if path == "" {
		path = "/neronet-vless"
	}
	sni := cfg.Sni
	if sni == "" {
		sni = cfg.RemoteHost
	}

	return fmt.Sprintf("vless://%s@%s:%d?encryption=none&security=tls&sni=%s&type=ws&path=%s#NeroNet-Mesh",
		cfg.UUID, cfg.RemoteHost, port, sni, path)
}
