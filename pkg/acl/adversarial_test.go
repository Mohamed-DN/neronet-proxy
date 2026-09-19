package acl

import (
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

// TestAdversarialPortRangeBoundariesAndInvalidInputs stresses port parsing with edge values, overflows, and malformed strings.
func TestAdversarialPortRangeBoundariesAndInvalidInputs(t *testing.T) {
	edgeTests := []struct {
		name      string
		input     string
		shouldErr bool
		expected  []PortRange
	}{
		{
			name:     "Extreme single port min (1)",
			input:    "1",
			expected: []PortRange{{Start: 1, End: 1}},
		},
		{
			name:     "Extreme single port max (65535)",
			input:    "65535",
			expected: []PortRange{{Start: 65535, End: 65535}},
		},
		{
			name:     "Full span range (1-65535)",
			input:    "1-65535",
			expected: []PortRange{{Start: 1, End: 65535}},
		},
		{
			name:     "Single port range (80-80)",
			input:    "80-80",
			expected: []PortRange{{Start: 80, End: 80}},
		},
		{
			name:      "Zero port single (0)",
			input:     "0",
			shouldErr: true,
		},
		{
			name:      "Zero start in range (0-100)",
			input:     "0-100",
			shouldErr: true,
		},
		{
			name:      "Zero end in range (100-0)",
			input:     "100-0",
			shouldErr: true,
		},
		{
			name:      "Overflow port 16-bit boundary (65536)",
			input:     "65536",
			shouldErr: true,
		},
		{
			name:      "Huge overflow (99999999)",
			input:     "99999999",
			shouldErr: true,
		},
		{
			name:      "Negative port (-80)",
			input:     "-80",
			shouldErr: true,
		},
		{
			name:      "Reversed port range (443-80)",
			input:     "443-80",
			shouldErr: true,
		},
		{
			name:      "Multiple dashes in range (80-443-8080)",
			input:     "80-443-8080",
			shouldErr: true,
		},
		{
			name:      "Trailing comma (80,443,)",
			input:     "80,443,",
			shouldErr: true,
		},
		{
			name:      "Leading comma (,80,443)",
			input:     ",80,443",
			shouldErr: true,
		},
		{
			name:      "Empty commas in middle (80,,443)",
			input:     "80,,443",
			shouldErr: true,
		},
		{
			name:      "Non-numeric alphanumeric (http,https)",
			input:     "http,https",
			shouldErr: true,
		},
		{
			name:      "Hex notation (0x50)",
			input:     "0x50",
			shouldErr: true,
		},
		{
			name:  "Multiple overlapping and contiguous valid ranges",
			input: "80-100, 90-120, 110-200, 443, 65530-65535",
			expected: []PortRange{
				{Start: 80, End: 100},
				{Start: 90, End: 120},
				{Start: 110, End: 200},
				{Start: 443, End: 443},
				{Start: 65530, End: 65535},
			},
		},
	}

	for _, tc := range edgeTests {
		t.Run(tc.name, func(t *testing.T) {
			res, err := ParsePortRanges(tc.input)
			if tc.shouldErr {
				if err == nil {
					t.Fatalf("Expected error for input %q, got nil (parsed: %+v)", tc.input, res)
				}
				return
			}
			if err != nil {
				t.Fatalf("Unexpected error for input %q: %v", tc.input, err)
			}
			if len(res) != len(tc.expected) {
				t.Fatalf("Expected %d ranges, got %d for input %q", len(tc.expected), len(res), tc.input)
			}
			for i, r := range res {
				if r.Start != tc.expected[i].Start || r.End != tc.expected[i].End {
					t.Fatalf("Range mismatch at index %d: expected %+v, got %+v", i, tc.expected[i], r)
				}
			}
		})
	}
}

// TestAdversarialConflictingPoliciesAndOrdering verifies deterministic compilation and evaluation when rules conflict.
func TestAdversarialConflictingPoliciesAndOrdering(t *testing.T) {
	pe := NewPolicyEngine()

	_ = pe.UpsertGroup(&PeerGroup{ID: "group:clients", Name: "Clients", Peers: []string{"client-a"}})
	_ = pe.UpsertGroup(&PeerGroup{ID: "group:servers", Name: "Servers", Peers: []string{"server-b"}})

	clientVIP := net.ParseIP("100.64.0.10")
	serverVIP := net.ParseIP("100.64.0.20")

	lookup := func(nodeID string) (net.IP, []string, bool) {
		switch nodeID {
		case "client-a":
			return clientVIP, pe.GetPeerGroups(nodeID), true
		case "server-b":
			return serverVIP, pe.GetPeerGroups(nodeID), true
		default:
			return nil, nil, false
		}
	}

	// 1. Policy 1 (ID "pol-01-accept"): ACCEPT TCP 80
	err := pe.UpsertPolicy(&PolicyRule{
		ID:           "pol-01-accept",
		Name:         "Allow HTTP",
		Enabled:      true,
		SourceGroups: []string{"group:clients"},
		DestGroups:   []string{"group:servers"},
		Rules: []RuleItem{
			{
				Protocol:   ProtocolTCP,
				PortRanges: []PortRange{{Start: 80, End: 80}},
				Action:     ActionAccept,
			},
		},
		Bidirectional: false,
	})
	if err != nil {
		t.Fatalf("UpsertPolicy 1 failed: %v", err)
	}

	// 2. Policy 2 (ID "pol-02-drop"): DROP TCP 80 (Conflicting duplicate)
	err = pe.UpsertPolicy(&PolicyRule{
		ID:           "pol-02-drop",
		Name:         "Block HTTP Duplicate",
		Enabled:      true,
		SourceGroups: []string{"group:clients"},
		DestGroups:   []string{"group:servers"},
		Rules: []RuleItem{
			{
				Protocol:   ProtocolTCP,
				PortRanges: []PortRange{{Start: 80, End: 80}},
				Action:     ActionDrop,
			},
		},
		Bidirectional: false,
	})
	if err != nil {
		t.Fatalf("UpsertPolicy 2 failed: %v", err)
	}

	// Compile policy for client-a
	compiled, err := pe.CompilePolicyForPeer("client-a", lookup)
	if err != nil {
		t.Fatalf("CompilePolicyForPeer failed: %v", err)
	}

	// Client filter evaluation: pol-01-accept is sorted first and must match first
	filter := NewNetstackFilter()
	filter.UpdatePolicy(compiled)

	err = filter.EvaluateOutbound(serverVIP, ProtocolTCP, 80)
	if err != nil {
		t.Fatalf("Expected pol-01-accept to take precedence due to deterministic policy ordering: %v", err)
	}

	// Now swap precedence: Add "pol-00-drop" which sorts BEFORE "pol-01-accept"
	err = pe.UpsertPolicy(&PolicyRule{
		ID:           "pol-00-drop",
		Name:         "Override Drop HTTP",
		Enabled:      true,
		SourceGroups: []string{"group:clients"},
		DestGroups:   []string{"group:servers"},
		Rules: []RuleItem{
			{
				Protocol:   ProtocolTCP,
				PortRanges: []PortRange{{Start: 80, End: 80}},
				Action:     ActionDrop,
			},
		},
		Bidirectional: false,
	})
	if err != nil {
		t.Fatalf("UpsertPolicy 0 failed: %v", err)
	}

	compiled2, err := pe.CompilePolicyForPeer("client-a", lookup)
	if err != nil {
		t.Fatalf("CompilePolicyForPeer failed: %v", err)
	}
	filter.UpdatePolicy(compiled2)

	// Now outbound HTTP must be blocked by pol-00-drop
	err = filter.EvaluateOutbound(serverVIP, ProtocolTCP, 80)
	if err == nil || !errors.Is(err, ErrOutboundBlockedDrop) {
		t.Fatalf("Expected pol-00-drop to block outbound HTTP, got: %v", err)
	}
}

// TestAdversarialDirectionalBypassAndSpoofing tests directional enforcement, reverse initiation blockage, and spoofed return traffic rejection.
func TestAdversarialDirectionalBypassAndSpoofing(t *testing.T) {
	pe := NewPolicyEngine()

	_ = pe.UpsertGroup(&PeerGroup{ID: "group:workstation", Name: "Workstations", Peers: []string{"node-alice"}})
	_ = pe.UpsertGroup(&PeerGroup{ID: "group:db", Name: "Databases", Peers: []string{"node-db"}})

	aliceVIP := net.ParseIP("100.64.0.5")
	dbVIP := net.ParseIP("100.64.0.50")
	attackerVIP := net.ParseIP("100.64.0.99")

	lookup := func(nodeID string) (net.IP, []string, bool) {
		switch nodeID {
		case "node-alice":
			return aliceVIP, pe.GetPeerGroups(nodeID), true
		case "node-db":
			return dbVIP, pe.GetPeerGroups(nodeID), true
		case "node-attacker":
			return attackerVIP, pe.GetPeerGroups(nodeID), true
		default:
			return nil, nil, false
		}
	}

	// Strictly DIRECTIONAL rule: workstation -> db on TCP 3306 (MySQL)
	_ = pe.UpsertPolicy(&PolicyRule{
		ID:           "rule-mysql-access",
		Name:         "Alice to DB MySQL",
		Enabled:      true,
		SourceGroups: []string{"group:workstation"},
		DestGroups:   []string{"group:db"},
		Rules: []RuleItem{
			{
				Protocol:   ProtocolTCP,
				PortRanges: []PortRange{{Start: 3306, End: 3306}},
				Action:     ActionAccept,
			},
		},
		Bidirectional: false, // Strictly directional
	})

	alicePolicy, _ := pe.CompilePolicyForPeer("node-alice", lookup)
	dbPolicy, _ := pe.CompilePolicyForPeer("node-db", lookup)

	aliceFilter := NewNetstackFilter()
	aliceFilter.UpdatePolicy(alicePolicy)

	dbFilter := NewNetstackFilter()
	dbFilter.UpdatePolicy(dbPolicy)

	// --- Attack 1: Database node attempts outbound initiation to Alice on port 3306 ---
	if err := dbFilter.EvaluateOutbound(aliceVIP, ProtocolTCP, 3306); err == nil {
		t.Fatalf("ATTACK SUCCESS: DB node bypassed directional policy to initiate outbound connection to Alice!")
	}

	// --- Attack 2: Database node attempts unsolicited inbound connection to Alice on unlisted port 22 ---
	if err := aliceFilter.EvaluateInbound(dbVIP, 3306, 22, ProtocolTCP); err == nil {
		t.Fatalf("ATTACK SUCCESS: Alice accepted unsolicited inbound connection without conntrack!")
	}

	// --- Attack 3: Third-party attacker attempts inbound connection to DB on 3306 ---
	if err := dbFilter.EvaluateInbound(attackerVIP, 50000, 3306, ProtocolTCP); err == nil {
		t.Fatalf("ATTACK SUCCESS: DB accepted connection from unauthorized attacker node!")
	}

	// --- Legitimate Flow: Alice initiates outbound connection to DB:3306 from ephemeral port 54321 ---
	err := aliceFilter.EvaluateOutbound4Tuple(aliceVIP, 54321, dbVIP, 3306, ProtocolTCP)
	if err != nil {
		t.Fatalf("Legitimate outbound initiation failed: %v", err)
	}

	// DB evaluates inbound packet from Alice
	err = dbFilter.EvaluateInbound(aliceVIP, 54321, 3306, ProtocolTCP)
	if err != nil {
		t.Fatalf("Legitimate inbound packet at DB failed: %v", err)
	}

	// DB initiates return packet (or responds) -> Alice evaluates inbound return packet from dbVIP:3306 to aliceVIP:54321
	err = aliceFilter.EvaluateInbound(dbVIP, 3306, 54321, ProtocolTCP)
	if err != nil {
		t.Fatalf("Legitimate return packet failed stateful conntrack: %v", err)
	}

	// --- Attack 4: Attacker tries to inject packet to Alice's active ephemeral port 54321 ---
	if err := aliceFilter.EvaluateInbound(attackerVIP, 3306, 54321, ProtocolTCP); err == nil {
		t.Fatalf("ATTACK SUCCESS: Attacker injected packet into Alice's conntrack session using spoofed port!")
	}

	// --- Attack 5: DB tries to send UDP packet to Alice's active ephemeral port 54321 (Protocol mismatch) ---
	if err := aliceFilter.EvaluateInbound(dbVIP, 3306, 54321, ProtocolUDP); err == nil {
		t.Fatalf("ATTACK SUCCESS: Protocol mismatch bypassed conntrack stateful tracking!")
	}

	// --- Attack 6: DB tries to send packet from different port 3307 to 54321 (Source port mismatch) ---
	if err := aliceFilter.EvaluateInbound(dbVIP, 3307, 54321, ProtocolTCP); err == nil {
		t.Fatalf("ATTACK SUCCESS: Source port mismatch bypassed conntrack stateful tracking!")
	}
}

// TestAdversarialConntrackTTLAndStatefulAttacks validates conntrack lifecycle, expiration purge, and zero/negative TTL defense.
func TestAdversarialConntrackTTLAndStatefulAttacks(t *testing.T) {
	filter := NewNetstackFilter()
	filter.SetConntrackTTL(50 * time.Millisecond) // Fast TTL for testing

	clientVIP := net.ParseIP("100.64.0.1")
	serverVIP := net.ParseIP("100.64.0.2")

	policy := &CompiledPeerPolicy{
		NodeID:      "client-1",
		OverlayIPv4: clientVIP,
		OutboundRules: []CompiledFilterRule{
			{
				AllowedPeerVIP: serverVIP,
				Protocol:       ProtocolTCP,
				PortRanges:     []PortRange{{Start: 8080, End: 8080}},
				Action:         ActionAccept,
				IsDirectional:  true,
			},
		},
		InboundRules: []CompiledFilterRule{},
	}
	filter.UpdatePolicy(policy)

	// Initiate connection
	err := filter.EvaluateOutbound4Tuple(clientVIP, 40001, serverVIP, 8080, ProtocolTCP)
	if err != nil {
		t.Fatalf("Outbound failed: %v", err)
	}

	// Immediate return packet should pass
	err = filter.EvaluateInbound(serverVIP, 8080, 40001, ProtocolTCP)
	if err != nil {
		t.Fatalf("Inbound return packet failed immediately after outbound: %v", err)
	}

	// Wait for TTL to expire
	time.Sleep(75 * time.Millisecond)

	// Inbound packet after TTL expiration must be rejected
	err = filter.EvaluateInbound(serverVIP, 8080, 40001, ProtocolTCP)
	if err == nil {
		t.Fatalf("ATTACK SUCCESS: Inbound return packet accepted after conntrack TTL expired!")
	}

	// Conntrack count should drop to 0 after purge
	filter.PurgeExpiredConntrack()
	if count := filter.ConntrackCount(); count != 0 {
		t.Fatalf("Expected 0 conntrack entries after purge, got %d", count)
	}
}

// TestAdversarialSystemGroupProtectionAndSelfTargetExclusion tests invariants regarding system groups and self-target exclusion.
func TestAdversarialSystemGroupProtectionAndSelfTargetExclusion(t *testing.T) {
	pe := NewPolicyEngine()

	systemGroups := []string{
		"group:all",
		"group:exit-nodes",
		"group:admin",
		"group:residential",
		"group:mobile",
		"group:datacenter",
	}

	for _, sg := range systemGroups {
		err := pe.DeleteGroup(sg)
		if err == nil || !errors.Is(err, ErrSystemGroupLocked) {
			t.Fatalf("Expected ErrSystemGroupLocked when deleting system group %s, got: %v", sg, err)
		}
	}

	// Test self-target exclusion: Peer is in group:mesh. Policy allows group:mesh -> group:mesh
	_ = pe.UpsertGroup(&PeerGroup{ID: "group:mesh", Name: "Mesh", Peers: []string{"node-1", "node-2"}})

	lookup := func(nodeID string) (net.IP, []string, bool) {
		switch nodeID {
		case "node-1":
			return net.ParseIP("100.64.0.1"), pe.GetPeerGroups(nodeID), true
		case "node-2":
			return net.ParseIP("100.64.0.2"), pe.GetPeerGroups(nodeID), true
		default:
			return nil, nil, false
		}
	}

	_ = pe.UpsertPolicy(&PolicyRule{
		ID:           "mesh-full",
		Name:         "Mesh Interconnect",
		Enabled:      true,
		SourceGroups: []string{"group:mesh"},
		DestGroups:   []string{"group:mesh"},
		Rules: []RuleItem{
			{
				Protocol:   ProtocolALL,
				PortRanges: []PortRange{{Start: 1, End: 65535}},
				Action:     ActionAccept,
			},
		},
		Bidirectional: true,
	})

	node1Policy, err := pe.CompilePolicyForPeer("node-1", lookup)
	if err != nil {
		t.Fatalf("CompilePolicyForPeer(node-1) failed: %v", err)
	}

	// Check that node-1 does NOT have rules pointing to its own VIP
	for _, r := range node1Policy.OutboundRules {
		if r.AllowedPeerVIP.Equal(net.ParseIP("100.64.0.1")) {
			t.Fatalf("Self-target rule found in outbound rules for node-1!")
		}
	}
	for _, r := range node1Policy.InboundRules {
		if r.AllowedPeerVIP.Equal(net.ParseIP("100.64.0.1")) {
			t.Fatalf("Self-target rule found in inbound rules for node-1!")
		}
	}
}

// TestAdversarialNetstackFilterConcurrentStress tests high concurrency race conditions and thread safety.
func TestAdversarialNetstackFilterConcurrentStress(t *testing.T) {
	filter := NewNetstackFilter()
	filter.SetConntrackTTL(200 * time.Millisecond)

	clientVIP := net.ParseIP("100.64.0.1")
	targetVIP := net.ParseIP("100.64.0.100")

	policy := &CompiledPeerPolicy{
		NodeID:      "client-stress",
		OverlayIPv4: clientVIP,
		OutboundRules: []CompiledFilterRule{
			{
				AllowedPeerVIP: targetVIP,
				Protocol:       ProtocolTCP,
				PortRanges:     []PortRange{{Start: 1, End: 65535}},
				Action:         ActionAccept,
				IsDirectional:  true,
			},
		},
		InboundRules: []CompiledFilterRule{},
	}
	filter.UpdatePolicy(policy)

	var wg sync.WaitGroup
	workers := 50
	iterations := 100

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				srcPort := uint16(10000 + (workerID*iterations+i)%50000)
				dstPort := uint16(80 + i%1000)

				// Outbound
				_ = filter.EvaluateOutbound4Tuple(clientVIP, srcPort, targetVIP, dstPort, ProtocolTCP)

				// Inbound return
				_ = filter.EvaluateInbound(targetVIP, dstPort, srcPort, ProtocolTCP)

				// Intermittent purge
				if i%20 == 0 {
					filter.PurgeExpiredConntrack()
					_ = filter.ConntrackCount()
				}
			}
		}(w)
	}

	wg.Wait()
}
