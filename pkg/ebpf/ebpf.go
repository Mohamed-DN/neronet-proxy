package ebpf

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// XDPAction represents the return code from an XDP program
type XDPAction uint32

const (
	XDPAborted  XDPAction = 0
	XDPDrop     XDPAction = 1
	XDPPass     XDPAction = 2
	XDPTx       XDPAction = 3
	XDPRedirect XDPAction = 4
)

func (a XDPAction) String() string {
	switch a {
	case XDPAborted:
		return "XDP_ABORTED"
	case XDPDrop:
		return "XDP_DROP"
	case XDPPass:
		return "XDP_PASS"
	case XDPTx:
		return "XDP_TX"
	case XDPRedirect:
		return "XDP_REDIRECT"
	default:
		return fmt.Sprintf("XDP_UNKNOWN(%d)", a)
	}
}

// IP Protocol Constants
const (
	ProtoICMP uint8 = 1
	ProtoTCP  uint8 = 6
	ProtoUDP  uint8 = 17
)

// SVRN Magic Cookie for WireGuard/SVRN Direct Frame Fast-Path
const (
	SVRNMagicCookie uint32 = 0x5356524E // "SVRN"
)

// Errors
var (
	ErrPacketTooShort     = errors.New("packet buffer too short for header parsing")
	ErrUnsupportedVersion = errors.New("unsupported IP packet version")
	ErrFlowNotFound       = errors.New("flow entry not found in BPF table")
	ErrFlowExpired        = errors.New("flow entry expired")
)

// FlowKey represents a 5-tuple + Session ID key in eBPF map
type FlowKey struct {
	SrcIP     [4]byte
	DstIP     [4]byte
	SrcPort   uint16
	DstPort   uint16
	Protocol  uint8
	SessionID uint64
}

// String returns human-readable flow representation
func (k FlowKey) String() string {
	src := net.IPv4(k.SrcIP[0], k.SrcIP[1], k.SrcIP[2], k.SrcIP[3])
	dst := net.IPv4(k.DstIP[0], k.DstIP[1], k.DstIP[2], k.DstIP[3])
	return fmt.Sprintf("[%s:%d -> %s:%d proto=%d sess=0x%x]", src, k.SrcPort, dst, k.DstPort, k.Protocol, k.SessionID)
}

// FlowEntry represents the fast-path forwarding target in the eBPF map
type FlowEntry struct {
	TargetIP       [4]byte
	TargetPort     uint16
	TargetMAC      [6]byte
	SrcMAC         [6]byte
	OutInterfaceID uint32
	Flags          uint32 // e.g., 0x1 = DirectBypass, 0x2 = Encrypted, 0x4 = DecoyPass
	PacketsCount   uint64
	BytesCount     uint64
	TTL            time.Duration

	// lastSeenNano is the Unix-nanosecond time of the most recent packet on this
	// flow, read and written atomically.
	//
	// Get hands out a pointer into the table, so every field the fast path mutates
	// is shared across goroutines. PacketsCount and BytesCount already use atomic
	// adds; LastSeen was a multi-word time.Time written with a plain assignment
	// while Get concurrently read it to evaluate the TTL, which the race detector
	// flags and which can tear on a 32-bit word split.
	lastSeenNano int64
}

// LastSeen reports when this flow last carried a packet.
func (e *FlowEntry) LastSeen() time.Time {
	return time.Unix(0, atomic.LoadInt64(&e.lastSeenNano))
}

// Touch records that this flow has just carried a packet.
func (e *FlowEntry) Touch(now time.Time) {
	atomic.StoreInt64(&e.lastSeenNano, now.UnixNano())
}

// age reports how long it has been since this flow last carried a packet.
func (e *FlowEntry) age(now time.Time) time.Duration {
	return now.Sub(e.LastSeen())
}

// PacketInfo holds parsed metadata from an inbound Ethernet/IP/Transport frame
type PacketInfo struct {
	IsIPv4        bool
	SrcIP         net.IP
	DstIP         net.IP
	SrcPort       uint16
	DstPort       uint16
	Protocol      uint8
	SessionID     uint64
	IsSVRN        bool
	PayloadOffset int
	PayloadLength int
	TotalLength   int
}

// XDPStats holds performance counters for eBPF XDP classifier & bypass engine
type XDPStats struct {
	PacketsProcessed uint64 `json:"packets_processed"`
	PacketsPassed    uint64 `json:"packets_passed"`
	PacketsDropped   uint64 `json:"packets_dropped"`
	PacketsTx        uint64 `json:"packets_tx"`
	PacketsRedirect  uint64 `json:"packets_redirect"`
	BytesProcessed   uint64 `json:"bytes_processed"`
	FastPathHits     uint64 `json:"fast_path_hits"`
	FastPathMisses   uint64 `json:"fast_path_misses"`
}

