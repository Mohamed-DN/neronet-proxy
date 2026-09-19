package routing

import (
	"bytes"
	"crypto/rand"
	"net"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/crypto"
)

func TestOnionCellFixedSize(t *testing.T) {
	cell := &OnionCell{
		CircuitID: 0xAABBCCDD,
		Command:   CellCmdRelayData,
		StreamID:  42,
		Digest:    12345,
		Payload:   []byte("Test Onion Cell Payload"),
	}

	encoded, err := EncodeCell(cell)
	if err != nil {
		t.Fatalf("EncodeCell failed: %v", err)
	}

	if len(encoded) != OnionCellFixedSize {
		t.Fatalf("Encoded cell size must be exactly %d bytes, got %d", OnionCellFixedSize, len(encoded))
	}

	decoded, err := DecodeCell(encoded)
	if err != nil {
		t.Fatalf("DecodeCell failed: %v", err)
	}

	if decoded.CircuitID != cell.CircuitID {
		t.Fatalf("CircuitID mismatch: %x != %x", decoded.CircuitID, cell.CircuitID)
	}
	if decoded.Command != cell.Command {
		t.Fatalf("Command mismatch: %d != %d", decoded.Command, cell.Command)
	}
	if decoded.StreamID != cell.StreamID {
		t.Fatalf("StreamID mismatch: %d != %d", decoded.StreamID, cell.StreamID)
	}
	if !bytes.Equal(decoded.Payload, cell.Payload) {
		t.Fatalf("Payload mismatch: %s != %s", string(decoded.Payload), string(cell.Payload))
	}
}

func TestDynamicPathScoring(t *testing.T) {
	// High-quality node (High BW, Low RTT, 0 Loss, High Rep)
	goodMetrics := NodeMetrics{
		AvailableBandwidthMbps: 90.0,
		MaxBandwidthMbps:       100.0,
		RTTms:                  10.0,
		PacketLossRate:         0.0,
		ReputationScore:        0.95,
		RTTJitterSigma:         2.0,
	}

	goodScore := CalculatePathScore(goodMetrics)
	if goodScore < 70.0 {
		t.Fatalf("Expected goodScore >= 70, got %f", goodScore)
	}
	if !IsNodeEligible(goodMetrics) {
		t.Fatalf("Good node should be eligible")
	}

	// Degraded node (Low BW, High RTT, High Loss)
	badMetrics := NodeMetrics{
		AvailableBandwidthMbps: 5.0,
		MaxBandwidthMbps:       100.0,
		RTTms:                  400.0,
		PacketLossRate:         0.50,
		ReputationScore:        0.30,
		RTTJitterSigma:         50.0,
	}

	badScore := CalculatePathScore(badMetrics)
	if badScore >= MinUsableScore {
		t.Fatalf("Expected badScore < %f, got %f", MinUsableScore, badScore)
	}
	if IsNodeEligible(badMetrics) {
		t.Fatalf("Bad node should not be eligible")
	}
}

