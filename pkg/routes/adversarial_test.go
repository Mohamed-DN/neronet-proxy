package routes

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"testing"
)

// TestAdversarialOverlappingCIDRsAndLPMHierarchy probes multi-level nested CIDR prefixes and dynamic route disabling fallback.
func TestAdversarialOverlappingCIDRsAndLPMHierarchy(t *testing.T) {
	rt := NewRouteTable()

	// Register 7 hierarchical levels of overlapping CIDRs
	hierarchy := []struct {
		id   string
		cidr string
		gw   string
	}{
		{"rt-0", "0.0.0.0/0", "gw-default"},
		{"rt-1", "10.0.0.0/8", "gw-10-8"},
		{"rt-2", "10.20.0.0/16", "gw-10-20-16"},
		{"rt-3", "10.20.30.0/24", "gw-10-20-30-24"},
		{"rt-4", "10.20.30.128/25", "gw-10-20-30-128-25"},
		{"rt-5", "10.20.30.160/27", "gw-10-20-30-160-27"},
		{"rt-6", "10.20.30.165/32", "gw-10-20-30-165-32"},
	}

	for _, h := range hierarchy {
		_, err := rt.AddRoute(h.id, "net-"+h.id, h.cidr, []*RoutingPeerSpec{
			{NodeID: h.gw, Priority: 1, IsHealthy: true},
		}, []string{"group:all"}, true, FailoverActivePassive)
		if err != nil {
			t.Fatalf("Failed to add route %s (%s): %v", h.id, h.cidr, err)
		}
	}

	queries := []struct {
		ip         string
		expectedGW string
		expectedRT string
	}{
		{"10.20.30.165", "gw-10-20-30-165-32", "rt-6"}, // Exact /32 match
		{"10.20.30.166", "gw-10-20-30-160-27", "rt-5"}, // /27 match
		{"10.20.30.130", "gw-10-20-30-128-25", "rt-4"}, // /25 match
		{"10.20.30.10", "gw-10-20-30-24", "rt-3"},      // /24 match
		{"10.20.50.1", "gw-10-20-16", "rt-2"},          // /16 match
		{"10.99.1.1", "gw-10-8", "rt-1"},               // /8 match
		{"198.51.100.1", "gw-default", "rt-0"},         // default 0.0.0.0/0 match
	}

	for _, q := range queries {
		t.Run("Query_"+q.ip, func(t *testing.T) {
			peer, route, err := rt.SelectNextHop(net.ParseIP(q.ip), []string{"group:all"})
			if err != nil {
				t.Fatalf("SelectNextHop(%s) failed: %v", q.ip, err)
			}
			if route.ID != q.expectedRT || peer.NodeID != q.expectedGW {
				t.Fatalf("LPM mismatch for IP %s: expected (%s, %s), got (%s, %s)",
					q.ip, q.expectedRT, q.expectedGW, route.ID, peer.NodeID)
			}
		})
	}

	// Disable rt-6 (/32) -> 10.20.30.165 must fallback to rt-5 (/27)
	rt6, _ := rt.GetRoute("rt-6")
	rt6.Enabled = false
	_ = rt.UpsertRoute(rt6)

	peer, route, err := rt.SelectNextHop(net.ParseIP("10.20.30.165"), []string{"group:all"})
	if err != nil {
		t.Fatalf("Fallback query failed: %v", err)
	}
	if route.ID != "rt-5" || peer.NodeID != "gw-10-20-30-160-27" {
		t.Fatalf("Expected fallback to rt-5 (/27), got route %s / %s", route.ID, peer.NodeID)
	}

	// Delete default route rt-0 -> querying public IP must return ErrRouteNotFound
	_ = rt.DeleteRoute("rt-0")
	_, _, err = rt.SelectNextHop(net.ParseIP("198.51.100.1"), []string{"group:all"})
	if !errors.Is(err, ErrRouteNotFound) {
		t.Fatalf("Expected ErrRouteNotFound after default route deletion, got: %v", err)
	}
}

