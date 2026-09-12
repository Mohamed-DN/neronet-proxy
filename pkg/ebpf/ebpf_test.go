package ebpf

import (
	"encoding/binary"
	"net"
	"sync"
	"testing"
	"time"
)

// Helper to construct a synthetic IPv4 UDP packet
func buildUDPTestPacket(srcIP, dstIP net.IP, srcPort, dstPort uint16, payload []byte) []byte {
	ihl := 5 // 20 bytes
	ipHeaderLen := ihl * 4
	udpHeaderLen := 8
	totalLen := ipHeaderLen + udpHeaderLen + len(payload)

	buf := make([]byte, totalLen)

	// IPv4 Header
	buf[0] = (4 << 4) | byte(ihl)
	buf[1] = 0x00 // TOS
	binary.BigEndian.PutUint16(buf[2:4], uint16(totalLen))
	binary.BigEndian.PutUint16(buf[4:6], 0x1234) // ID
	binary.BigEndian.PutUint16(buf[6:8], 0x0000) // Flags / Fragment
	buf[8] = 64                                 // TTL
	buf[9] = ProtoUDP
	copy(buf[12:16], srcIP.To4())
	copy(buf[16:20], dstIP.To4())

	csum := CalculateChecksum(buf[0:ipHeaderLen])
	binary.BigEndian.PutUint16(buf[10:12], csum)

	// UDP Header
	binary.BigEndian.PutUint16(buf[ipHeaderLen:ipHeaderLen+2], srcPort)
	binary.BigEndian.PutUint16(buf[ipHeaderLen+2:ipHeaderLen+4], dstPort)
	binary.BigEndian.PutUint16(buf[ipHeaderLen+4:ipHeaderLen+6], uint16(udpHeaderLen+len(payload)))
	binary.BigEndian.PutUint16(buf[ipHeaderLen+6:ipHeaderLen+8], 0x0000) // checksum

	// Payload
	copy(buf[ipHeaderLen+udpHeaderLen:], payload)

	return buf
}

// Helper to construct an SVRN Direct Frame payload
func buildSVRNPayload(sessionID uint64, innerData []byte) []byte {
	buf := make([]byte, 12+len(innerData))
	binary.BigEndian.PutUint32(buf[0:4], SVRNMagicCookie)
	binary.BigEndian.PutUint64(buf[4:12], sessionID)
	copy(buf[12:], innerData)
	return buf
}

func TestIPv4PacketParsingAndChecksum(t *testing.T) {
	src := net.ParseIP("192.168.1.50")
	dst := net.ParseIP("100.64.0.1")
	payload := []byte("Hello Sovereign eBPF Mesh")

	raw := buildUDPTestPacket(src, dst, 51820, 51820, payload)

	classifier := NewPacketClassifier(nil)
	info, err := classifier.ParsePacket(raw)
	if err != nil {
		t.Fatalf("ParsePacket failed: %v", err)
	}

	if !info.IsIPv4 {
		t.Fatalf("Expected IsIPv4 == true")
	}
	if !info.SrcIP.Equal(src) {
		t.Fatalf("SrcIP mismatch: %v != %v", info.SrcIP, src)
	}
	if !info.DstIP.Equal(dst) {
		t.Fatalf("DstIP mismatch: %v != %v", info.DstIP, dst)
	}
	if info.SrcPort != 51820 || info.DstPort != 51820 {
		t.Fatalf("Port mismatch: %d -> %d", info.SrcPort, info.DstPort)
	}
	if info.Protocol != ProtoUDP {
		t.Fatalf("Protocol mismatch: %d != %d", info.Protocol, ProtoUDP)
	}
	if info.PayloadLength != len(payload) {
		t.Fatalf("Payload length mismatch: %d != %d", info.PayloadLength, len(payload))
	}
}

func TestSVRNDirectFrameRecognition(t *testing.T) {
	src := net.ParseIP("10.0.0.5")
	dst := net.ParseIP("10.0.0.10")
	sessionID := uint64(0xDEADBEEFCAFE1234)
	innerData := []byte("Direct encrypted stream block")

	svrnPayload := buildSVRNPayload(sessionID, innerData)
	raw := buildUDPTestPacket(src, dst, 443, 443, svrnPayload)

	classifier := NewPacketClassifier(nil)
	info, err := classifier.ParsePacket(raw)
	if err != nil {
		t.Fatalf("ParsePacket failed: %v", err)
	}

	if !info.IsSVRN {
		t.Fatalf("Expected IsSVRN == true")
	}
	if info.SessionID != sessionID {
		t.Fatalf("SessionID mismatch: 0x%x != 0x%x", info.SessionID, sessionID)
	}
}