// FlowTable simulates an in-kernel eBPF BPF_MAP_TYPE_HASH flow table
type FlowTable struct {
	mu    sync.RWMutex
	flows map[FlowKey]*FlowEntry
}

// NewFlowTable creates an initialized flow table
func NewFlowTable() *FlowTable {
	return &FlowTable{
		flows: make(map[FlowKey]*FlowEntry),
	}
}

// Set stores or updates a flow entry
func (t *FlowTable) Set(key FlowKey, entry FlowEntry) {
	t.mu.Lock()
	defer t.mu.Unlock()
	stored := &entry
	if stored.lastSeenNano == 0 {
		stored.Touch(time.Now())
	}
	t.flows[key] = stored
}

// Get looks up a flow entry
func (t *FlowTable) Get(key FlowKey) (*FlowEntry, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	entry, ok := t.flows[key]
	if !ok {
		return nil, false
	}
	// Check expiration if TTL is set
	if entry.TTL > 0 && entry.age(time.Now()) > entry.TTL {
		return nil, false
	}
	return entry, true
}

// Delete removes a flow entry
func (t *FlowTable) Delete(key FlowKey) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.flows, key)
}

// Len returns the count of active flows
func (t *FlowTable) Len() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.flows)
}

// FlushExpired purges entries older than maxAge
func (t *FlowTable) FlushExpired(maxAge time.Duration) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	purged := 0
	for k, v := range t.flows {
		age := v.age(now)
		if (v.TTL > 0 && age > v.TTL) || (maxAge > 0 && age > maxAge) {
			delete(t.flows, k)
			purged++
		}
	}
	return purged
}

// PacketClassifier parses and classifies raw packets at line rate
type PacketClassifier struct {
	stats     XDPStats
	flowTable *FlowTable
}

// NewPacketClassifier creates an eBPF packet classifier
func NewPacketClassifier(flowTable *FlowTable) *PacketClassifier {
	if flowTable == nil {
		flowTable = NewFlowTable()
	}
	return &PacketClassifier{
		flowTable: flowTable,
	}
}

// ParsePacket inspects an IPv4 packet buffer and extracts 5-tuple and SVRN metadata
func (c *PacketClassifier) ParsePacket(raw []byte) (*PacketInfo, error) {
	if len(raw) < 20 {
		return nil, ErrPacketTooShort
	}

	// Verify IPv4
	version := (raw[0] >> 4) & 0x0F
	if version != 4 {
		return nil, ErrUnsupportedVersion
	}

	ihl := int(raw[0]&0x0F) * 4
	if len(raw) < ihl {
		return nil, ErrPacketTooShort
	}

	totalLen := int(binary.BigEndian.Uint16(raw[2:4]))
	if totalLen == 0 || totalLen > len(raw) {
		totalLen = len(raw)
	}

	proto := raw[9]
	srcIP := net.IPv4(raw[12], raw[13], raw[14], raw[15])
	dstIP := net.IPv4(raw[16], raw[17], raw[18], raw[19])

	info := &PacketInfo{
		IsIPv4:      true,
		SrcIP:       srcIP,
		DstIP:       dstIP,
		Protocol:    proto,
		TotalLength: totalLen,
	}

	// Parse Transport Header
	offset := ihl
	switch proto {
	case ProtoUDP:
		if len(raw) < offset+8 {
			return nil, ErrPacketTooShort
		}
		info.SrcPort = binary.BigEndian.Uint16(raw[offset : offset+2])
		info.DstPort = binary.BigEndian.Uint16(raw[offset+2 : offset+4])
		udpLen := int(binary.BigEndian.Uint16(raw[offset+4 : offset+6]))
		info.PayloadOffset = offset + 8
		if udpLen >= 8 && offset+udpLen <= len(raw) {
			info.PayloadLength = udpLen - 8
		} else {
			info.PayloadLength = len(raw) - info.PayloadOffset
		}

		// Inspect SVRN Direct Frame Magic if payload is large enough
		if info.PayloadLength >= 12 {
			payload := raw[info.PayloadOffset : info.PayloadOffset+info.PayloadLength]
			magic := binary.BigEndian.Uint32(payload[0:4])
			if magic == SVRNMagicCookie {
				info.IsSVRN = true
				info.SessionID = binary.BigEndian.Uint64(payload[4:12])
			}
		}

	case ProtoTCP:
		if len(raw) < offset+20 {
			return nil, ErrPacketTooShort
		}
		info.SrcPort = binary.BigEndian.Uint16(raw[offset : offset+2])
		info.DstPort = binary.BigEndian.Uint16(raw[offset+2 : offset+4])
		dataOffset := int((raw[offset+12]>>4)&0x0F) * 4
		info.PayloadOffset = offset + dataOffset
		if info.PayloadOffset <= len(raw) {
			info.PayloadLength = len(raw) - info.PayloadOffset
		}

	case ProtoICMP:
		info.PayloadOffset = offset + 8
		if info.PayloadOffset <= len(raw) {
			info.PayloadLength = len(raw) - info.PayloadOffset
		}

	default:
		info.PayloadOffset = offset
		info.PayloadLength = len(raw) - offset
	}

	return info, nil
}