// TestAdversarialRapidGatewayFlappingAndHysteresis verifies the 3-probe hysteresis threshold under erratic probe conditions.
func TestAdversarialRapidGatewayFlappingAndHysteresis(t *testing.T) {
	rt := NewRouteTable()

	peers := []*RoutingPeerSpec{
		{NodeID: "primary-gw", Priority: 1, LatencyRTTms: 10.0, IsHealthy: true},
		{NodeID: "secondary-gw", Priority: 2, LatencyRTTms: 20.0, IsHealthy: true},
	}

	_, _ = rt.AddRoute("rt-flap", "flap-net", "192.168.10.0/24", peers, []string{"group:all"}, true, FailoverActivePassive)

	targetIP := net.ParseIP("192.168.10.25")

	// Phase 1: 1 fail -> 1 success -> 2 fails -> 1 success -> primary must NEVER lose active state
	rt.UpdatePeerHealth("rt-flap", "primary-gw", false, 0)
	p, _, _ := rt.SelectNextHop(targetIP, []string{"group:all"})
	if p.NodeID != "primary-gw" {
		t.Fatalf("Primary lost active state after 1 failed probe")
	}

	rt.UpdatePeerHealth("rt-flap", "primary-gw", true, 10.0)
	p, _, _ = rt.SelectNextHop(targetIP, []string{"group:all"})
	if p.NodeID != "primary-gw" {
		t.Fatalf("Primary lost active state after recovery")
	}

	rt.UpdatePeerHealth("rt-flap", "primary-gw", false, 0)
	rt.UpdatePeerHealth("rt-flap", "primary-gw", false, 0)
	p, _, _ = rt.SelectNextHop(targetIP, []string{"group:all"})
	if p.NodeID != "primary-gw" {
		t.Fatalf("Primary lost active state after 2 failed probes (threshold is 3)")
	}

	rt.UpdatePeerHealth("rt-flap", "primary-gw", true, 10.0) // Reset fail count to 0

	// Phase 2: Exactly 3 consecutive fails -> failover to secondary
	rt.UpdatePeerHealth("rt-flap", "primary-gw", false, 0)
	rt.UpdatePeerHealth("rt-flap", "primary-gw", false, 0)
	changed := rt.UpdatePeerHealth("rt-flap", "primary-gw", false, 0)
	if !changed {
		t.Fatalf("Expected state change on 3rd failure")
	}

	p, _, err := rt.SelectNextHop(targetIP, []string{"group:all"})
	if err != nil || p.NodeID != "secondary-gw" {
		t.Fatalf("Expected failover to secondary-gw, got: %v (peer: %s)", err, p.NodeID)
	}

	// Phase 3: Immediate recovery of primary on single healthy probe
	changed = rt.UpdatePeerHealth("rt-flap", "primary-gw", true, 10.0)
	if !changed {
		t.Fatalf("Expected state change on primary recovery")
	}
	p, _, err = rt.SelectNextHop(targetIP, []string{"group:all"})
	if err != nil || p.NodeID != "primary-gw" {
		t.Fatalf("Expected immediate failback to primary-gw, got: %v (peer: %s)", err, p.NodeID)
	}
}

// TestAdversarialAllPeerFailureAndExhaustion verifies correct error handling when all routing peers in a subnet fail.
func TestAdversarialAllPeerFailureAndExhaustion(t *testing.T) {
	rt := NewRouteTable()

	peers := []*RoutingPeerSpec{
		{NodeID: "gw-1", Priority: 1, IsHealthy: true},
		{NodeID: "gw-2", Priority: 2, IsHealthy: true},
		{NodeID: "gw-3", Priority: 3, IsHealthy: true},
	}

	_, _ = rt.AddRoute("rt-fail-all", "fail-net", "10.40.0.0/16", peers, []string{"group:all"}, true, FailoverActivePassive)

	targetIP := net.ParseIP("10.40.1.1")

	// Fail all 3 gateways
	for _, gw := range []string{"gw-1", "gw-2", "gw-3"} {
		for i := 0; i < 3; i++ {
			rt.UpdatePeerHealth("rt-fail-all", gw, false, 0)
		}
	}

	_, _, err := rt.SelectNextHop(targetIP, []string{"group:all"})
	if err == nil || !errors.Is(err, ErrNoHealthyGateway) {
		t.Fatalf("Expected ErrNoHealthyGateway when all peers fail, got: %v", err)
	}
}