func TestFlowTableCRUDAndExpiration(t *testing.T) {
	table := NewFlowTable()

	key := FlowKey{
		SrcPort:   12345,
		DstPort:   80,
		Protocol:  ProtoTCP,
		SessionID: 0x9999,
	}

	entry := FlowEntry{
		TargetPort: 8080,
		TTL:        50 * time.Millisecond,
	}

	table.Set(key, entry)

	if table.Len() != 1 {
		t.Fatalf("Expected table length 1, got %d", table.Len())
	}

	// Retrieve before expiration
	got, ok := table.Get(key)
	if !ok || got.TargetPort != 8080 {
		t.Fatalf("Flow entry retrieval failed or mismatch")
	}

	// Wait for TTL expiration
	time.Sleep(60 * time.Millisecond)

	_, okAfterTTL := table.Get(key)
	if okAfterTTL {
		t.Fatalf("Expected flow entry to be expired")
	}

	purged := table.FlushExpired(10 * time.Millisecond)
	if purged != 1 {
		t.Fatalf("Expected 1 purged entry, got %d", purged)
	}
	if table.Len() != 0 {
		t.Fatalf("Expected table length 0 after flush, got %d", table.Len())
	}
}

func TestXDPRoutingFastPathBypass(t *testing.T) {
	router := NewKernelRouter()

	// Register a route
	err := router.AddRoute(RouteRule{
		CIDR:            "100.64.0.0/10",
		Gateway:         net.ParseIP("192.168.1.1"),
		InterfaceName:   "svrn0",
		InterfaceIndex:  2,
		FastPathEnabled: true,
	})
	if err != nil {
		t.Fatalf("AddRoute failed: %v", err)
	}

	sessionID := uint64(0x554433221100AABB)
	peerPublicAddr := &net.UDPAddr{IP: net.ParseIP("203.0.113.88"), Port: 51820}
	peerMAC := [6]byte{0x00, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E}

	router.RegisterPeerSession(sessionID, peerPublicAddr, peerMAC, 3)

	// Send an SVRN packet matching registered session ID
	svrnPayload := buildSVRNPayload(sessionID, []byte("Test Payload Data"))
	packet := buildUDPTestPacket(net.ParseIP("10.0.0.1"), net.ParseIP("100.64.0.5"), 443, 443, svrnPayload)

	result, err := router.ProcessPacket(packet)
	if err != nil {
		t.Fatalf("ProcessPacket failed: %v", err)
	}

	if result.Action != XDPTx {
		t.Fatalf("Expected Action XDPTx for fast-path bypass, got %s", result.Action)
	}
	if !result.FastPath {
		t.Fatalf("Expected FastPath == true")
	}
	if result.TargetIfIndex != 3 {
		t.Fatalf("Expected TargetIfIndex 3, got %d", result.TargetIfIndex)
	}
	if !result.TargetIP.Equal(peerPublicAddr.IP) {
		t.Fatalf("Target IP mismatch: %v != %v", result.TargetIP, peerPublicAddr.IP)
	}

	// Verify rewritten packet has new Dst IP and Dst Port
	rewrittenClassifier := NewPacketClassifier(nil)
	reInfo, err := rewrittenClassifier.ParsePacket(result.RewrittenFrame)
	if err != nil {
		t.Fatalf("Failed to parse rewritten packet: %v", err)
	}
	if !reInfo.DstIP.Equal(peerPublicAddr.IP) {
		t.Fatalf("Rewritten Dst IP mismatch: %v != %v", reInfo.DstIP, peerPublicAddr.IP)
	}
	if reInfo.DstPort != uint16(peerPublicAddr.Port) {
		t.Fatalf("Rewritten Dst Port mismatch: %d != %d", reInfo.DstPort, peerPublicAddr.Port)
	}

	// Check Stats
	stats := router.GetStats()
	if stats.FastPathHits != 1 {
		t.Fatalf("Expected FastPathHits == 1, got %d", stats.FastPathHits)
	}
	if stats.PacketsTx != 1 {
		t.Fatalf("Expected PacketsTx == 1, got %d", stats.PacketsTx)
	}
}