// BuildFlowKey creates a 5-tuple lookup key from PacketInfo
func BuildFlowKey(info *PacketInfo) FlowKey {
	var key FlowKey
	if len(info.SrcIP.To4()) == 4 {
		copy(key.SrcIP[:], info.SrcIP.To4())
	}
	if len(info.DstIP.To4()) == 4 {
		copy(key.DstIP[:], info.DstIP.To4())
	}
	key.SrcPort = info.SrcPort
	key.DstPort = info.DstPort
	key.Protocol = info.Protocol
	key.SessionID = info.SessionID
	return key
}

// ClassifyAndFilter executes the eBPF XDP hook logic on an inbound packet
func (c *PacketClassifier) ClassifyAndFilter(raw []byte) (XDPAction, *FlowEntry, *PacketInfo, error) {
	atomic.AddUint64(&c.stats.PacketsProcessed, 1)
	atomic.AddUint64(&c.stats.BytesProcessed, uint64(len(raw)))

	info, err := c.ParsePacket(raw)
	if err != nil {
		atomic.AddUint64(&c.stats.PacketsDropped, 1)
		return XDPDrop, nil, nil, err
	}

	// 1. Bogon filter: Drop obvious invalid or bogon IP targets at XDP driver level if configured
	if info.DstIP.IsUnspecified() || info.DstIP.IsMulticast() && info.Protocol != ProtoUDP {
		atomic.AddUint64(&c.stats.PacketsDropped, 1)
		return XDPDrop, nil, info, nil
	}

	// 2. Fast-Path Flow Bypass Lookup
	key := BuildFlowKey(info)
	entry, hit := c.flowTable.Get(key)

	if !hit && info.SessionID != 0 {
		// Try SessionID wildcard lookup (matching SessionID with 0 port/IP if registered)
		wildcardKey := FlowKey{SessionID: info.SessionID, Protocol: info.Protocol}
		entry, hit = c.flowTable.Get(wildcardKey)
	}

	if hit && entry != nil {
		atomic.AddUint64(&c.stats.FastPathHits, 1)
		atomic.AddUint64(&entry.PacketsCount, 1)
		atomic.AddUint64(&entry.BytesCount, uint64(len(raw)))
		entry.Touch(time.Now())

		if (entry.Flags & 0x1) != 0 {
			// Direct fast-path XDP_TX line rate forward
			atomic.AddUint64(&c.stats.PacketsTx, 1)
			return XDPTx, entry, info, nil
		} else if entry.OutInterfaceID > 0 {
			// Redirect to specified interface (AF_XDP or kernel ring)
			atomic.AddUint64(&c.stats.PacketsRedirect, 1)
			return XDPRedirect, entry, info, nil
		}
	}

	// 3. Fast-Path Miss -> Pass to Userspace Slow-Path (XDP_PASS)
	atomic.AddUint64(&c.stats.FastPathMisses, 1)
	atomic.AddUint64(&c.stats.PacketsPassed, 1)
	return XDPPass, nil, info, nil
}

// GetStats returns current XDP processing metrics
func (c *PacketClassifier) GetStats() XDPStats {
	return XDPStats{
		PacketsProcessed: atomic.LoadUint64(&c.stats.PacketsProcessed),
		PacketsPassed:    atomic.LoadUint64(&c.stats.PacketsPassed),
		PacketsDropped:   atomic.LoadUint64(&c.stats.PacketsDropped),
		PacketsTx:        atomic.LoadUint64(&c.stats.PacketsTx),
		PacketsRedirect:  atomic.LoadUint64(&c.stats.PacketsRedirect),
		BytesProcessed:   atomic.LoadUint64(&c.stats.BytesProcessed),
		FastPathHits:     atomic.LoadUint64(&c.stats.FastPathHits),
		FastPathMisses:   atomic.LoadUint64(&c.stats.FastPathMisses),
	}
}

// ResetStats resets all statistics counters
func (c *PacketClassifier) ResetStats() {
	atomic.StoreUint64(&c.stats.PacketsProcessed, 0)
	atomic.StoreUint64(&c.stats.PacketsPassed, 0)
	atomic.StoreUint64(&c.stats.PacketsDropped, 0)
	atomic.StoreUint64(&c.stats.PacketsTx, 0)
	atomic.StoreUint64(&c.stats.PacketsRedirect, 0)
	atomic.StoreUint64(&c.stats.BytesProcessed, 0)
	atomic.StoreUint64(&c.stats.FastPathHits, 0)
	atomic.StoreUint64(&c.stats.FastPathMisses, 0)
}
