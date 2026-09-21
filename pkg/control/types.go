package control

import (
	"encoding/json"
	"fmt"
	"net"
	"strconv"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/posture"
	"github.com/sovereign/proxy/v4/pkg/routes"
)

// GenerateNodeID formats static public key into hex Node ID
func GenerateNodeID(pubKey [crypto.KeySize]byte) string {
	return fmt.Sprintf("pk_%x", pubKey[:8])
}

// EndpointDesc describes an address endpoint
type EndpointDesc struct {
	IPAddress        string `json:"ip_address"`
	Port             uint32 `json:"port"`
	Protocol         string `json:"protocol"` // "udp", "tcp", "ws", "http3"
	IsSTUNDiscovered bool   `json:"is_stun_discovered"`
}

// UnmarshalJSON unmarshals either an object or a bare "ip:port" string into EndpointDesc
func (e *EndpointDesc) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		host, portStr, err := net.SplitHostPort(s)
		if err != nil {
			return err
		}
		port, err := strconv.ParseUint(portStr, 10, 32)
		if err != nil {
			return err
		}
		e.IPAddress = host
		e.Port = uint32(port)
		e.Protocol = "udp"
		return nil
	}
	type Alias EndpointDesc
	var a Alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*e = EndpointDesc(a)
	return nil
}

// CapabilityDesc describes exit bridge capabilities
type CapabilityDesc struct {
	Enabled bool `json:"enabled,omitempty"`

	// CountryCode is declared by the operator, not measured. The node has no way to
	// establish where it is.
	CountryCode string `json:"country_code,omitempty"`

	// City, Latitude and Longitude are declared by the operator, not measured, and
	// are omitted from the wire when the operator declared nothing.
	City      string   `json:"city,omitempty"`
	Latitude  *float64 `json:"latitude,omitempty"`
	Longitude *float64 `json:"longitude,omitempty"`

	// ASN is 0 when it was not measured. The node does not resolve its own ASN.
	ASN uint32 `json:"asn,omitempty"`

	// IPClass is "UNKNOWN" unless the operator declares otherwise.
	IPClass string `json:"ip_class,omitempty"` // "RESIDENTIAL", "MOBILE_5G", "DATACENTER", "UNKNOWN"

	// MaxBandwidthKbps is 0 when it was not measured or declared. Nothing on the
	// node measures a line rate.
	MaxBandwidthKbps     uint32 `json:"max_bandwidth_kbps,omitempty"`
	MaxConcurrentStreams uint32 `json:"max_concurrent_streams,omitempty"`
	AllowUDP             bool   `json:"allow_udp,omitempty"`
	ACPowerOnly          bool   `json:"ac_power_only,omitempty"`
}

// RelayDesc represents a known DERP-v4 relay node
type RelayDesc struct {
	RelayID       string               `json:"relay_id"`
	Hostname      string               `json:"hostname"`
	Region        string               `json:"region"`
	TCPPort       uint32               `json:"tcp_port"`
	UDPPort       uint32               `json:"udp_port"`
	PublicKey     [crypto.KeySize]byte `json:"public_key"`
	SupportsHTTP3 bool                 `json:"supports_http3"`
}

// --- Request / Response JSON Structs ---

type ChallengeRequest struct {
	PublicKeyHex string `json:"public_key_hex,omitempty"`
}

type ChallengeResponse struct {
	Nonce              string `json:"nonce"`
	ControlPlanePubHex string `json:"cp_public_key"`
	ExpiresAt          string `json:"expires_at"`
}

type RegisterRequest struct {
	PublicKeyHex  string         `json:"public_key_hex"`
	Role          string         `json:"role,omitempty"`
	Endpoints     []EndpointDesc `json:"endpoints,omitempty"`
	AuthToken     string         `json:"auth_token,omitempty"`
	ClientVersion string         `json:"client_version,omitempty"`
	OSArch        string         `json:"os_arch,omitempty"`
	Capability    CapabilityDesc `json:"capability,omitempty"`
	PreAuthKey    string         `json:"preauth_key,omitempty"`
	Nonce         string         `json:"nonce,omitempty"`
	Proof         string         `json:"proof,omitempty"`
}