func TestKernelRouteTableLPM(t *testing.T) {
	router := NewKernelRouter()

	_ = router.AddRoute(RouteRule{
		CIDR:           "100.64.0.0/10",
		Gateway:        net.ParseIP("192.168.1.1"),
		InterfaceIndex: 1,
		Metric:         100,
	})
	_ = router.AddRoute(RouteRule{
		CIDR:           "100.64.1.0/24",
		Gateway:        net.ParseIP("192.168.1.254"),
		InterfaceIndex: 2,
		Metric:         10,
	})

	// Destination 100.64.1.50 matches both /10 and /24 -> must select /24 (InterfaceIndex 2)
	rule1, err := router.LookupRoute(net.ParseIP("100.64.1.50"))
	if err != nil {
		t.Fatalf("LookupRoute failed: %v", err)
	}
	if rule1.InterfaceIndex != 2 {
		t.Fatalf("Expected /24 route (IfIndex 2), got %d", rule1.InterfaceIndex)
	}

	// Destination 100.64.2.50 matches only /10 -> must select /10 (InterfaceIndex 1)
	rule2, err := router.LookupRoute(net.ParseIP("100.64.2.50"))
	if err != nil {
		t.Fatalf("LookupRoute failed: %v", err)
	}
	if rule2.InterfaceIndex != 1 {
		t.Fatalf("Expected /10 route (IfIndex 1), got %d", rule2.InterfaceIndex)
	}
}

func TestHighThroughputClassification(t *testing.T) {
	router := NewKernelRouter()
	sessionID := uint64(0x1122334455667788)
	peerAddr := &net.UDPAddr{IP: net.ParseIP("198.51.100.1"), Port: 443}
	router.RegisterPeerSession(sessionID, peerAddr, [6]byte{}, 1)

	packet := buildUDPTestPacket(net.ParseIP("10.0.0.1"), net.ParseIP("100.64.0.1"), 443, 443, buildSVRNPayload(sessionID, []byte("Bench Data")))

	numWorkers := 8
	packetsPerWorker := 5000
	var wg sync.WaitGroup

	start := time.Now()

	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < packetsPerWorker; i++ {
				res, err := router.ProcessPacket(packet)
				if err != nil || res.Action != XDPTx {
					t.Errorf("Unexpected error or non-fastpath action: %v", err)
					return
				}
			}
		}()
	}

	wg.Wait()
	duration := time.Since(start)

	totalPackets := numWorkers * packetsPerWorker
	stats := router.GetStats()
	if stats.PacketsProcessed != uint64(totalPackets) {
		t.Fatalf("Expected %d packets processed, got %d", totalPackets, stats.PacketsProcessed)
	}
	if stats.FastPathHits != uint64(totalPackets) {
		t.Fatalf("Expected %d fastpath hits, got %d", totalPackets, stats.FastPathHits)
	}

	t.Logf("Processed %d packets in %v (%.2f packets/sec)", totalPackets, duration, float64(totalPackets)/duration.Seconds())
}

func TestBogonAndInvalidPacketDrop(t *testing.T) {
	router := NewKernelRouter()

	// Short buffer
	shortBuf := []byte{0x45, 0x00, 0x00}
	res, err := router.ProcessPacket(shortBuf)
	if res.Action != XDPDrop || err == nil {
		t.Fatalf("Expected XDPDrop on short packet")
	}

	// Multicast TCP (bogon)
	bogonPacket := buildUDPTestPacket(net.ParseIP("10.0.0.1"), net.ParseIP("224.0.0.1"), 80, 80, []byte("data"))
	bogonPacket[9] = ProtoTCP // change proto to TCP
	bogonRes, _ := router.ProcessPacket(bogonPacket)
	if bogonRes.Action != XDPDrop {
		t.Fatalf("Expected XDPDrop on multicast TCP bogon, got %s", bogonRes.Action)
	}
}

func TestCalculateChecksum(t *testing.T) {
	data := []byte{0x45, 0x00, 0x00, 0x3c, 0x1c, 0x46, 0x40, 0x00, 0x40, 0x06, 0x00, 0x00, 0xac, 0x10, 0x0a, 0x63, 0xac, 0x10, 0x0a, 0x0c}
	csum := CalculateChecksum(data)
	if csum == 0 {
		t.Fatalf("Checksum should not be zero")
	}
	// Verify adding checksum makes total sum 0xFFFF (or 0 after invert)
	binary.BigEndian.PutUint16(data[10:12], csum)
	verifySum := CalculateChecksum(data)
	if verifySum != 0x0000 {
		t.Fatalf("Checksum validation failed, got 0x%04x", verifySum)
	}
}
