package acl

import (
	"net"
	"testing"
	"time"
)

func TestParsePortRanges(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		expected  []PortRange
		shouldErr bool
	}{
		{
			name:     "Wildcard star",
			input:    "*",
			expected: []PortRange{{Start: 1, End: 65535}},
		},
		{
			name:     "Empty string",
			input:    "",
			expected: []PortRange{{Start: 1, End: 65535}},
		},
		{
			name:     "Single port",
			input:    "80",
			expected: []PortRange{{Start: 80, End: 80}},
		},
		{
			name:     "Comma-separated ports",
			input:    "80, 443, 8080",
			expected: []PortRange{{Start: 80, End: 80}, {Start: 443, End: 443}, {Start: 8080, End: 8080}},
		},
		{
			name:     "Port range",
			input:    "8000-8080",
			expected: []PortRange{{Start: 8000, End: 8080}},
		},
		{
			name:     "Mixed single and ranges",
			input:    "22, 80, 443, 8000-8080, 9000",
			expected: []PortRange{{Start: 22, End: 22}, {Start: 80, End: 80}, {Start: 443, End: 443}, {Start: 8000, End: 8080}, {Start: 9000, End: 9000}},
		},
		{
			name:      "Reversed port range",
			input:     "8080-8000",
			shouldErr: true,
		},
		{
			name:      "Invalid non-numeric",
			input:     "http,https",
			shouldErr: true,
		},
		{
			name:      "Port zero",
			input:     "0",
			shouldErr: true,
		},
		{
			name:      "Port out of range >65535",
			input:     "70000",
			shouldErr: true,
		},
		{
			name:      "Malformed range triple dash",
			input:     "80-90-100",
			shouldErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res, err := ParsePortRanges(tc.input)
			if tc.shouldErr {
				if err == nil {
					t.Fatalf("Expected error for input %q, got nil", tc.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("Unexpected error for input %q: %v", tc.input, err)
			}
			if len(res) != len(tc.expected) {
				t.Fatalf("Expected %d ranges, got %d", len(tc.expected), len(res))
			}
			for i, r := range res {
				if r.Start != tc.expected[i].Start || r.End != tc.expected[i].End {
					t.Fatalf("Range mismatch at index %d: expected %+v, got %+v", i, tc.expected[i], r)
				}
			}
		})
	}
}

func TestPolicyEngineGroupsAndMemberships(t *testing.T) {
	pe := NewPolicyEngine()

	// Check default system groups
	groups := pe.ListGroups()
	if len(groups) < 6 {
		t.Fatalf("Expected at least 6 system groups, got %d", len(groups))
	}

	allGroup, ok := pe.GetGroup("group:all")
	if !ok || !allGroup.IsSystem {
		t.Fatalf("Expected group:all to exist and be system group")
	}

	// Try deleting system group -> should fail
	if err := pe.DeleteGroup("group:all"); err == nil {
		t.Fatalf("Expected error deleting system group:all, got nil")
	}

	// Add custom group
	err := pe.UpsertGroup(&PeerGroup{
		ID:          "group:devs",
		Name:        "Developers",
		Description: "Development engineering team",
	})
	if err != nil {
		t.Fatalf("UpsertGroup failed: %v", err)
	}

	// Assign peers
	if err := pe.AssignPeerToGroup("group:devs", "node-alice"); err != nil {
		t.Fatalf("AssignPeerToGroup failed: %v", err)
	}
	if err := pe.AssignPeerToGroup("group:devs", "node-bob"); err != nil {
		t.Fatalf("AssignPeerToGroup failed: %v", err)
	}
	if err := pe.AssignPeerToGroup("group:exit-nodes", "node-exit1"); err != nil {
		t.Fatalf("AssignPeerToGroup failed: %v", err)
	}

	// Verify assignments
	aliceGroups := pe.GetPeerGroups("node-alice")
	foundDevs := false
	foundAll := false
	for _, g := range aliceGroups {
		if g == "group:devs" {
			foundDevs = true
		}
		if g == "group:all" {
			foundAll = true
		}
	}
	if !foundDevs || !foundAll {
		t.Fatalf("Expected node-alice to be in group:devs and group:all, got: %v", aliceGroups)
	}

	// Remove peer from group
	if err := pe.RemovePeerFromGroup("group:devs", "node-bob"); err != nil {
		t.Fatalf("RemovePeerFromGroup failed: %v", err)
	}
	devsGrp, _ := pe.GetGroup("group:devs")
	if len(devsGrp.Peers) != 1 || devsGrp.Peers[0] != "node-alice" {
		t.Fatalf("Expected only node-alice in group:devs, got %v", devsGrp.Peers)
	}

	// Delete custom group -> should succeed
	if err := pe.DeleteGroup("group:devs"); err != nil {
		t.Fatalf("Failed to delete custom group: %v", err)
	}
}

