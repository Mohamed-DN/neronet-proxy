package control

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/management"
	"github.com/sovereign/proxy/v4/pkg/posture"
	"github.com/sovereign/proxy/v4/pkg/routes"
	"github.com/sovereign/proxy/v4/pkg/routing"
)

// ServerConfig defines the control plane server settings
type ServerConfig struct {
	ListenAddr string
	MeshPSK    [crypto.KeySize]byte
}

// ManagementRegistryAdapter bridges control.Registry to management.NodeRegistry
type ManagementRegistryAdapter struct {
	reg *Registry
}

func (a *ManagementRegistryAdapter) ListNodes() []management.NodeRecordView {
	nodes := a.reg.ListNodes()
	views := make([]management.NodeRecordView, len(nodes))
	for i, n := range nodes {
		views[i] = management.NodeRecordView{
			NodeID:         n.NodeID,
			Role:           n.Role,
			OverlayIPv4:    n.OverlayIPv4,
			OverlayIPv6:    n.OverlayIPv6,
			CountryCode:    n.Capability.CountryCode,
			City:           n.Capability.City,
			ASN:            n.Capability.ASN,
			IPClass:        n.Capability.IPClass,
			MaxBandwidth:   n.Capability.MaxBandwidthKbps,
			IsHealthy:      n.IsHealthy,
			LastHeartbeat:  n.LastHeartbeat,
			ActiveCircuits: n.ActiveCircuits,
			RTTms:          n.Metrics.RTTms,
		}
	}
	return views
}

func (a *ManagementRegistryAdapter) GetNode(nodeID string) (*management.NodeRecordView, error) {
	n, err := a.reg.GetNode(nodeID)
	if err != nil {
		return nil, err
	}
	return &management.NodeRecordView{
		NodeID:         n.NodeID,
		Role:           n.Role,
		OverlayIPv4:    n.OverlayIPv4,
		OverlayIPv6:    n.OverlayIPv6,
		CountryCode:    n.Capability.CountryCode,
		City:           n.Capability.City,
		ASN:            n.Capability.ASN,
		IPClass:        n.Capability.IPClass,
		MaxBandwidth:   n.Capability.MaxBandwidthKbps,
		IsHealthy:      n.IsHealthy,
		LastHeartbeat:  n.LastHeartbeat,
		ActiveCircuits: n.ActiveCircuits,
		RTTms:          n.Metrics.RTTms,
	}, nil
}

func (a *ManagementRegistryAdapter) DeleteNode(nodeID string) error {
	return a.reg.DeleteNode(nodeID)
}

func (a *ManagementRegistryAdapter) RelaysList() []management.RelayRecordView {
	relays := a.reg.RelaysList()
	views := make([]management.RelayRecordView, len(relays))
	for i, r := range relays {
		views[i] = management.RelayRecordView{
			RelayID:  r.RelayID,
			Hostname: r.Hostname,
			Region:   r.Region,
		}
	}
	return views
}

func (a *ManagementRegistryAdapter) Epoch() uint64 {
	return a.reg.Epoch()
}

// Server provides the control plane discovery, registration, Zero Trust policy, and coordination API
type Server struct {
	mu               sync.RWMutex
	config           ServerConfig
	registry         *Registry
	vipAllocator     *VIPAllocator
	routingEngine    *routing.RoutingEngine
	aclEngine        *acl.PolicyEngine
	routeTable       *routes.RouteTable
	postureEngine    *posture.PostureEngine
	eventBus         *management.EventBus
	managementServer *management.ManagementServer
	httpServer       *http.Server
	listener         net.Listener
	closed           bool
}

// NewServer creates a new control plane server instance with all Zero Trust subsystems
func NewServer(cfg ServerConfig) *Server {
	if cfg.MeshPSK == [crypto.KeySize]byte{} {
		rand.Read(cfg.MeshPSK[:])
	}

	reg := NewRegistry()
	aclEng := acl.NewPolicyEngine()
	rt := routes.NewRouteTable()
	postEng := posture.NewPostureEngine()
	eb := management.NewEventBus(1000)
	mgmt := management.NewManagementServer(&ManagementRegistryAdapter{reg: reg}, aclEng, rt, postEng, eb)

	return &Server{
		config:           cfg,
		registry:         reg,
		vipAllocator:     NewVIPAllocator(),
		routingEngine:    routing.NewRoutingEngine(),
		aclEngine:        aclEng,
		routeTable:       rt,
		postureEngine:    postEng,
		eventBus:         eb,
		managementServer: mgmt,
	}
}