// TestAdversarialECMPFlowDistributionAffinityAndExcision validates ECMP flow hashing, flow affinity, and rebalancing under node failure.
func TestAdversarialECMPFlowDistributionAffinityAndExcision(t *testing.T) {
	rt := NewRouteTable()

	peers := []*RoutingPeerSpec{
		{NodeID: "ecmp-node-1", Priority: 1, IsHealthy: true},
		{NodeID: "ecmp-node-2", Priority: 1, IsHealthy: true},
		{NodeID: "ecmp-node-3", Priority: 1, IsHealthy: true},
		{NodeID: "ecmp-node-4", Priority: 1, IsHealthy: true},
	}

	_, err := rt.AddRoute("rt-ecmp-stress", "ecmp-net", "172.20.0.0/16", peers, []string{"group:all"}, true, FailoverActiveActive)
	if err != nil {
		t.Fatalf("AddRoute failed: %v", err)
	}

	// 1. Flow Affinity: Verify that the SAME destination IP always hashes to the EXACT same gateway
	testIP := net.ParseIP("172.20.88.42")
	firstPeer, _, err := rt.SelectNextHop(testIP, []string{"group:all"})
	if err != nil {
		t.Fatalf("SelectNextHop failed: %v", err)
	}
	for i := 0; i < 100; i++ {
		p, _, _ := rt.SelectNextHop(testIP, []string{"group:all"})
		if p.NodeID != firstPeer.NodeID {
			t.Fatalf("ECMP Flow affinity broken! Expected consistent gateway %s, got %s at iteration %d", firstPeer.NodeID, p.NodeID, i)
		}
	}

	// 2. Sequential Flow Distribution: 200 sequential destination IPs spread across all 4 gateways
	seqDistribution := make(map[string]int)
	for i := 1; i <= 200; i++ {
		destIP := net.ParseIP(fmt.Sprintf("172.20.1.%d", i))
		p, _, err := rt.SelectNextHop(destIP, []string{"group:all"})
		if err != nil {
			t.Fatalf("SelectNextHop failed for %s: %v", destIP, err)
		}
		seqDistribution[p.NodeID]++
	}

	if len(seqDistribution) != 4 {
		t.Fatalf("Expected sequential traffic to reach all 4 gateways, got distribution: %v", seqDistribution)
	}

	// 3. Empirical Probe: ECMP Hash Polarization / Link Starvation Detection
	// Correlated IP patterns (e.g. subnets where octets 3 and 4 have even parity combinations)
	// reveal the 31-multiplier parity limitation in simple polynomial hashing.
	correlatedDistribution := make(map[string]int)
	for i := 1; i <= 200; i++ {
		destIP := net.ParseIP(fmt.Sprintf("172.20.%d.%d", i%250, (i*7)%250))
		p, _, err := rt.SelectNextHop(destIP, []string{"group:all"})
		if err != nil {
			t.Fatalf("SelectNextHop failed for %s: %v", destIP, err)
		}
		correlatedDistribution[p.NodeID]++
	}
	t.Logf("Empirical ECMP Polarization Profile on Correlated IPs: %v (utilized %d/4 nodes)",
		correlatedDistribution, len(correlatedDistribution))

	// 4. Node Excision: Fail ecmp-node-1 and ecmp-node-2 (3 failed probes each)
	for _, node := range []string{"ecmp-node-1", "ecmp-node-2"} {
		for k := 0; k < 3; k++ {
			rt.UpdatePeerHealth("rt-ecmp-stress", node, false, 0)
		}
	}

	// Verify zero traffic routes to failed nodes
	distributionPostFail := make(map[string]int)
	for i := 1; i <= 200; i++ {
		destIP := net.ParseIP(fmt.Sprintf("172.20.1.%d", i))
		p, _, err := rt.SelectNextHop(destIP, []string{"group:all"})
		if err != nil {
			t.Fatalf("SelectNextHop failed for %s: %v", destIP, err)
		}
		if p.NodeID == "ecmp-node-1" || p.NodeID == "ecmp-node-2" {
			t.Fatalf("Traffic incorrectly routed to failed node %s!", p.NodeID)
		}
		distributionPostFail[p.NodeID]++
	}

	if len(distributionPostFail) != 2 {
		t.Fatalf("Expected traffic to balance across remaining 2 nodes, got: %v", distributionPostFail)
	}
}

