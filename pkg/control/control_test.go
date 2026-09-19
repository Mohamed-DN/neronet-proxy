package control

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/posture"
	"github.com/sovereign/proxy/v4/pkg/routes"
)

// attBool exists because PeerAttestation distinguishes a measured false from a value
// the node never looked at.
func attBool(v bool) *bool { return &v }

func TestVIPAllocator(t *testing.T) {
	alloc := NewVIPAllocator()

	v4_1, v6_1, err := alloc.Allocate("node-1")
	if err != nil {
		t.Fatalf("Allocate node-1 failed: %v", err)
	}

	if !strings.HasPrefix(v4_1, "100.64.") {
		t.Fatalf("Expected 100.64.x.x overlay IP, got %s", v4_1)
	}
	if !strings.HasPrefix(v6_1, "fd7a:115c:a1e0") {
		t.Fatalf("Expected fd7a:115c:a1e0::x overlay IPv6, got %s", v6_1)
	}

	// Idempotent allocation
	v4_1_again, _, _ := alloc.Allocate("node-1")
	if v4_1_again != v4_1 {
		t.Fatalf("Re-allocating same node should return same IP: %s != %s", v4_1_again, v4_1)
	}

	// Different node gets distinct IP
	v4_2, _, _ := alloc.Allocate("node-2")
	if v4_2 == v4_1 {
		t.Fatalf("Distinct nodes should receive distinct IPs")
	}

	// Release node-1
	alloc.Release("node-1")
}

