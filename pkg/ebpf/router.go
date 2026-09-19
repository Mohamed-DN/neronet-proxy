package ebpf

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// Errors
var (
	ErrInvalidCIDR   = errors.New("invalid CIDR string for routing rule")
	ErrRouteNotFound = errors.New("route not found for destination")
)

// RouteRule defines a kernel/eBPF synced routing entry
type RouteRule struct {
	CIDR            string     `json:"cidr"`
	IPNet           *net.IPNet `json:"-"`
	Gateway         net.IP     `json:"gateway,omitempty"`
	PeerID          string     `json:"peer_id,omitempty"`
	InterfaceName   string     `json:"interface_name"`
	InterfaceIndex  uint32     `json:"interface_index"`
	Metric          int        `json:"metric"`
	FastPathEnabled bool       `json:"fast_path_enabled"`
	TargetMAC       [6]byte    `json:"target_mac,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	LastSyncedAt    time.Time  `json:"last_synced_at"`
}

// RouteResult contains routing decision and rewritten frame
type RouteResult struct {
	Action         XDPAction
	RewrittenFrame []byte
	TargetIfIndex  uint32
	TargetIP       net.IP
	TargetPort     uint16
	FastPath       bool
	ProcessTime    time.Duration
}

// KernelRouter coordinates eBPF packet classification with kernel route tables
type KernelRouter struct {
	mu         sync.RWMutex
	routes     map[string]*RouteRule
	classifier *PacketClassifier
	flowTable  *FlowTable
}

// NewKernelRouter creates an eBPF-accelerated kernel router
func NewKernelRouter() *KernelRouter {
	flowTable := NewFlowTable()
	classifier := NewPacketClassifier(flowTable)
	return &KernelRouter{
		routes:     make(map[string]*RouteRule),
		classifier: classifier,
		flowTable:  flowTable,
	}
}

// AddRoute registers a new routing rule and syncs it into eBPF flow rules
func (r *KernelRouter) AddRoute(rule RouteRule) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	_, ipNet, err := net.ParseCIDR(rule.CIDR)
	if err != nil {
		return fmt.Errorf("%w: %s (%v)", ErrInvalidCIDR, rule.CIDR, err)
	}

	rule.IPNet = ipNet
	rule.CreatedAt = time.Now()
	rule.LastSyncedAt = time.Now()
	r.routes[rule.CIDR] = &rule

	// If fast path is enabled, pre-populate flow table for subnet gateway
	if rule.FastPathEnabled && rule.Gateway != nil {
		var gwBytes [4]byte
		if gw4 := rule.Gateway.To4(); gw4 != nil {
			copy(gwBytes[:], gw4)
		}
		// Register default subnet bypass flow
		var dstBytes [4]byte
		if ip4 := ipNet.IP.To4(); ip4 != nil {
			copy(dstBytes[:], ip4)
		}

		key := FlowKey{
			DstIP:    dstBytes,
			Protocol: ProtoUDP,
		}
		r.flowTable.Set(key, FlowEntry{
			TargetIP:       gwBytes,
			TargetMAC:      rule.TargetMAC,
			OutInterfaceID: rule.InterfaceIndex,
			Flags:          0x1, // DirectBypass
		})
	}

	return nil
}

// RemoveRoute deregisters a route and purges associated flow entries
func (r *KernelRouter) RemoveRoute(cidr string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	rule, ok := r.routes[cidr]
	if !ok {
		return ErrRouteNotFound
	}

	if rule.IPNet != nil && rule.IPNet.IP.To4() != nil {
		var dstBytes [4]byte
		copy(dstBytes[:], rule.IPNet.IP.To4())
		r.flowTable.Delete(FlowKey{DstIP: dstBytes, Protocol: ProtoUDP})
	}

	delete(r.routes, cidr)
	return nil
}

// LookupRoute finds the best matching routing rule for a given destination IP (Longest Prefix Match)
func (r *KernelRouter) LookupRoute(dstIP net.IP) (*RouteRule, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var bestRule *RouteRule
	var bestMaskLen int = -1

	for _, rule := range r.routes {
		if rule.IPNet != nil && rule.IPNet.Contains(dstIP) {
			maskLen, _ := rule.IPNet.Mask.Size()
			if maskLen > bestMaskLen {
				bestMaskLen = maskLen
				bestRule = rule
			}
		}
	}

	if bestRule == nil {
		return nil, ErrRouteNotFound
	}
	return bestRule, nil
}

// RegisterPeerSession associates an active peer SVRN session with direct fast-path forwarding
func (r *KernelRouter) RegisterPeerSession(sessionID uint64, peerPublicAddr *net.UDPAddr, peerMAC [6]byte, ifIndex uint32) {
	var targetIP [4]byte
	if ip4 := peerPublicAddr.IP.To4(); ip4 != nil {
		copy(targetIP[:], ip4)
	}

	key := FlowKey{
		SessionID: sessionID,
		Protocol:  ProtoUDP,
	}

	entry := FlowEntry{
		TargetIP:       targetIP,
		TargetPort:     uint16(peerPublicAddr.Port),
		TargetMAC:      peerMAC,
		OutInterfaceID: ifIndex,
		Flags:          0x1, // Direct fast-path bypass
		TTL:            10 * time.Minute,
	}

	r.flowTable.Set(key, entry)
}

// ProcessPacket processes an inbound raw packet through XDP classification and router logic
func (r *KernelRouter) ProcessPacket(raw []byte) (*RouteResult, error) {
	start := time.Now()
	action, flowEntry, info, err := r.classifier.ClassifyAndFilter(raw)
	if err != nil {
		return &RouteResult{
			Action:      XDPDrop,
			ProcessTime: time.Since(start),
		}, err
	}

	res := &RouteResult{
		Action:      action,
		ProcessTime: time.Since(start),
	}

	if action == XDPTx || action == XDPRedirect {
		res.FastPath = true
		if flowEntry != nil {
			res.TargetIfIndex = flowEntry.OutInterfaceID
			res.TargetIP = net.IPv4(flowEntry.TargetIP[0], flowEntry.TargetIP[1], flowEntry.TargetIP[2], flowEntry.TargetIP[3])
			res.TargetPort = flowEntry.TargetPort

			// Perform in-place packet rewrite if needed
			rewritten, err := RewriteIPv4Packet(raw, flowEntry)
			if err == nil {
				res.RewrittenFrame = rewritten
			} else {
				res.RewrittenFrame = raw
			}
		}
		return res, nil
	}

	// For XDP_PASS packets, check if route table knows the destination
	if info != nil && info.DstIP != nil {
		rule, err := r.LookupRoute(info.DstIP)
		if err == nil && rule != nil {
			res.TargetIfIndex = rule.InterfaceIndex
			res.TargetIP = rule.Gateway
		}
	}

	res.RewrittenFrame = raw
	return res, nil
}

// RewriteIPv4Packet rewrites destination IP and UDP port and updates checksums
func RewriteIPv4Packet(raw []byte, entry *FlowEntry) ([]byte, error) {
	if len(raw) < 20 {
		return nil, ErrPacketTooShort
	}

	// Clone buffer to avoid mutating input if shared
	buf := make([]byte, len(raw))
	copy(buf, raw)

	ihl := int(buf[0]&0x0F) * 4
	if len(buf) < ihl {
		return nil, ErrPacketTooShort
	}

	// Rewrite Dst IP if target is non-zero
	if entry.TargetIP != [4]byte{0, 0, 0, 0} {
		copy(buf[16:20], entry.TargetIP[:])
		// Recalculate IPv4 header checksum
		buf[10] = 0
		buf[11] = 0
		csum := CalculateChecksum(buf[0:ihl])
		binary.BigEndian.PutUint16(buf[10:12], csum)
	}

	proto := buf[9]
	if proto == ProtoUDP && len(buf) >= ihl+8 && entry.TargetPort > 0 {
		// Rewrite UDP Dst Port
		binary.BigEndian.PutUint16(buf[ihl+2:ihl+4], entry.TargetPort)
		// UDP checksum optional in IPv4: set to 0 to disable or recalculate
		buf[ihl+6] = 0
		buf[ihl+7] = 0
	}

	return buf, nil
}

// CalculateChecksum computes standard 16-bit one's complement checksum
func CalculateChecksum(data []byte) uint16 {
	var sum uint32
	n := len(data)

	for i := 0; i < n-1; i += 2 {
		sum += uint32(binary.BigEndian.Uint16(data[i : i+2]))
	}

	if n%2 == 1 {
		sum += uint32(data[n-1]) << 8
	}

	for (sum >> 16) > 0 {
		sum = (sum & 0xFFFF) + (sum >> 16)
	}

	return ^uint16(sum)
}

// GetStats returns current XDP stats
func (r *KernelRouter) GetStats() XDPStats {
	return r.classifier.GetStats()
}

// GetRoutes returns a list of all active routing rules
func (r *KernelRouter) GetRoutes() []RouteRule {
	r.mu.RLock()
	defer r.mu.RUnlock()

	list := make([]RouteRule, 0, len(r.routes))
	for _, rule := range r.routes {
		list = append(list, *rule)
	}
	return list
}

// SyncKernelRoutes simulates periodic synchronizing of OS network routes into eBPF tables
func (r *KernelRouter) SyncKernelRoutes(interfaces []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	for _, rule := range r.routes {
		rule.LastSyncedAt = now
	}
	return nil
}