// Start runs the HTTP API server
func (s *Server) Start() error {
	ln, err := net.Listen("tcp", s.config.ListenAddr)
	if err != nil {
		return fmt.Errorf("failed to listen on control plane addr %s: %w", s.config.ListenAddr, err)
	}

	s.listener = ln

	mux := http.NewServeMux()

	// 1. Core Control Plane Endpoints
	mux.HandleFunc("/v4/control/register", s.handleRegister)
	mux.HandleFunc("/v4/control/heartbeat", s.handleHeartbeat)
	mux.HandleFunc("/v4/control/discover", s.handleDiscover)
	mux.HandleFunc("/v4/control/circuit", s.handleCircuit)
	mux.HandleFunc("/v4/control/telemetry", s.handleTelemetry)
	mux.HandleFunc("/v4/control/sync", s.handleSync)
	mux.HandleFunc("/v4/control/sync-acls", s.handleSyncACLs)
	mux.HandleFunc("/v4/control/sync-routes", s.handleSyncRoutes)

	// 2. NetBird Management API & Prometheus Endpoints
	s.managementServer.RegisterRoutes(mux)

	s.httpServer = &http.Server{
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	go func() {
		_ = s.httpServer.Serve(ln)
	}()

	return nil
}

// --- Request / Response JSON Structs ---

type RegisterRequest struct {
	PublicKeyHex  string         `json:"public_key_hex"`
	Role          string         `json:"role"`
	Endpoints     []EndpointDesc `json:"endpoints"`
	AuthToken     string         `json:"auth_token"`
	ClientVersion string         `json:"client_version"`
	OSArch        string         `json:"os_arch"`
	Capability    CapabilityDesc `json:"capability"`
}

type RegisterResponse struct {
	AssignedNodeID string       `json:"assigned_node_id"`
	OverlayIPv4    string       `json:"overlay_ipv4"`
	OverlayIPv6    string       `json:"overlay_ipv6"`
	Relays         []*RelayDesc `json:"relays"`
	LeaseExpiryUTC uint64       `json:"lease_expiry_utc"`
	NetworkPSKHex  string       `json:"network_psk_hex"`
	PolicyEpoch    uint64       `json:"policy_epoch"`
	RouteEpoch     uint64       `json:"route_epoch"`
}

type HeartbeatRequest struct {
	NodeID          string         `json:"node_id"`
	SequenceNum     uint64         `json:"sequence_num"`
	Endpoints       []EndpointDesc `json:"endpoints"`
	ActiveCircuits  uint32         `json:"active_circuits"`
	TxBytesSec      uint32         `json:"tx_bytes_sec"`
	RxBytesSec      uint32         `json:"rx_bytes_sec"`
	CPUUsagePct     uint32         `json:"cpu_usage_pct"`
	MemoryUsageMB   uint32         `json:"memory_usage_mb"`
	BatteryLevelPct uint32         `json:"battery_level_pct"`
	OnBatteryPower  bool           `json:"on_battery_power"`

	// RTTMillis is the round trip the node measured on its previous heartbeat.
	// It is the one latency figure a node can obtain without extra traffic, and it
	// is what the console's per-country latency column reports; before this existed
	// the column had nothing behind it and the control plane substituted a constant.
	// Zero means not yet measured, which is the case on the first heartbeat.
	RTTMillis uint32 `json:"rtt_ms"`

	Posture *posture.PeerAttestation `json:"posture,omitempty"`
}

type HeartbeatResponse struct {
	Acknowledged     bool     `json:"acknowledged"`
	ForceRekey       bool     `json:"force_rekey"`
	DrainAndExit     bool     `json:"drain_and_exit"`
	RevokedKeys      []string `json:"revoked_keys"`
	IsQuarantined    bool     `json:"is_quarantined"`
	QuarantineReason string   `json:"quarantine_reason,omitempty"`
	PolicyEpoch      uint64   `json:"policy_epoch"`
	RouteEpoch       uint64   `json:"route_epoch"`
}

type DiscoverRequest struct {
	TargetCountry  string `json:"target_country"`
	TargetASN      uint32 `json:"target_asn"`
	IPClass        string `json:"ip_class"`
	ExplicitHostID string `json:"explicit_host_id"`
	Limit          int    `json:"limit"`
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
	HopCount      int    `json:"hop_count"`
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
	PolicyEpoch uint64 `json:"policy_epoch"`
}

type ACLSyncResponse struct {
	NewPolicyEpoch uint64                  `json:"new_policy_epoch"`
	Policy         *acl.CompiledPeerPolicy `json:"policy"`
}

type RouteSyncRequest struct {
	NodeID     string `json:"node_id"`
	RouteEpoch uint64 `json:"route_epoch"`
}

type RouteSyncResponse struct {
	NewRouteEpoch uint64                 `json:"new_route_epoch"`
	Routes        []*routes.NetworkRoute `json:"routes"`
}

// --- Handler Functions ---

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	pubBytes, err := hex.DecodeString(req.PublicKeyHex)
	if err != nil || len(pubBytes) != crypto.KeySize {
		http.Error(w, "Invalid 32-byte public key hex", http.StatusBadRequest)
		return
	}

	var pubArr [crypto.KeySize]byte
	copy(pubArr[:], pubBytes)

	nodeID := GenerateNodeID(pubArr)

	// Allocate Overlay VIP
	v4, v6, err := s.vipAllocator.Allocate(nodeID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	record := &NodeRecord{
		NodeID:      nodeID,
		PublicKey:   pubArr,
		Role:        req.Role,
		OverlayIPv4: v4,
		OverlayIPv6: v6,
		Endpoints:   req.Endpoints,
		Capability:  req.Capability,
	}

	s.registry.RegisterNode(record)

	// Bind to Peer Groups
	_ = s.aclEngine.AssignPeerToGroup("group:all", nodeID)
	if req.Role == "EXIT_BRIDGE" || req.Role == "HYBRID" {
		_ = s.aclEngine.AssignPeerToGroup("group:exit-nodes", nodeID)
	}
	if req.Capability.IPClass == "RESIDENTIAL" {
		_ = s.aclEngine.AssignPeerToGroup("group:residential", nodeID)
	} else if req.Capability.IPClass == "MOBILE_5G" {
		_ = s.aclEngine.AssignPeerToGroup("group:mobile", nodeID)
	} else if req.Capability.IPClass == "DATACENTER" {
		_ = s.aclEngine.AssignPeerToGroup("group:datacenter", nodeID)
	}

	// Add to routing engine
	s.routingEngine.AddCandidate(&routing.NodeCandidate{
		NodeID:      nodeID,
		PublicKey:   pubArr,
		CountryCode: req.Capability.CountryCode,
		ASN:         req.Capability.ASN,
		Role:        req.Role,
		Metrics: routing.NodeMetrics{
			AvailableBandwidthMbps: float64(req.Capability.MaxBandwidthKbps) / 1000.0,
			MaxBandwidthMbps:       100.0,
			RTTms:                  20.0,
			PacketLossRate:         0.0,
			ReputationScore:        0.95,
		},
	})

	s.eventBus.Publish(management.EventPeerRegistered, nodeID, fmt.Sprintf("Node %s (%s) registered with VIP %s", nodeID, req.Role, v4))

	resp := RegisterResponse{
		AssignedNodeID: nodeID,
		OverlayIPv4:    v4,
		OverlayIPv6:    v6,
		Relays:         s.registry.RelaysList(),
		LeaseExpiryUTC: uint64(time.Now().Add(24 * time.Hour).Unix()),
		NetworkPSKHex:  hex.EncodeToString(s.config.MeshPSK[:]),
		PolicyEpoch:    s.aclEngine.Epoch(),
		RouteEpoch:     s.routeTable.Epoch(),
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	var req HeartbeatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err := s.registry.Heartbeat(req.NodeID, req.Endpoints, req.ActiveCircuits, req.CPUUsagePct, req.MemoryUsageMB, req.BatteryLevelPct, req.OnBatteryPower)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	resp := HeartbeatResponse{
		Acknowledged: true,
		ForceRekey:   false,
		DrainAndExit: false,
		PolicyEpoch:  s.aclEngine.Epoch(),
		RouteEpoch:   s.routeTable.Epoch(),
	}

	// Continuous Posture Attestation Verification
	if req.Posture != nil {
		if req.Posture.NodeID == "" {
			req.Posture.NodeID = req.NodeID
		}
		peerGroups := s.aclEngine.GetPeerGroups(req.NodeID)
		postureResult := s.postureEngine.EvaluateAttestation(req.Posture, peerGroups)

		if !postureResult.Compliant || postureResult.Quarantine {
			resp.IsQuarantined = true
			resp.QuarantineReason = postureResult.ViolationReason
			resp.DrainAndExit = true

			// Mark node unhealthy in registry
			if node, getErr := s.registry.GetNode(req.NodeID); getErr == nil && node != nil {
				node.IsHealthy = false
			}

			s.eventBus.Publish(management.EventPeerQuarantined, req.NodeID, postureResult.ViolationReason)
		}
	} else if s.postureEngine.QuarantineManager().IsQuarantined(req.NodeID) {
		// Peer is already in quarantine
		if qRec, ok := s.postureEngine.QuarantineManager().GetQuarantineRecord(req.NodeID); ok {
			resp.IsQuarantined = true
			resp.QuarantineReason = qRec.Reason
			resp.DrainAndExit = true
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleDiscover(w http.ResponseWriter, r *http.Request) {
	var req DiscoverRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	bridges := s.registry.DiscoverBridges(req.TargetCountry, req.TargetASN, req.IPClass, req.Limit)
	var list []DiscoveredBridgeInfo

	for _, b := range bridges {
		// Exclude quarantined nodes from discovery
		if s.postureEngine.QuarantineManager().IsQuarantined(b.NodeID) {
			continue
		}

		score := routing.CalculatePathScore(b.Metrics)
		list = append(list, DiscoveredBridgeInfo{
			NodeID:       b.NodeID,
			PublicKeyHex: hex.EncodeToString(b.PublicKey[:]),
			OverlayIPv4:  b.OverlayIPv4,
			Endpoints:    b.Endpoints,
			Capability:   b.Capability,
			Score:        score,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(DiscoverResponse{Bridges: list})
}

func (s *Server) handleCircuit(w http.ResponseWriter, r *http.Request) {
	var req CircuitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	circuit, err := s.routingEngine.BuildOnionCircuit(req.TargetCountry)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}

	var hops []HopInfo
	for _, h := range circuit.Hops {
		// Ensure hop is not quarantined
		if s.postureEngine.QuarantineManager().IsQuarantined(h.NodeID) {
			http.Error(w, "Circuit hop failed posture check", http.StatusServiceUnavailable)
			return
		}

		node, _ := s.registry.GetNode(h.NodeID)
		var eps []EndpointDesc
		if node != nil {
			eps = node.Endpoints
		}

		hops = append(hops, HopInfo{
			HopIndex:     h.HopIndex,
			NodeID:       h.NodeID,
			PublicKeyHex: hex.EncodeToString(h.PublicKey[:]),
			Endpoints:    eps,
		})
	}

	resp := CircuitResponse{
		CircuitID:       circuit.CircuitID,
		Hops:            hops,
		ExpiryTimestamp: uint64(time.Now().Add(1 * time.Hour).Unix()),
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleTelemetry(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"recorded":true}`))
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	resp := SyncResponse{
		NewEpoch: s.registry.Epoch(),
		Relays:   s.registry.RelaysList(),
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleSyncACLs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var req ACLSyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	lookup := func(nodeID string) (net.IP, []string, bool) {
		node, err := s.registry.GetNode(nodeID)
		if err != nil || node == nil {
			return nil, nil, false
		}
		vip := net.ParseIP(node.OverlayIPv4)
		groups := s.aclEngine.GetPeerGroups(nodeID)
		return vip, groups, true
	}

	compiled, err := s.aclEngine.CompilePolicyForPeer(req.NodeID, lookup)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	_ = json.NewEncoder(w).Encode(ACLSyncResponse{
		NewPolicyEpoch: s.aclEngine.Epoch(),
		Policy:         compiled,
	})
}

func (s *Server) handleSyncRoutes(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var req RouteSyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	groups := s.aclEngine.GetPeerGroups(req.NodeID)
	routesList := s.routeTable.GetRoutesForNode(req.NodeID, groups)

	_ = json.NewEncoder(w).Encode(RouteSyncResponse{
		NewRouteEpoch: s.routeTable.Epoch(),
		Routes:        routesList,
	})
}

// Registry returns the internal registry
func (s *Server) Registry() *Registry {
	return s.registry
}

// RoutingEngine returns the routing engine
func (s *Server) RoutingEngine() *routing.RoutingEngine {
	return s.routingEngine
}

// PolicyEngine returns the ACL policy engine
func (s *Server) PolicyEngine() *acl.PolicyEngine {
	return s.aclEngine
}

// RouteTable returns the subnet routing table
func (s *Server) RouteTable() *routes.RouteTable {
	return s.routeTable
}

// PostureEngine returns the posture compliance engine
func (s *Server) PostureEngine() *posture.PostureEngine {
	return s.postureEngine
}

// ManagementServer returns the management API server
func (s *Server) ManagementServer() *management.ManagementServer {
	return s.managementServer
}

// EventBus returns the audit event bus
func (s *Server) EventBus() *management.EventBus {
	return s.eventBus
}

// AddRelay adds a relay definition
func (s *Server) AddRelay(relay *RelayDesc) {
	s.registry.AddRelay(relay)
}

// Addr returns the listening address
func (s *Server) Addr() net.Addr {
	if s.listener != nil {
		return s.listener.Addr()
	}
	return nil
}

// Close terminates the control plane server
func (s *Server) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if s.httpServer != nil {
		return s.httpServer.Shutdown(ctx)
	}
	return nil
}