func TestPolicyCompilationDirectionalAndBidirectional(t *testing.T) {
	pe := NewPolicyEngine()

	// Setup custom groups
	_ = pe.UpsertGroup(&PeerGroup{ID: "group:devs", Name: "Devs"})
	_ = pe.UpsertGroup(&PeerGroup{ID: "group:prod", Name: "Prod"})

	_ = pe.AssignPeerToGroup("group:devs", "alice")
	_ = pe.AssignPeerToGroup("group:prod", "db-prod")
	_ = pe.AssignPeerToGroup("group:exit-nodes", "exit-us")

	// Node lookup mock
	nodeVIPs := map[string]net.IP{
		"alice":    net.ParseIP("100.64.0.2"),
		"db-prod":  net.ParseIP("100.64.0.10"),
		"exit-us":  net.ParseIP("100.64.0.20"),
		"stranger": net.ParseIP("100.64.0.99"),
	}
	lookup := func(nodeID string) (net.IP, []string, bool) {
		vip, ok := nodeVIPs[nodeID]
		if !ok {
			return nil, nil, false
		}
		return vip, pe.GetPeerGroups(nodeID), true
	}

	// 1. Add Directional Rule: group:devs -> group:prod on TCP 5432 (PostgreSQL)
	err := pe.UpsertPolicy(&PolicyRule{
		ID:           "rule-dev-to-prod-db",
		Name:         "Dev to Prod DB",
		Enabled:      true,
		SourceGroups: []string{"group:devs"},
		DestGroups:   []string{"group:prod"},
		Rules: []RuleItem{
			{
				Protocol:   ProtocolTCP,
				PortRanges: []PortRange{{Start: 5432, End: 5432}},
				Action:     ActionAccept,
			},
		},
		Bidirectional: false, // Directional
	})
	if err != nil {
		t.Fatalf("UpsertPolicy failed: %v", err)
	}

	// 2. Add Bidirectional Rule: group:all -> group:exit-nodes on ALL protocols/ports
	err = pe.UpsertPolicy(&PolicyRule{
		ID:           "rule-all-to-exit",
		Name:         "All to Exit Nodes",
		Enabled:      true,
		SourceGroups: []string{"group:all"},
		DestGroups:   []string{"group:exit-nodes"},
		Rules: []RuleItem{
			{
				Protocol:   ProtocolALL,
				PortRanges: []PortRange{{Start: 1, End: 65535}},
				Action:     ActionAccept,
			},
		},
		Bidirectional: true,
	})
	if err != nil {
		t.Fatalf("UpsertPolicy 2 failed: %v", err)
	}

	// Compile for Alice (Dev)
	alicePolicy, err := pe.CompilePolicyForPeer("alice", lookup)
	if err != nil {
		t.Fatalf("CompilePolicyForPeer(alice) failed: %v", err)
	}

	if !alicePolicy.OverlayIPv4.Equal(nodeVIPs["alice"]) {
		t.Fatalf("Alice policy VIP mismatch: got %v", alicePolicy.OverlayIPv4)
	}

	// Alice should have Outbound rule to db-prod (100.64.0.10:5432) and exit-us (100.64.0.20:*)
	foundDBOutbound := false
	foundExitOutbound := false
	for _, r := range alicePolicy.OutboundRules {
		if r.AllowedPeerVIP.Equal(nodeVIPs["db-prod"]) && r.Protocol == ProtocolTCP && r.PortRanges[0].Start == 5432 {
			foundDBOutbound = true
		}
		if r.AllowedPeerVIP.Equal(nodeVIPs["exit-us"]) && r.Protocol == ProtocolALL {
			foundExitOutbound = true
		}
	}
	if !foundDBOutbound {
		t.Fatalf("Alice missing outbound rule to db-prod:5432")
	}
	if !foundExitOutbound {
		t.Fatalf("Alice missing outbound rule to exit-us")
	}

	// Because rule-dev-to-prod-db is directional, Alice should NOT have Inbound rule from db-prod for 5432,
	// but SHOULD have Inbound rule from exit-us (because rule-all-to-exit is bidirectional)
	for _, r := range alicePolicy.InboundRules {
		if r.AllowedPeerVIP.Equal(nodeVIPs["db-prod"]) {
			t.Fatalf("Directional rule incorrectly added inbound rule from db-prod to alice")
		}
	}

	// Compile for db-prod
	dbPolicy, err := pe.CompilePolicyForPeer("db-prod", lookup)
	if err != nil {
		t.Fatalf("CompilePolicyForPeer(db-prod) failed: %v", err)
	}

	// db-prod should have Inbound rule from alice on port 5432
	foundAliceInbound := false
	for _, r := range dbPolicy.InboundRules {
		if r.AllowedPeerVIP.Equal(nodeVIPs["alice"]) && r.Protocol == ProtocolTCP && r.PortRanges[0].Start == 5432 {
			foundAliceInbound = true
		}
	}
	if !foundAliceInbound {
		t.Fatalf("db-prod missing inbound rule from alice on 5432")
	}

	// db-prod should NOT have Outbound rule to alice on port 5432 (directional)
	for _, r := range dbPolicy.OutboundRules {
		if r.AllowedPeerVIP.Equal(nodeVIPs["alice"]) {
			t.Fatalf("db-prod should not have outbound initiation rule to alice for directional policy")
		}
	}
}