func Test3HopLayeredOnionPeel(t *testing.T) {
	entryKP, _ := crypto.GenerateKeypair()
	interKP, _ := crypto.GenerateKeypair()
	exitKP, _ := crypto.GenerateKeypair()

	entryHop := &OnionHop{HopIndex: 1, NodeID: "entry-1", PublicKey: entryKP.PublicKey}
	interHop := &OnionHop{HopIndex: 2, NodeID: "inter-2", PublicKey: interKP.PublicKey}
	exitHop := &OnionHop{HopIndex: 3, NodeID: "exit-3", PublicKey: exitKP.PublicKey}

	circuit, err := Build3HopCircuit(0x1001, entryHop, interHop, exitHop)
	if err != nil {
		t.Fatalf("Build3HopCircuit failed: %v", err)
	}

	originalPayload := []byte("GET /v1/models HTTP/1.1\r\nHost: api.openai.com\r\n\r\n")
	targetAddr := "api.openai.com:443"

	// Alice seals the 3-hop layered packet
	rawCell, err := circuit.EncryptLayeredData(101, targetAddr, originalPayload)
	if err != nil {
		t.Fatalf("EncryptLayeredData failed: %v", err)
	}

	decodedCell, err := DecodeCell(rawCell)
	if err != nil {
		t.Fatalf("DecodeCell failed: %v", err)
	}

	// Hop 1 (Entry Relay): Peels Layer 1
	hop1Result, err := PeelLayer(entryKP.PrivateKey, 1, decodedCell.Payload)
	if err != nil {
		t.Fatalf("Hop 1 PeelLayer failed: %v", err)
	}
	if hop1Result.IsExit {
		t.Fatalf("Hop 1 should NOT be exit")
	}
	if hop1Result.NextHopPub != interKP.PublicKey {
		t.Fatalf("Hop 1 next hop should be Intermediate pubkey")
	}

	// Hop 2 (Intermediate Relay): Peels Layer 2
	hop2Result, err := PeelLayer(interKP.PrivateKey, 2, hop1Result.InnerPayload)
	if err != nil {
		t.Fatalf("Hop 2 PeelLayer failed: %v", err)
	}
	if hop2Result.IsExit {
		t.Fatalf("Hop 2 should NOT be exit")
	}
	if hop2Result.NextHopPub != exitKP.PublicKey {
		t.Fatalf("Hop 2 next hop should be Exit pubkey")
	}

	// Hop 3 (Exit Bridge): Peels Layer 3
	hop3Result, err := PeelLayer(exitKP.PrivateKey, 3, hop2Result.InnerPayload)
	if err != nil {
		t.Fatalf("Hop 3 PeelLayer failed: %v", err)
	}
	if !hop3Result.IsExit {
		t.Fatalf("Hop 3 MUST be exit")
	}
	if hop3Result.TargetAddr != targetAddr {
		t.Fatalf("Target address mismatch: %s != %s", hop3Result.TargetAddr, targetAddr)
	}
	if !bytes.Equal(hop3Result.InnerPayload, originalPayload) {
		t.Fatalf("Payload mismatch at exit: %s != %s", string(hop3Result.InnerPayload), string(originalPayload))
	}
}

func TestRoutingEngineModes(t *testing.T) {
	engine := NewRoutingEngine()

	var pk1, pk2, pk3, pk4 [crypto.KeySize]byte
	rand.Read(pk1[:])
	rand.Read(pk2[:])
	rand.Read(pk3[:])
	rand.Read(pk4[:])

	// Add US Exit Node (High Score)
	engine.AddCandidate(&NodeCandidate{
		NodeID:      "us-exit-fast",
		PublicKey:   pk1,
		CountryCode: "US",
		Role:        "EXIT_BRIDGE",
		Metrics: NodeMetrics{
			AvailableBandwidthMbps: 100,
			MaxBandwidthMbps:       100,
			RTTms:                  15,
			PacketLossRate:         0.0,
			ReputationScore:        0.99,
		},
	})

	// Add US Exit Node (Slow Score)
	engine.AddCandidate(&NodeCandidate{
		NodeID:      "us-exit-slow",
		PublicKey:   pk2,
		CountryCode: "US",
		Role:        "EXIT_BRIDGE",
		Metrics: NodeMetrics{
			AvailableBandwidthMbps: 10,
			MaxBandwidthMbps:       100,
			RTTms:                  120,
			PacketLossRate:         0.05,
			ReputationScore:        0.70,
		},
	})

	// Add Relay Node
	engine.AddCandidate(&NodeCandidate{
		NodeID:      "de-relay-1",
		PublicKey:   pk3,
		CountryCode: "DE",
		Role:        "RELAY",
		Metrics: NodeMetrics{
			AvailableBandwidthMbps: 200,
			MaxBandwidthMbps:       200,
			RTTms:                  20,
			PacketLossRate:         0.0,
			ReputationScore:        0.99,
		},
	})

	// Add Hybrid Node
	engine.AddCandidate(&NodeCandidate{
		NodeID:      "jp-hybrid-1",
		PublicKey:   pk4,
		CountryCode: "JP",
		Role:        "HYBRID",
		Metrics: NodeMetrics{
			AvailableBandwidthMbps: 80,
			MaxBandwidthMbps:       100,
			RTTms:                  35,
			PacketLossRate:         0.0,
			ReputationScore:        0.90,
		},
	})

	// 1. Mode 1: Select by Country "US" -> Should pick us-exit-fast
	usCandidate, err := engine.SelectByCountry("US")
	if err != nil {
		t.Fatalf("SelectByCountry US failed: %v", err)
	}
	if usCandidate.NodeID != "us-exit-fast" {
		t.Fatalf("Expected us-exit-fast, got %s", usCandidate.NodeID)
	}

	// 2. Mode 2: Select by Host ID "jp-hybrid-1"
	jpCandidate, err := engine.SelectByHostID("jp-hybrid-1")
	if err != nil {
		t.Fatalf("SelectByHostID failed: %v", err)
	}
	if jpCandidate.NodeID != "jp-hybrid-1" {
		t.Fatalf("Expected jp-hybrid-1, got %s", jpCandidate.NodeID)
	}

	// 3. Mode 3: Build 3-Hop Onion Circuit for US exit
	circuit, err := engine.BuildOnionCircuit("US")
	if err != nil {
		t.Fatalf("BuildOnionCircuit failed: %v", err)
	}
	if circuit.Hops[2].NodeID != "us-exit-fast" {
		t.Fatalf("Expected Exit hop to be us-exit-fast, got %s", circuit.Hops[2].NodeID)
	}

	// Check Jitter Delay
	delay := circuit.ComputeJitterDelay()
	if delay < 2*time.Millisecond || delay > 25*time.Millisecond {
		t.Fatalf("Jitter delay out of expected range: %v", delay)
	}
}

