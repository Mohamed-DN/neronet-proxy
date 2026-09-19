package nat

import (
	"context"
	"encoding/json"
	"net"
	"sync"
	"testing"
	"time"
)

func TestSTUNEncodeDecode(t *testing.T) {
	req, err := NewSTUNBindingRequest()
	if err != nil {
		t.Fatalf("NewSTUNBindingRequest failed: %v", err)
	}

	encoded := req.Encode()
	decoded, err := DecodeSTUN(encoded)
	if err != nil {
		t.Fatalf("DecodeSTUN failed: %v", err)
	}

	if decoded.Type != STUNBindingRequest {
		t.Fatalf("Expected type %d, got %d", STUNBindingRequest, decoded.Type)
	}
	if decoded.TransactionID != req.TransactionID {
		t.Fatalf("TransactionID mismatch")
	}
}

func TestSTUNServerReflection(t *testing.T) {
	server, err := StartSTUNServer("127.0.0.1:0")
	if err != nil {
		t.Fatalf("StartSTUNServer failed: %v", err)
	}
	defer server.Close()

	serverAddr := server.Addr().String()

	mapped, err := QuerySTUN(serverAddr, 2*time.Second, nil)
	if err != nil {
		t.Fatalf("QuerySTUN failed: %v", err)
	}

	if mapped.IP.String() != "127.0.0.1" {
		t.Fatalf("Expected mapped IP 127.0.0.1, got %s", mapped.IP.String())
	}
	if mapped.Port <= 0 {
		t.Fatalf("Invalid mapped port: %d", mapped.Port)
	}
}

func TestNATClassificationAndStrategy(t *testing.T) {
	srv1, err := StartSTUNServer("127.0.0.1:0")
	if err != nil {
		t.Fatalf("StartSTUNServer 1 failed: %v", err)
	}
	defer srv1.Close()

	srv2, err := StartSTUNServer("127.0.0.1:0")
	if err != nil {
		t.Fatalf("StartSTUNServer 2 failed: %v", err)
	}
	defer srv2.Close()

	servers := []string{srv1.Addr().String(), srv2.Addr().String()}

	clientConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatalf("ListenUDP failed: %v", err)
	}
	defer clientConn.Close()

	desc, err := ClassifyNAT(servers, clientConn, 2*time.Second)
	if err != nil {
		t.Fatalf("ClassifyNAT failed: %v", err)
	}

	if desc.Type != NATTypeDirectPublic && desc.Type != NATTypePortRestrictedCone {
		t.Fatalf("Unexpected NAT type for loopback STUN: %s", desc.Type)
	}

	// Test Strategy Selection
	coneDesc := &NATDescriptor{Type: NATTypePortRestrictedCone}
	symmSeqDesc := &NATDescriptor{Type: NATTypeSymmetric, IsSequential: true, PortDelta: 2}
	symmRandDesc := &NATDescriptor{Type: NATTypeSymmetric, IsSequential: false}
	blockedDesc := &NATDescriptor{Type: NATTypeBlocked}

	if strat := SelectStrategy(coneDesc, coneDesc); strat != StrategyDualPing {
		t.Fatalf("Expected StrategyDualPing, got %s", strat)
	}
	if strat := SelectStrategy(symmSeqDesc, coneDesc); strat != StrategySequentialPrediction {
		t.Fatalf("Expected StrategySequentialPrediction, got %s", strat)
	}
	if strat := SelectStrategy(symmRandDesc, symmRandDesc); strat != StrategyBirthdaySpray {
		t.Fatalf("Expected StrategyBirthdaySpray, got %s", strat)
	}
	if strat := SelectStrategy(blockedDesc, coneDesc); strat != StrategyDERPFallback {
		t.Fatalf("Expected StrategyDERPFallback, got %s", strat)
	}
}

func TestHolePunchSimulation(t *testing.T) {
	// Setup two simulated peer sockets
	aliceConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatalf("Alice listen failed: %v", err)
	}
	defer aliceConn.Close()

	bobConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatalf("Bob listen failed: %v", err)
	}
	defer bobConn.Close()

	aliceAddr := aliceConn.LocalAddr().(*net.UDPAddr)
	bobAddr := bobConn.LocalAddr().(*net.UDPAddr)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	resChan := make(chan *SprayResult)
	errChan := make(chan error)

	// Alice executes sequential probe targeting Bob's port
	go func() {
		res, err := ExecuteSequentialPrediction(ctx, aliceConn, bobAddr.IP, bobAddr.Port, 0, 10)
		if err != nil {
			errChan <- err
		} else {
			resChan <- res
		}
	}()

	// Bob executes birthday spray / probe targeting Alice's port
	go func() {
		res, err := ExecuteBirthdaySpray(ctx, bobConn, aliceAddr.IP, aliceAddr.Port, 32)
		if err != nil {
			errChan <- err
		} else {
			resChan <- res
		}
	}()

	select {
	case res := <-resChan:
		if res.RemoteAddr == nil {
			t.Fatalf("Result remote address is nil")
		}
	case err := <-errChan:
		t.Fatalf("Hole punch failed: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatalf("Hole punch test timed out")
	}
}