type RegisterResponse struct {
	AssignedNodeID      string       `json:"assigned_node_id"`
	OverlayIPv4         string       `json:"overlay_ipv4"`
	OverlayIPv6         string       `json:"overlay_ipv6"`
	Relays              []*RelayDesc `json:"relays"`
	LeaseExpiryUTC      uint64       `json:"lease_expiry_utc"`
	NetworkPSKHex       string       `json:"network_psk_hex"`
	PolicyEpoch         uint64       `json:"policy_epoch"`
	RouteEpoch          uint64       `json:"route_epoch"`
	Credential          string       `json:"credential,omitempty"`
	CredentialExpiresAt string       `json:"credential_expires_at,omitempty"`
}

type HeartbeatRequest struct {
	NodeID          string         `json:"node_id"`
	SequenceNum     uint64         `json:"sequence_num,omitempty"`
	Endpoints       []EndpointDesc `json:"endpoints,omitempty"`
	ActiveCircuits  uint32         `json:"active_circuits,omitempty"`
	TxBytesSec      uint32         `json:"tx_bytes_sec,omitempty"`
	RxBytesSec      uint32         `json:"rx_bytes_sec,omitempty"`
	CPUUsagePct     uint32         `json:"cpu_usage_pct,omitempty"`
	MemoryUsageMB   uint32         `json:"memory_usage_mb,omitempty"`
	BatteryLevelPct uint32         `json:"battery_level_pct,omitempty"`
	OnBatteryPower  bool           `json:"on_battery_power,omitempty"`

	// RTTMillis is the round trip the node measured on its previous heartbeat.
	// It is the one latency figure a node can obtain without extra traffic, and it
	// is what the console's per-country latency column reports; before this existed
	// the column had nothing behind it and the control plane substituted a constant.
	// Zero means not yet measured, which is the case on the first heartbeat.
	RTTMillis uint32 `json:"rtt_ms,omitempty"`

	Posture *posture.PeerAttestation `json:"posture,omitempty"`
}

type HeartbeatResponse struct {
	Acknowledged        bool     `json:"acknowledged"`
	ForceRekey          bool     `json:"force_rekey"`
	DrainAndExit        bool     `json:"drain_and_exit"`
	RevokedKeys         []string `json:"revoked_keys"`
	IsQuarantined       bool     `json:"is_quarantined"`
	QuarantineReason    string   `json:"quarantine_reason,omitempty"`
	PolicyEpoch         uint64   `json:"policy_epoch"`
	RouteEpoch          uint64   `json:"route_epoch"`

	// NetmapVersion is the one number a node with a data plane compares against what
	// it holds. It advances on anything that changes who may reach whom: a rule, a
	// route, a registration or removal, a quarantine, a revocation, a health
	// transition, or a peer's endpoints. Zero from a control plane that does not
	// serve netmaps, which is why the node treats zero as "nothing to fetch".
	NetmapVersion       uint64   `json:"netmap_version"`
	NewCredential       string   `json:"new_credential,omitempty"`
	CredentialExpiresAt string   `json:"credential_expires_at,omitempty"`
}

type DiscoverRequest struct {
	TargetCountry  string `json:"target_country,omitempty"`
	TargetASN      uint32 `json:"target_asn,omitempty"`
	IPClass        string `json:"ip_class,omitempty"`
	ExplicitHostID string `json:"explicit_host_id,omitempty"`
	Limit          int    `json:"limit,omitempty"`
}

type DiscoveredBridgeInfo struct {
	NodeID       string         `json:"node_id"`
	PublicKeyHex string         `json:"public_key_hex"`
	OverlayIPv4  string         `json:"overlay_ipv4"`
	Endpoints    []EndpointDesc `json:"endpoints"`
	Capability   CapabilityDesc `json:"capability"`
	Score        float64        `json:"score"`
}

type DiscoverResponse struct {
	Bridges []DiscoveredBridgeInfo `json:"bridges"`
}

type CircuitRequest struct {
	TargetCountry string `json:"target_country"`
	HopCount      int    `json:"hop_count,omitempty"`
	NodeID        string `json:"node_id,omitempty"`
}

type HopInfo struct {
	HopIndex     int            `json:"hop_index"`
	NodeID       string         `json:"node_id"`
	PublicKeyHex string         `json:"public_key_hex"`
	Endpoints    []EndpointDesc `json:"endpoints"`
}

