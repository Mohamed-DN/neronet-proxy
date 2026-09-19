package control

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/routing"
)

var (
	ErrNodeNotFound = errors.New("node not registered in control plane")
)

// EndpointDesc describes an address endpoint
type EndpointDesc struct {
	IPAddress        string `json:"ip_address"`
	Port             uint32 `json:"port"`
	Protocol         string `json:"protocol"` // "udp", "tcp", "ws", "http3"
	IsSTUNDiscovered bool   `json:"is_stun_discovered"`
}

// CapabilityDesc describes exit bridge capabilities
type CapabilityDesc struct {
	Enabled              bool   `json:"enabled"`
	CountryCode          string `json:"country_code"`
	City                 string `json:"city"`
	ASN                  uint32 `json:"asn"`
	IPClass              string `json:"ip_class"` // "RESIDENTIAL", "MOBILE_5G", "DATACENTER"
	MaxBandwidthKbps     uint32 `json:"max_bandwidth_kbps"`
	MaxConcurrentStreams uint32 `json:"max_concurrent_streams"`
	AllowUDP             bool   `json:"allow_udp"`
	ACPowerOnly          bool   `json:"ac_power_only"`
}

// NodeRecord contains full node state inside the control plane
type NodeRecord struct {
	NodeID          string
	PublicKey       [crypto.KeySize]byte
	Role            string // "CLIENT_ORIGIN", "EXIT_BRIDGE", "HYBRID", "RELAY"
	OverlayIPv4     string
	OverlayIPv6     string
	Endpoints       []EndpointDesc
	Capability      CapabilityDesc
	RegisteredAt    time.Time
	LastHeartbeat   time.Time
	IsHealthy       bool
	ActiveCircuits  uint32
	CPUUsagePct     uint32
	MemoryUsageMB   uint32
	BatteryLevelPct uint32
	OnBatteryPower  bool
	Metrics         routing.NodeMetrics
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

// Registry maintains all registered nodes, active relays, and revoked keys
type Registry struct {
	mu          sync.RWMutex
	nodes       map[string]*NodeRecord
	relays      map[string]*RelayDesc
	revokedKeys map[string]bool
	epoch       uint64
}

// NewRegistry creates a new Node Registry
func NewRegistry() *Registry {
	return &Registry{
		nodes:       make(map[string]*NodeRecord),
		relays:      make(map[string]*RelayDesc),
		revokedKeys: make(map[string]bool),
		epoch:       1,
	}
}

// RegisterNode stores or updates a node registration
func (r *Registry) RegisterNode(rec *NodeRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()

	rec.RegisteredAt = time.Now()
	rec.LastHeartbeat = time.Now()
	rec.IsHealthy = true
	r.nodes[rec.NodeID] = rec
	r.epoch++
}

// AddRelay registers a DERP relay endpoint
func (r *Registry) AddRelay(relay *RelayDesc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.relays[relay.RelayID] = relay
	r.epoch++
}

// Heartbeat updates node metrics and liveness
func (r *Registry) Heartbeat(
	nodeID string,
	endpoints []EndpointDesc,
	circuits uint32,
	cpu uint32,
	mem uint32,
	bat uint32,
	onBat bool,
) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	node, ok := r.nodes[nodeID]
	if !ok {
		return ErrNodeNotFound
	}

	node.LastHeartbeat = time.Now()
	node.IsHealthy = true
	if len(endpoints) > 0 {
		node.Endpoints = endpoints
	}
	node.ActiveCircuits = circuits
	node.CPUUsagePct = cpu
	node.MemoryUsageMB = mem
	node.BatteryLevelPct = bat
	node.OnBatteryPower = onBat

	// Update routing metrics
	node.Metrics.AvailableBandwidthMbps = float64(node.Capability.MaxBandwidthKbps) / 1000.0
	node.Metrics.MaxBandwidthMbps = 100.0
	node.Metrics.ReputationScore = 0.95
	node.Metrics.RTTms = 20.0
	node.Metrics.PacketLossRate = 0.0

	return nil
}

// GetNode looks up a single node record
func (r *Registry) GetNode(nodeID string) (*NodeRecord, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	node, ok := r.nodes[nodeID]
	if !ok {
		return nil, ErrNodeNotFound
	}
	return node, nil
}

// ListNodes returns all registered nodes
func (r *Registry) ListNodes() []*NodeRecord {
	r.mu.RLock()
	defer r.mu.RUnlock()

	list := make([]*NodeRecord, 0, len(r.nodes))
	for _, n := range r.nodes {
		list = append(list, n)
	}
	return list
}

// DeleteNode removes a node from the registry
func (r *Registry) DeleteNode(nodeID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, ok := r.nodes[nodeID]; !ok {
		return ErrNodeNotFound
	}
	delete(r.nodes, nodeID)
	r.epoch++
	return nil
}

// DiscoverBridges queries online exit bridges matching criteria
func (r *Registry) DiscoverBridges(country string, asn uint32, ipClass string, limit int) []*NodeRecord {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var matches []*NodeRecord
	targetCC := strings.ToUpper(country)

	for _, n := range r.nodes {
		if !n.IsHealthy || !n.Capability.Enabled {
			continue
		}
		if n.Role != "EXIT_BRIDGE" && n.Role != "HYBRID" {
			continue
		}
		if targetCC != "" && strings.ToUpper(n.Capability.CountryCode) != targetCC {
			continue
		}
		if asn > 0 && n.Capability.ASN != asn {
			continue
		}
		if ipClass != "" && n.Capability.IPClass != ipClass {
			continue
		}

		matches = append(matches, n)
		if limit > 0 && len(matches) >= limit {
			break
		}
	}

	return matches
}

// RelaysList returns all active relay nodes
func (r *Registry) RelaysList() []*RelayDesc {
	r.mu.RLock()
	defer r.mu.RUnlock()

	list := make([]*RelayDesc, 0, len(r.relays))
	for _, relay := range r.relays {
		list = append(list, relay)
	}
	return list
}

// Epoch returns the current topology version
func (r *Registry) Epoch() uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.epoch
}

// RevokeKey adds a compromised public key to the revocation list
func (r *Registry) RevokeKey(pubKeyHex string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.revokedKeys[pubKeyHex] = true
	r.epoch++
}

// IsKeyRevoked checks if a public key is revoked
func (r *Registry) IsKeyRevoked(pubKeyHex string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.revokedKeys[pubKeyHex]
}

// CheckStaleNodes marks nodes that haven't sent heartbeats within timeout as unhealthy
func (r *Registry) CheckStaleNodes(timeout time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	for _, n := range r.nodes {
		if now.Sub(n.LastHeartbeat) > timeout {
			n.IsHealthy = false
		}
	}
}

// GenerateNodeID formats static public key into hex Node ID
func GenerateNodeID(pubKey [crypto.KeySize]byte) string {
	return fmt.Sprintf("pk_%x", pubKey[:8])
}