func TestAdaptiveMultiPathScoringAndFailover(t *testing.T) {
	mpm := NewMultiPathManager("peer-destination-1")

	p2pPath := &NetworkPath{
		ID:             "path-p2p-wifi",
		Type:           PathTypeDirectP2P,
		RemoteAddr:     &net.UDPAddr{IP: net.ParseIP("198.51.100.10"), Port: 51820},
		LocalInterface: "en0",
		RTTms:          15.0,
		PacketLossRate: 0.0,
	}

	cellPath := &NetworkPath{
		ID:             "path-cellular",
		Type:           PathTypeCellular,
		RemoteAddr:     &net.UDPAddr{IP: net.ParseIP("198.51.100.11"), Port: 51820},
		LocalInterface: "pdp_ip0",
		RTTms:          35.0,
		PacketLossRate: 0.0,
	}

	relayPath := &NetworkPath{
		ID:             "path-derp-relay",
		Type:           PathTypeDERPRelay,
		RemoteAddr:     &net.UDPAddr{IP: net.ParseIP("203.0.113.50"), Port: 443},
		LocalInterface: "en0",
		RTTms:          60.0,
		PacketLossRate: 0.0,
	}

	mpm.RegisterPath(p2pPath)
	mpm.RegisterPath(cellPath)
	mpm.RegisterPath(relayPath)

	// 1. Initial best path should be Direct P2P
	best, switched := mpm.SelectBestPath()
	if best == nil || best.ID != "path-p2p-wifi" {
		t.Fatalf("Expected initial best path path-p2p-wifi, got %+v", best)
	}

	// 2. Direct P2P experiences severe degradation (packet loss)
	for i := 0; i < 5; i++ {
		_ = mpm.RecordTelemetry("path-p2p-wifi", 300*time.Millisecond, true)
	}

	// Re-evaluate paths -> should trigger failover to Cellular path
	newBest, switched := mpm.SelectBestPath()
	if !switched {
		t.Fatalf("Expected path switch after failure")
	}
	if newBest.ID != "path-cellular" {
		t.Fatalf("Expected failover to path-cellular, got %s (score: %f)", newBest.ID, newBest.Score)
	}

	active, err := mpm.GetActivePath()
	if err != nil || active.ID != "path-cellular" {
		t.Fatalf("Active path should be path-cellular")
	}

	paths := mpm.GetAllPaths()
	if len(paths) != 3 {
		t.Fatalf("Expected 3 candidate paths, got %d", len(paths))
	}
}