// TestAdversarialRouteNilAndBoundaryInputs validates defensive handling of nil IPs, empty groups, and non-existent peers.
func TestAdversarialRouteNilAndBoundaryInputs(t *testing.T) {
	rt := NewRouteTable()

	_, _ = rt.AddRoute("rt-v4", "v4-net", "10.0.0.0/8", []*RoutingPeerSpec{
		{NodeID: "gw-v4", Priority: 1, IsHealthy: true},
	}, []string{"group:all"}, true, FailoverActivePassive)

	// 1. Nil IP lookup -> should return ErrRouteNotFound gracefully without panic
	_, _, err := rt.SelectNextHop(nil, []string{"group:all"})
	if !errors.Is(err, ErrRouteNotFound) {
		t.Fatalf("Expected ErrRouteNotFound on nil destIP, got: %v", err)
	}

	// 2. IPv6 destination lookup against IPv4-only route table -> should return ErrRouteNotFound gracefully
	ipv6Dest := net.ParseIP("2001:db8::1")
	_, _, err = rt.SelectNextHop(ipv6Dest, []string{"group:all"})
	if !errors.Is(err, ErrRouteNotFound) {
		t.Fatalf("Expected ErrRouteNotFound on unmatched IPv6 destIP, got: %v", err)
	}

	// 3. Health update on non-existent route or non-existent peer
	changed := rt.UpdatePeerHealth("rt-nonexistent", "gw-v4", false, 0)
	if changed {
		t.Fatalf("Expected changed=false on non-existent route")
	}
	changed = rt.UpdatePeerHealth("rt-v4", "gw-nonexistent", false, 0)
	if changed {
		t.Fatalf("Expected changed=false on non-existent peer")
	}
}

// TestAdversarialRouteTableConcurrentStress tests high concurrency race conditions and multi-threaded state consistency.
func TestAdversarialRouteTableConcurrentStress(t *testing.T) {
	rt := NewRouteTable()

	// Add base routes
	for i := 1; i <= 10; i++ {
		cidr := fmt.Sprintf("10.%d.0.0/16", i)
		_, _ = rt.AddRoute(fmt.Sprintf("rt-%d", i), fmt.Sprintf("net-%d", i), cidr, []*RoutingPeerSpec{
			{NodeID: fmt.Sprintf("gw-%d-a", i), Priority: 1, IsHealthy: true},
			{NodeID: fmt.Sprintf("gw-%d-b", i), Priority: 2, IsHealthy: true},
		}, []string{"group:all"}, true, FailoverActivePassive)
	}

	var wg sync.WaitGroup
	workers := 40
	iterations := 100

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for it := 0; it < iterations; it++ {
				routeIdx := (workerID % 10) + 1
				routeID := fmt.Sprintf("rt-%d", routeIdx)
				gwID := fmt.Sprintf("gw-%d-a", routeIdx)

				// Concurrent health updates
				isHealthy := (it % 2) == 0
				rt.UpdatePeerHealth(routeID, gwID, isHealthy, 15.0)

				// Concurrent next-hop lookups
				destIP := net.ParseIP(fmt.Sprintf("10.%d.5.5", routeIdx))
				_, _, _ = rt.SelectNextHop(destIP, []string{"group:all"})

				// Concurrent route listing & node querying
				_ = rt.ListRoutes()
				_ = rt.GetRoutesForNode(fmt.Sprintf("gw-%d-a", routeIdx), []string{"group:all"})
				_ = rt.Epoch()
			}
		}(w)
	}

	wg.Wait()
}