func TestControlPlaneServerAndClientWithNetBirdFeatures(t *testing.T) {
	server := NewServer(ServerConfig{
		ListenAddr: "127.0.0.1:0",
	})

	var relayPub [crypto.KeySize]byte
	rand.Read(relayPub[:])
	server.AddRelay(&RelayDesc{
		RelayID:       "relay-us-east",
		Hostname:      "relay-us-east.sovereign.net",
		Region:        "us-east",
		TCPPort:       443,
		UDPPort:       3478,
		PublicKey:     relayPub,
		SupportsHTTP3: true,
	})

	// Add Baseline Posture Policy
	_ = server.PostureEngine().UpsertPolicy(&posture.PosturePolicy{
		ID:           "policy-baseline",
		Name:         "Baseline Security",
		Enabled:      true,
		TargetGroups: []string{"group:all"},
		MinClientVer: "4.0.0",
		GeoRule: posture.GeoFencingRule{
			AllowedCountries:    []string{"US", "DE", "GB"},
			ProhibitedCountries: []string{"CN", "RU"},
		},
		SecurityRule: posture.SecurityStateRule{
			RequireDiskEncryption: true,
			RequireFirewall:       true,
			RequireRootless:       true,
		},
	})

	// Add Subnet Route
	_, _ = server.RouteTable().AddRoute("rt-corp", "corp-net", "10.100.0.0/24", []*routes.RoutingPeerSpec{
		{NodeID: "gw-1", Priority: 1, IsHealthy: true},
	}, []string{"group:all"}, true, routes.FailoverActivePassive)

	// Add ACL Policy
	_ = server.PolicyEngine().UpsertPolicy(&acl.PolicyRule{
		ID:           "acl-exit-egress",
		Name:         "Allow All to Exit Nodes",
		Enabled:      true,
		SourceGroups: []string{"group:all"},
		DestGroups:   []string{"group:exit-nodes"},
		Rules: []acl.RuleItem{
			{Protocol: acl.ProtocolTCP, PortRanges: []acl.PortRange{{Start: 80, End: 443}}, Action: acl.ActionAccept},
		},
		Bidirectional: true,
	})

	if err := server.Start(); err != nil {
		t.Fatalf("Server Start failed: %v", err)
	}
	defer server.Close()

	serverURL := fmt.Sprintf("http://%s", server.Addr().String())
	client := NewClient(serverURL)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 1. Register Relay Node
	relayKP, _ := crypto.GenerateKeypair()
	_, err := client.Register(ctx, relayKP.PublicKey, "RELAY", []EndpointDesc{
		{IPAddress: "198.51.100.10", Port: 443, Protocol: "tcp"},
	}, CapabilityDesc{})
	if err != nil {
		t.Fatalf("Register Relay failed: %v", err)
	}

	// 2. Register Compliant Exit Bridge in US
	exitKP, _ := crypto.GenerateKeypair()
	regResp, err := client.Register(ctx, exitKP.PublicKey, "EXIT_BRIDGE", []EndpointDesc{
		{IPAddress: "203.0.113.50", Port: 51820, Protocol: "udp"},
	}, CapabilityDesc{
		Enabled:          true,
		CountryCode:      "US",
		City:             "New York",
		ASN:              7018,
		IPClass:          "RESIDENTIAL",
		MaxBandwidthKbps: 50000,
	})
	if err != nil {
		t.Fatalf("Register Exit Bridge failed: %v", err)
	}

	if !strings.HasPrefix(regResp.OverlayIPv4, "100.64.") {
		t.Fatalf("Invalid Overlay IPv4: %s", regResp.OverlayIPv4)
	}
	if len(regResp.Relays) == 0 {
		t.Fatalf("Expected relays list in registration response")
	}

	// Verify automatic group assignment: group:all, group:exit-nodes, group:residential
	exitGroups := server.PolicyEngine().GetPeerGroups(regResp.AssignedNodeID)
	if len(exitGroups) < 3 {
		t.Fatalf("Expected peer to have at least 3 groups assigned, got: %v", exitGroups)
	}

	// 3. Register Intermediate Node in DE
	interKP, _ := crypto.GenerateKeypair()
	interResp, err := client.Register(ctx, interKP.PublicKey, "HYBRID", []EndpointDesc{
		{IPAddress: "198.51.100.20", Port: 51820, Protocol: "udp"},
	}, CapabilityDesc{
		Enabled:          true,
		CountryCode:      "DE",
		MaxBandwidthKbps: 100000,
	})
	if err != nil {
		t.Fatalf("Register Intermediate failed: %v", err)
	}

	// 4. Register Guard Node in GB
	guardKP, _ := crypto.GenerateKeypair()
	guardResp, err := client.Register(ctx, guardKP.PublicKey, "HYBRID", []EndpointDesc{
		{IPAddress: "198.51.100.30", Port: 51820, Protocol: "udp"},
	}, CapabilityDesc{
		Enabled:          true,
		CountryCode:      "GB",
		MaxBandwidthKbps: 100000,
	})
	if err != nil {
		t.Fatalf("Register Guard failed: %v", err)
	}

	// 5. Send Heartbeat with Compliant Posture Telemetry for all nodes
	hbResp, err := client.SendHeartbeatWithPosture(ctx, regResp.AssignedNodeID, nil, 2, 10, 64, 85, true, &posture.PeerAttestation{
		NodeID:         regResp.AssignedNodeID,
		OSName:         "linux",
		OSVersion:      "6.1.0",
		ClientVersion:  "v4.0.0",
		CountryCode:    "US",
		ASN:            7018,
		DiskEncrypted:  attBool(true),
		FirewallActive: attBool(true),
		IsRootless:     true,
	})
	if err != nil {
		t.Fatalf("SendHeartbeatWithPosture failed: %v", err)
	}
	if !hbResp.Acknowledged || hbResp.IsQuarantined {
		t.Fatalf("Expected acknowledged and non-quarantined heartbeat response, got: %+v", hbResp)
	}

	_, _ = client.SendHeartbeatWithPosture(ctx, interResp.AssignedNodeID, nil, 1, 5, 32, 90, false, &posture.PeerAttestation{
		NodeID:         interResp.AssignedNodeID,
		OSName:         "linux",
		OSVersion:      "6.1.0",
		ClientVersion:  "v4.0.0",
		CountryCode:    "DE",
		DiskEncrypted:  attBool(true),
		FirewallActive: attBool(true),
		IsRootless:     true,
	})

	_, _ = client.SendHeartbeatWithPosture(ctx, guardResp.AssignedNodeID, nil, 1, 5, 32, 90, false, &posture.PeerAttestation{
		NodeID:         guardResp.AssignedNodeID,
		OSName:         "linux",
		OSVersion:      "6.1.0",
		ClientVersion:  "v4.0.0",
		CountryCode:    "GB",
		DiskEncrypted:  attBool(true),
		FirewallActive: attBool(true),
		IsRootless:     true,
	})

	// 6. Discover Exit Bridges in US -> Should find exit bridge
	bridges, err := client.DiscoverExitBridges(ctx, "US", 0, "", 10)
	if err != nil {
		t.Fatalf("DiscoverExitBridges failed: %v", err)
	}
	if len(bridges) == 0 {
		t.Fatalf("Expected to find US exit bridge")
	}

	// 7. Test Continuous Posture Violation: Send Heartbeat with non-compliant telemetry (prohibited country CN)
	hbRespBad, err := client.SendHeartbeatWithPosture(ctx, regResp.AssignedNodeID, nil, 2, 10, 64, 85, true, &posture.PeerAttestation{
		NodeID:         regResp.AssignedNodeID,
		OSName:         "linux",
		OSVersion:      "6.1.0",
		ClientVersion:  "v4.0.0",
		CountryCode:    "CN", // Violation!
		DiskEncrypted:  attBool(true),
		FirewallActive: attBool(true),
		IsRootless:     true,
	})
	if err != nil {
		t.Fatalf("Heartbeat failed: %v", err)
	}
	if !hbRespBad.IsQuarantined || !hbRespBad.DrainAndExit {
		t.Fatalf("Expected node to be quarantined on prohibited country, got: %+v", hbRespBad)
	}

	// 8. Verify Quarantined node is now EXCLUDED from discovery!
	bridgesAfterQuarantine, err := client.DiscoverExitBridges(ctx, "US", 0, "", 10)
	if err != nil {
		t.Fatalf("DiscoverExitBridges failed: %v", err)
	}
	if len(bridgesAfterQuarantine) != 0 {
		t.Fatalf("Quarantined exit bridge should NOT appear in discovery!")
	}

	// 9. Unquarantine US node by sending compliant attestation
	hbRespRecovered, err := client.SendHeartbeatWithPosture(ctx, regResp.AssignedNodeID, nil, 2, 10, 64, 85, true, &posture.PeerAttestation{
		NodeID:         regResp.AssignedNodeID,
		OSName:         "linux",
		OSVersion:      "6.1.0",
		ClientVersion:  "v4.0.0",
		CountryCode:    "US", // Back in US!
		ASN:            7018,
		DiskEncrypted:  attBool(true),
		FirewallActive: attBool(true),
		IsRootless:     true,
	})
	if err != nil || hbRespRecovered.IsQuarantined {
		t.Fatalf("Expected unquarantine recovery, got: %+v", hbRespRecovered)
	}

	// 10. Test ACL Sync RPC
	compiledPolicy, _, err := client.SyncACLs(ctx, interResp.AssignedNodeID, 0)
	if err != nil {
		t.Fatalf("SyncACLs failed: %v", err)
	}
	if compiledPolicy == nil || len(compiledPolicy.OutboundRules) == 0 {
		t.Fatalf("Expected compiled outbound rules for node in group:all toward exit-nodes")
	}

	// 11. Test Route Sync RPC
	syncedRoutes, _, err := client.SyncRoutes(ctx, interResp.AssignedNodeID, 0)
	if err != nil {
		t.Fatalf("SyncRoutes failed: %v", err)
	}
	if len(syncedRoutes) == 0 {
		t.Fatalf("Expected synced routes for node in group:all")
	}

	// 12. Request 3-Hop Onion Circuit for DE
	circuitResp, err := client.RequestCircuitPath(ctx, "DE")
	if err != nil {
		t.Fatalf("RequestCircuitPath failed: %v", err)
	}
	if len(circuitResp.Hops) != 3 {
		t.Fatalf("Expected 3 hops in circuit, got %d", len(circuitResp.Hops))
	}
}