func TestNetstackFilterConntrackAndStatefulEnforcement(t *testing.T) {
	filter := NewNetstackFilter()
	filter.SetConntrackTTL(200 * time.Millisecond) // Short TTL for testing expiration

	clientVIP := net.ParseIP("100.64.0.5")
	serverVIP := net.ParseIP("100.64.0.20")
	unauthorizedVIP := net.ParseIP("100.64.0.99")

	// 1. Initial State: No policy loaded -> default deny
	if err := filter.EvaluateOutbound(serverVIP, ProtocolTCP, 443); err == nil {
		t.Fatalf("Expected default deny on outbound with no policy loaded")
	}
	if err := filter.EvaluateInbound(serverVIP, 443, 50000, ProtocolTCP); err == nil {
		t.Fatalf("Expected default deny on inbound with no policy loaded")
	}

	// 2. Install Policy: Client can make Outbound TCP 443 to serverVIP, but NO Inbound rules
	policy := &CompiledPeerPolicy{
		NodeID:      "client-1",
		OverlayIPv4: clientVIP,
		OutboundRules: []CompiledFilterRule{
			{
				AllowedPeerVIP: serverVIP,
				Protocol:       ProtocolTCP,
				PortRanges:     []PortRange{{Start: 443, End: 443}},
				Action:         ActionAccept,
				IsDirectional:  true,
			},
			{
				AllowedPeerVIP: unauthorizedVIP,
				Protocol:       ProtocolALL,
				PortRanges:     []PortRange{{Start: 1, End: 65535}},
				Action:         ActionDrop,
				IsDirectional:  true,
			},
		},
		InboundRules: []CompiledFilterRule{}, // Empty inbound
		Epoch:        1,
	}
	filter.UpdatePolicy(policy)

	// Outbound to unauthorized VIP should be blocked by DROP rule
	if err := filter.EvaluateOutbound(unauthorizedVIP, ProtocolTCP, 80); err == nil {
		t.Fatalf("Expected DROP rule to block outbound to unauthorized VIP")
	}

	// Outbound to unlisted port on serverVIP should be blocked by default deny
	if err := filter.EvaluateOutbound(serverVIP, ProtocolTCP, 80); err == nil {
		t.Fatalf("Expected default deny on unlisted port 80")
	}

	// Inbound unsolicited packet from serverVIP to client should fail (no inbound rule, no conntrack yet)
	if err := filter.EvaluateInbound(serverVIP, 443, 52100, ProtocolTCP); err == nil {
		t.Fatalf("Expected unsolicited inbound packet to be dropped")
	}

	// 3. Client initiates outbound connection to serverVIP:443
	err := filter.EvaluateOutbound4Tuple(clientVIP, 52100, serverVIP, 443, ProtocolTCP)
	if err != nil {
		t.Fatalf("EvaluateOutbound4Tuple failed: %v", err)
	}

	if filter.ConntrackCount() == 0 {
		t.Fatalf("Expected conntrack entry to be recorded after successful outbound evaluation")
	}

	// 4. Inbound return packet from serverVIP:443 to client:52100 should now SUCCEED via Conntrack!
	err = filter.EvaluateInbound(serverVIP, 443, 52100, ProtocolTCP)
	if err != nil {
		t.Fatalf("Stateful return packet failed conntrack evaluation: %v", err)
	}

	// Inbound packet from different IP should still be dropped
	if err := filter.EvaluateInbound(unauthorizedVIP, 443, 52100, ProtocolTCP); err == nil {
		t.Fatalf("Expected unauthorized source to be dropped despite active conntrack")
	}

	// 5. Test Conntrack Expiration
	time.Sleep(250 * time.Millisecond) // Exceed 200ms TTL
	filter.PurgeExpiredConntrack()
	if filter.ConntrackCount() != 0 {
		t.Fatalf("Expected 0 conntrack entries after TTL expiration, got %d", filter.ConntrackCount())
	}

	// After expiration, inbound return packet should now be rejected!
	if err := filter.EvaluateInbound(serverVIP, 443, 52100, ProtocolTCP); err == nil {
		t.Fatalf("Expected expired conntrack entry to reject inbound return packet")
	}
}