func TestICEGatheringAndProbing(t *testing.T) {
	// 1. Setup mock STUN servers
	srv1, err := StartSTUNServer("127.0.0.1:0")
	if err != nil {
		t.Fatalf("StartSTUNServer 1 failed: %v", err)
	}
	defer srv1.Close()

	srv2, err := StartSTUNServer("127.0.0.1:0")
	if err != nil {
		t.Fatalf("StartSTUNServer 2 failed: %v", err)
	}
	defer srv2.Close()

	stunServers := []string{srv1.Addr().String(), srv2.Addr().String()}

	clientConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatalf("ListenUDP client failed: %v", err)
	}
	defer clientConn.Close()

	agent := NewICEAgent(stunServers, clientConn)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	candidates, err := agent.GatherCandidates(ctx, 1*time.Second)
	if err != nil {
		t.Fatalf("GatherCandidates failed: %v", err)
	}

	if len(candidates) == 0 {
		t.Fatalf("Expected at least 1 gathered candidate")
	}

	// Create remote dummy candidates (loopback to STUN servers)
	remoteCandidates := []ICECandidate{
		{
			Foundation: "r1",
			Component:  1,
			Protocol:   "udp",
			Priority:   CalculateCandidatePriority(CandidateServerReflexive, 65530, 1),
			IP:         srv1.Addr().IP,
			Port:       srv1.Addr().Port,
			Type:       CandidateServerReflexive,
		},
	}

	pairs := agent.FormCandidatePairs(remoteCandidates)
	if len(pairs) == 0 {
		t.Fatalf("Expected formed candidate pairs")
	}

	nominated, err := agent.ProbeCandidatePairs(ctx, 1*time.Second)
	if err != nil {
		t.Fatalf("ProbeCandidatePairs failed: %v", err)
	}

	if !nominated.Nominated {
		t.Fatalf("Expected nominated pair to have Nominated == true")
	}
	if nominated.State != "succeeded" {
		t.Fatalf("Expected nominated pair state 'succeeded', got %s", nominated.State)
	}
}

func TestLANDiscoveryBeaconing(t *testing.T) {
	nodeA, err := NewLANDiscoveryManager("node-alpha", "pubkey-alpha-123", "100.64.0.10", []string{"192.168.1.10:51820"}, "prod-mesh")
	if err != nil {
		t.Fatalf("NewLANDiscoveryManager nodeA failed: %v", err)
	}

	nodeB, err := NewLANDiscoveryManager("node-beta", "pubkey-beta-456", "100.64.0.11", []string{"192.168.1.11:51820"}, "prod-mesh")
	if err != nil {
		t.Fatalf("NewLANDiscoveryManager nodeB failed: %v", err)
	}

	var discoveredPeer DiscoveredPeer
	var discMu sync.Mutex
	peerDiscovered := make(chan struct{}, 1)

	nodeB.SetOnPeerFound(func(peer DiscoveredPeer) {
		discMu.Lock()
		discoveredPeer = peer
		discMu.Unlock()
		select {
		case peerDiscovered <- struct{}{}:
		default:
		}
	})

	beaconA, err := nodeA.CreateBeacon()
	if err != nil {
		t.Fatalf("CreateBeacon failed: %v", err)
	}

	data, err := json.Marshal(beaconA)
	if err != nil {
		t.Fatalf("Marshal beacon failed: %v", err)
	}

	// Node B processes Node A's inbound beacon
	peer, err := nodeB.ProcessInboundBeacon(data, &net.UDPAddr{IP: net.ParseIP("192.168.1.10"), Port: 51820})
	if err != nil {
		t.Fatalf("ProcessInboundBeacon failed: %v", err)
	}

	if peer == nil || peer.NodeID != "node-alpha" {
		t.Fatalf("Expected discovered peer node-alpha, got %+v", peer)
	}
	if peer.PublicKey != "pubkey-alpha-123" {
		t.Fatalf("PublicKey mismatch: %s", peer.PublicKey)
	}

	peers := nodeB.GetDiscoveredPeers()
	if len(peers) != 1 {
		t.Fatalf("Expected 1 discovered peer in nodeB table, got %d", len(peers))
	}

	discMu.Lock()
	cbNodeID := discoveredPeer.NodeID
	discMu.Unlock()
	if cbNodeID != "node-alpha" {
		t.Fatalf("Expected callback to receive node-alpha, got %s", cbNodeID)
	}

	// Self-beacon should be ignored
	beaconB, _ := nodeB.CreateBeacon()
	dataB, _ := json.Marshal(beaconB)
	selfPeer, err := nodeB.ProcessInboundBeacon(dataB, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 51830})
	if err != nil {
		t.Fatalf("Self beacon error: %v", err)
	}
	if selfPeer != nil {
		t.Fatalf("Self beacon should return nil peer")
	}
}