// CircuitDiversity states how independent a selected path actually is.
//
// A three-hop circuit whose hops share an operator or an autonomous system protects
// nothing against that party: they observe entry and exit and can correlate them. A
// self-hosted mesh has one operator by definition and onion routing still hides its
// traffic from network observers and from the destination -- so the path is built,
// and this says what it is. A caller must never believe it has anonymity it does not.
type CircuitDiversity struct {
	DistinctOperators bool   `json:"distinct_operators"`
	DistinctNetworks  bool   `json:"distinct_networks"`
	OperatorCount     int    `json:"operator_count"`
	NetworkCount      int    `json:"network_count"`
	Note              string `json:"note"`
}

type CircuitResponse struct {
	CircuitID       uint32           `json:"circuit_id"`
	Hops            []HopInfo        `json:"hops"`
	ExpiryTimestamp uint64           `json:"expiry_timestamp"`
	Diversity       CircuitDiversity `json:"diversity"`
}

type SyncRequest struct {
	NodeID       string `json:"node_id"`
	CurrentEpoch uint64 `json:"current_epoch"`
}

type SyncResponse struct {
	NewEpoch uint64       `json:"new_epoch"`
	Relays   []*RelayDesc `json:"relays"`
}

type ACLSyncRequest struct {
	NodeID      string `json:"node_id"`
	PolicyEpoch uint64 `json:"policy_epoch,omitempty"`
}

type ACLSyncResponse struct {
	NewPolicyEpoch uint64                  `json:"new_policy_epoch"`
	Policy         *acl.CompiledPeerPolicy `json:"policy" jsonschema:"nullable"`
}

type RouteSyncRequest struct {
	NodeID     string `json:"node_id"`
	RouteEpoch uint64 `json:"route_epoch,omitempty"`
}

type RouteSyncResponse struct {
	NewRouteEpoch uint64                 `json:"new_route_epoch"`
	Routes        []*routes.NetworkRoute `json:"routes"`
}

// NetmapRequest asks for the document. Version is what the node currently holds, 0
// when it holds none.
type NetmapRequest struct {
	NodeID  string `json:"node_id"`
	Version uint64 `json:"version,omitempty"`
}

// NetmapSelf is how this node is addressed inside the overlay.
type NetmapSelf struct {
	OverlayIPv4 string `json:"overlay_ipv4"`
	OverlayIPv6 string `json:"overlay_ipv6"`

	// MTU is a configured constant, not a discovered one. A path that cannot carry
	// it will black-hole large packets; there is no MTU discovery yet.
	MTU int `json:"mtu"`

	// ListenPort is the UDP port every node in the deployment binds for WireGuard.
	ListenPort uint16 `json:"listen_port"`
}

// NetmapPeer is one node this node may talk to.
type NetmapPeer struct {
	NodeID string `json:"node_id"`

	// PublicKeyHex is the peer's X25519 identity key, which is also its WireGuard
	// key. There is no second key hierarchy.
	PublicKeyHex string `json:"public_key_hex"`

	// AllowedIPs are the prefixes this peer may use as a source address and that are
	// routed to it: its overlay /32 and /128, plus any subnet the policy lets this
	// node reach through it.
	AllowedIPs []string `json:"allowed_ips"`

	// Endpoints are candidate "ip:port" addresses, IPv6 bracketed. Empty means the
	// peer is only reachable once it has spoken first.
	Endpoints []string `json:"endpoints"`

	// DERPRegion is a pointer so null is allowed when unmeasured.
	DERPRegion *string `json:"derp_region" jsonschema:"nullable"`

	KeepaliveSeconds uint16 `json:"keepalive_seconds"`
}

// NetmapResponse is the document. When Unchanged is true the node already holds this
// version and every other field is absent.
type NetmapResponse struct {
	Version   uint64 `json:"version"`
	Unchanged bool   `json:"unchanged"`

	Self        NetmapSelf              `json:"self,omitempty"`
	Peers       []NetmapPeer            `json:"peers,omitempty"`
	ACL         *acl.CompiledPeerPolicy `json:"acl,omitempty"`
	Routes      []*routes.NetworkRoute  `json:"routes,omitempty"`
	RevokedKeys []string                `json:"revoked_keys,omitempty"`

	// GeneratedAtUnix is the control plane's clock when the document was built. The
	// node measures staleness against it.
	GeneratedAtUnix int64 `json:"generated_at_unix,omitempty"`

	// MaxStalenessSeconds is how long the node may keep running on this document
	// with the control plane unreachable. Past it the node removes every peer.
	MaxStalenessSeconds int64 `json:"max_staleness_seconds,omitempty"`
}
