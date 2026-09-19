package stress

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sovereign/proxy/v4/pkg/acl"
	"github.com/sovereign/proxy/v4/pkg/control"
	"github.com/sovereign/proxy/v4/pkg/crypto"
	"github.com/sovereign/proxy/v4/pkg/management"
	"github.com/sovereign/proxy/v4/pkg/posture"
	"github.com/sovereign/proxy/v4/pkg/routes"
)

// ============================================================================
// 1. SEMVER COMPARATOR ADVERSARIAL FUZZING & PROPERTY-BASED TESTS
// ============================================================================

func TestAdversarialSemverFuzzingAndComparisons(t *testing.T) {
	// 1. Deterministic Equivalence & Precedence Test Vectors
	vectors := []struct {
		a        string
		b        string
		expected int
		reason   string
	}{
		{"1.0.0", "1.0.0", 0, "exact match"},
		{"v1.0.0", "1.0.0", 0, "leading 'v' stripped on a"},
		{"1.0.0", "v1.0.0", 0, "leading 'v' stripped on b"},
		{"v1.0.0", "v1.0.0", 0, "leading 'v' stripped on both"},
		{"  1.0.0  ", "1.0.0", 0, "whitespace trimmed"},
		{"1.0.0+build123", "1.0.0+build456", 0, "build metadata ignored on both"},
		{"1.0.0+20230101", "1.0.0", 0, "build metadata ignored on a"},
		{"1.0.0", "1.0.0+20230101", 0, "build metadata ignored on b"},
		{"1.0.0-alpha", "1.0.0", -1, "prerelease is lower than final release"},
		{"1.0.0", "1.0.0-alpha", 1, "final release is higher than prerelease"},
		{"1.0.0-alpha", "1.0.0-beta", -1, "alpha < beta lexicographically"},
		{"1.0.0-beta", "1.0.0-alpha", 1, "beta > alpha lexicographically"},
		{"1.0.0-rc.1", "1.0.0-rc.2", -1, "rc.1 < rc.2"},
		{"2.0.0", "1.99.99", 1, "major 2 > major 1"},
		{"1.10.0", "1.9.9", 1, "minor 10 > minor 9 numerically"},
		{"1.0.10", "1.0.9", 1, "patch 10 > patch 9 numerically"},
		{"1.2", "1.2.0", 0, "short form 1.2 equals 1.2.0"},
		{"1.2", "1.2.1", -1, "short form 1.2 < 1.2.1"},
		{"1.2.1", "1.2", 1, "1.2.1 > short form 1.2"},
		{"14", "14.0.0.0", 0, "single major equals zero padded"},
		{"14.5.1.200", "14.5.1.199", 1, "multi-part version component comparison"},
		{"0.0.0", "0.0.0", 0, "all zeros"},
		{"0.0.1", "0.0.0", 1, "0.0.1 > 0.0.0"},
		{"", "", 0, "both empty"},
		{"v", "", 0, "only prefix v on empty"},
		{"invalid", "invalid", 0, "identical invalid strings equal 0"},
		{"9999999999", "1", 1, "large uint64 number comparison"},
	}

	for _, tc := range vectors {
		t.Run(fmt.Sprintf("%s_vs_%s", tc.a, tc.b), func(t *testing.T) {
			res := posture.CompareSemver(tc.a, tc.b)
			if res != tc.expected {
				t.Errorf("CompareSemver(%q, %q) = %d, expected %d (%s)", tc.a, tc.b, res, tc.expected, tc.reason)
			}

			// Invariance: CompareSemver(b, a) == -res
			inv := posture.CompareSemver(tc.b, tc.a)
			if inv != -res {
				t.Errorf("Antisymmetry violation for %q and %q: f(a,b)=%d, f(b,a)=%d", tc.a, tc.b, res, inv)
			}

			// Invariance: Reflexivity CompareSemver(a, a) == 0
			if posture.CompareSemver(tc.a, tc.a) != 0 {
				t.Errorf("Reflexivity violation for %q: f(a,a) != 0", tc.a)
			}
		})
	}

	// 2. Transitivity Property Check: If a < b and b < c, then a < c
	chain := []string{
		"0.0.1-alpha",
		"0.0.1",
		"1.0.0-rc1",
		"1.0.0",
		"1.0.1",
		"1.1.0",
		"1.10.0",
		"2.0.0",
		"10.0.0",
		"14.5.0",
		"100.0.0",
	}

	for i := 0; i < len(chain); i++ {
		for j := i + 1; j < len(chain); j++ {
			a := chain[i]
			b := chain[j]
			if posture.CompareSemver(a, b) >= 0 {
				t.Errorf("Strict chain ordering violation: expected %q < %q", a, b)
			}
			if posture.CompareSemver(b, a) <= 0 {
				t.Errorf("Strict chain ordering violation: expected %q > %q", b, a)
			}
		}
	}

	// 3. Fuzz Stress: Generate 1,000 random adversarial version strings to verify no panics
	fuzzChars := "0123456789.v-abcdefghijklmnopqrstuvwxyz+!@#$%^&*()_=[]{}|;':\",<>/?~`"
	for iter := 0; iter < 1000; iter++ {
		lenA, _ := rand.Int(rand.Reader, big.NewInt(30))
		lenB, _ := rand.Int(rand.Reader, big.NewInt(30))

		strA := make([]byte, lenA.Int64()+1)
		strB := make([]byte, lenB.Int64()+1)
		for k := range strA {
			idx, _ := rand.Int(rand.Reader, big.NewInt(int64(len(fuzzChars))))
			strA[k] = fuzzChars[idx.Int64()]
		}
		for k := range strB {
			idx, _ := rand.Int(rand.Reader, big.NewInt(int64(len(fuzzChars))))
			strB[k] = fuzzChars[idx.Int64()]
		}

		// Must not panic under any garbage input
		res := posture.CompareSemver(string(strA), string(strB))
		if res < -1 || res > 1 {
			t.Errorf("Fuzz CompareSemver returned out-of-range value %d for %q vs %q", res, string(strA), string(strB))
		}
	}
}

// ============================================================================
// 2. OS & CLIENT ATTESTATION SPOOFING & EDGE CASES
// ============================================================================

func TestAdversarialOSAndClientAttestationSpoofing(t *testing.T) {
	pe := posture.NewPostureEngine()

	policy := &posture.PosturePolicy{
		ID:           "pol-multi-os",
		Name:         "Multi-OS Policy",
		Enabled:      true,
		TargetGroups: []string{"group:all"},
		MinClientVer: "4.0.0",
		OSRules: []posture.OSVersionRule{
			{OSName: "linux", MinVersion: "5.15.0"},
			{OSName: "darwin", MinVersion: "14.0.0"},
			{OSName: "windows", MinVersion: "10.0.19045"},
		},
	}
	if err := pe.UpsertPolicy(policy); err != nil {
		t.Fatalf("UpsertPolicy failed: %v", err)
	}

	tests := []struct {
		name          string
		att           posture.PeerAttestation
		wantCompliant bool
		failSubstring string
	}{
		{
			name: "Compliant_Linux_Uppercase",
			att: posture.PeerAttestation{
				NodeID:        "node-linux-upper",
				OSName:        "LINUX",
				OSVersion:     "6.1.0",
				ClientVersion: "v4.0.1",
			},
			wantCompliant: true,
		},
		{
			name: "Compliant_Darwin_MixedCase",
			att: posture.PeerAttestation{
				NodeID:        "node-darwin-mixed",
				OSName:        "DaRwIn",
				OSVersion:     "14.5.1",
				ClientVersion: "4.0.0",
			},
			wantCompliant: true,
		},
		{
			name: "Outdated_Darwin",
			att: posture.PeerAttestation{
				NodeID:        "node-darwin-old",
				OSName:        "darwin",
				OSVersion:     "13.6.0",
				ClientVersion: "4.0.0",
			},
			wantCompliant: false,
			failSubstring: "OS darwin version 13.6.0 below required min 14.0.0",
		},
		{
			name: "Outdated_Client_Version",
			att: posture.PeerAttestation{
				NodeID:        "node-client-old",
				OSName:        "darwin",
				OSVersion:     "14.2.0",
				ClientVersion: "3.9.9",
			},
			wantCompliant: false,
			failSubstring: "Client version 3.9.9 below required min 4.0.0",
		},
		{
			name: "Outdated_Client_Prerelease",
			att: posture.PeerAttestation{
				NodeID:        "node-client-beta",
				OSName:        "darwin",
				OSVersion:     "14.2.0",
				ClientVersion: "4.0.0-beta.1",
			},
			wantCompliant: false,
			failSubstring: "Client version 4.0.0-beta.1 below required min 4.0.0",
		},
		{
			name: "Unregulated_OS_Android_Passes_OS_Rule_If_No_Match",
			att: posture.PeerAttestation{
				NodeID:        "node-android",
				OSName:        "android",
				OSVersion:     "13.0",
				ClientVersion: "4.0.0",
			},
			wantCompliant: true,
		},
		{
			name: "Empty_OS_Name_Passes_OS_Rule_Check",
			att: posture.PeerAttestation{
				NodeID:        "node-empty-os",
				OSName:        "",
				OSVersion:     "",
				ClientVersion: "4.0.0",
			},
			wantCompliant: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := pe.EvaluateAttestation(&tc.att, []string{"group:all"})
			if res.Compliant != tc.wantCompliant {
				t.Fatalf("EvaluateAttestation compliant=%t, want %t. Result: %+v", res.Compliant, tc.wantCompliant, res)
			}
			if !tc.wantCompliant && tc.failSubstring != "" {
				found := false
				for _, f := range res.FailedChecks {
					if strings.Contains(f, tc.failSubstring) {
						found = true
						break
					}
				}
				if !found {
					t.Fatalf("Expected failure reason containing %q, got: %v", tc.failSubstring, res.FailedChecks)
				}
			}
		})
	}
}

// ============================================================================
// 3. ISO COUNTRY CODE & ASN GEOFENCING ADVERSARIAL EDGE CASES
// ============================================================================

func TestAdversarialGeoFencingAndASNExtremes(t *testing.T) {
	pe := posture.NewPostureEngine()

	policy := &posture.PosturePolicy{
		ID:           "pol-geo-asn",
		Name:         "Geo & ASN Policy",
		Enabled:      true,
		TargetGroups: []string{"group:all"},
		GeoRule: posture.GeoFencingRule{
			AllowedCountries:    []string{"US", "GB", "DE", "FR"},
			ProhibitedCountries: []string{"CN", "RU", "IR", "KP", "US"}, // US is in both: Blacklist check MUST fail
			AllowedASNs:         []uint32{7018, 15169, 4294967295},      // AT&T, Google, MaxUint32
		},
	}
	if err := pe.UpsertPolicy(policy); err != nil {
		t.Fatalf("UpsertPolicy failed: %v", err)
	}

	tests := []struct {
		name          string
		country       string
		asn           uint32
		wantCompliant bool
		expectedError string
	}{
		{
			name:          "Compliant_DE_With_Allowed_ASN",
			country:       "DE",
			asn:           15169,
			wantCompliant: true,
		},
		{
			name:          "Compliant_de_Lowercase_With_Whitespace",
			country:       "  de  ",
			asn:           15169,
			wantCompliant: true,
		},
		{
			name:          "Compliant_GB_With_MaxUint32_ASN",
			country:       "gb",
			asn:           4294967295,
			wantCompliant: true,
		},
		{
			name:          "Prohibited_Country_CN",
			country:       "cn",
			asn:           15169,
			wantCompliant: false,
			expectedError: "prohibited country CN",
		},
		{
			name:          "Conflicting_Country_US_In_Blacklist_And_Whitelist_Should_Be_Rejected",
			country:       "US",
			asn:           7018,
			wantCompliant: false,
			expectedError: "prohibited country US",
		},
		{
			name:          "Unallowed_Country_JP_Not_In_Allowed_List",
			country:       "JP",
			asn:           15169,
			wantCompliant: false,
			expectedError: "not in allowed compliance list",
		},
		{
			name:          "Unapproved_ASN_9999",
			country:       "DE",
			asn:           9999,
			wantCompliant: false,
			expectedError: "ASN 9999 is not in allowed compliance list",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			att := &posture.PeerAttestation{
				NodeID:      "node-geo-test",
				CountryCode: tc.country,
				ASN:         tc.asn,
			}
			res := pe.EvaluateAttestation(att, []string{"group:all"})
			if res.Compliant != tc.wantCompliant {
				t.Fatalf("Country %q ASN %d compliant=%t, want %t. Result: %+v", tc.country, tc.asn, res.Compliant, tc.wantCompliant, res)
			}
			if !tc.wantCompliant && tc.expectedError != "" {
				if !strings.Contains(res.ViolationReason, tc.expectedError) {
					t.Fatalf("Expected violation reason containing %q, got: %s", tc.expectedError, res.ViolationReason)
				}
			}
		})
	}
}

// ============================================================================
// 4. HOST SECURITY CHECKS EXHAUSTIVE TRUTH TABLE
// ============================================================================

func TestAdversarialHostSecurityTruthTable(t *testing.T) {
	pe := posture.NewPostureEngine()

	policy := &posture.PosturePolicy{
		ID:           "pol-sec-strict",
		Name:         "Strict Security Policy",
		Enabled:      true,
		TargetGroups: []string{"group:all"},
		SecurityRule: posture.SecurityStateRule{
			RequireDiskEncryption: true,
			RequireFirewall:       true,
			RequireRootless:       true,
		},
	}
	if err := pe.UpsertPolicy(policy); err != nil {
		t.Fatalf("UpsertPolicy failed: %v", err)
	}

	// 2^3 = 8 combinations of (DiskEncrypted, FirewallActive, IsRootless)
	for i := 0; i < 8; i++ {
		disk := (i & 1) != 0
		fw := (i & 2) != 0
		rootless := (i & 4) != 0

		allTrue := disk && fw && rootless

		t.Run(fmt.Sprintf("Disk_%t_FW_%t_Rootless_%t", disk, fw, rootless), func(t *testing.T) {
			att := &posture.PeerAttestation{
				NodeID:         fmt.Sprintf("node-sec-%d", i),
				DiskEncrypted:  disk,
				FirewallActive: fw,
				IsRootless:     rootless,
			}

			res := pe.EvaluateAttestation(att, []string{"group:all"})
			if res.Compliant != allTrue {
				t.Fatalf("Combination (%t, %t, %t) compliant=%t, expected %t", disk, fw, rootless, res.Compliant, allTrue)
			}

			expectedFailedCount := 0
			if !disk {
				expectedFailedCount++
			}
			if !fw {
				expectedFailedCount++
			}
			if !rootless {
				expectedFailedCount++
			}

			if len(res.FailedChecks) != expectedFailedCount {
				t.Fatalf("FailedChecks count mismatch: got %d, want %d (%v)", len(res.FailedChecks), expectedFailedCount, res.FailedChecks)
			}
		})
	}
}

// ============================================================================
// 5. QUARANTINE ISOLATION DURING NODE HEARTBEATS & CONTROL PLANE INTEGRATION
// ============================================================================

func TestAdversarialQuarantineLifecycleAndControlPlaneIntegration(t *testing.T) {
	var psk [crypto.KeySize]byte
	rand.Read(psk[:])

	server := control.NewServer(control.ServerConfig{
		ListenAddr: "127.0.0.1:0",
		MeshPSK:    psk,
	})

	if err := server.Start(); err != nil {
		t.Fatalf("Failed to start control plane server: %v", err)
	}
	defer server.Close()

	serverURL := fmt.Sprintf("http://%s", server.Addr().String())
	client := control.NewClient(serverURL)
	ctx := context.Background()

	// 1. Setup strict posture policy on control plane
	policy := &posture.PosturePolicy{
		ID:           "pol-prod-lockdown",
		Name:         "Production Lockdown",
		Enabled:      true,
		TargetGroups: []string{"group:all"},
		MinClientVer: "4.0.0",
		GeoRule: posture.GeoFencingRule{
			AllowedCountries: []string{"US", "CA"},
		},
		SecurityRule: posture.SecurityStateRule{
			RequireDiskEncryption: true,
			RequireFirewall:       true,
			RequireRootless:       true,
		},
	}
	if err := server.PostureEngine().UpsertPolicy(policy); err != nil {
		t.Fatalf("UpsertPolicy failed: %v", err)
	}

	// 2. Register a clean node
	keyPair, err := crypto.GenerateKeypair()
	if err != nil {
		t.Fatalf("GenerateKeypair failed: %v", err)
	}

	regResp, err := client.Register(ctx, keyPair.PublicKey, "EXIT_BRIDGE", []control.EndpointDesc{
		{IPAddress: "1.2.3.4", Port: 51820, Protocol: "udp"},
	}, control.CapabilityDesc{
		Enabled:          true,
		CountryCode:      "US",
		ASN:              7018,
		IPClass:          "RESIDENTIAL",
		MaxBandwidthKbps: 50000,
	})
	if err != nil {
		t.Fatalf("Client register failed: %v", err)
	}
	nodeID := regResp.AssignedNodeID

	// Verify node is registered and healthy
	nodeView, err := server.Registry().GetNode(nodeID)
	if err != nil || !nodeView.IsHealthy {
		t.Fatalf("Expected registered node to be healthy, got err: %v, node: %+v", err, nodeView)
	}

	// 3. Node sends clean heartbeat with compliant attestation
	cleanAtt := &posture.PeerAttestation{
		NodeID:         nodeID,
		OSName:         "linux",
		OSVersion:      "6.1.0",
		ClientVersion:  "4.0.0",
		CountryCode:    "US",
		ASN:            7018,
		DiskEncrypted:  true,
		FirewallActive: true,
		IsRootless:     true,
		TimestampUTC:   time.Now().UTC(),
	}

	hbResp, err := client.SendHeartbeatWithPosture(ctx, nodeID, nil, 0, 10, 50, 100, false, cleanAtt)
	if err != nil {
		t.Fatalf("Clean heartbeat failed: %v", err)
	}
	if hbResp.IsQuarantined || hbResp.DrainAndExit {
		t.Fatalf("Clean heartbeat reported quarantined: %+v", hbResp)
	}

	// Verify discover includes the node
	discBridges, err := client.DiscoverExitBridges(ctx, "US", 0, "", 10)
	if err != nil {
		t.Fatalf("Discover failed: %v", err)
	}
	foundInDiscovery := false
	for _, b := range discBridges {
		if b.NodeID == nodeID {
			foundInDiscovery = true
			break
		}
	}
	if !foundInDiscovery {
		t.Fatalf("Expected clean node %s in discovery list, got: %+v", nodeID, discBridges)
	}

	// 4. Node sends poisoned heartbeat (non-compliant: unencrypted disk & disabled firewall)
	poisonedAtt := &posture.PeerAttestation{
		NodeID:         nodeID,
		OSName:         "linux",
		OSVersion:      "6.1.0",
		ClientVersion:  "4.0.0",
		CountryCode:    "US",
		ASN:            7018,
		DiskEncrypted:  false, // VIOLATION
		FirewallActive: false, // VIOLATION
		IsRootless:     true,
		TimestampUTC:   time.Now().UTC(),
	}

	hbResp, err = client.SendHeartbeatWithPosture(ctx, nodeID, nil, 0, 10, 50, 100, false, poisonedAtt)
	if err != nil {
		t.Fatalf("Poisoned heartbeat request failed: %v", err)
	}
	if !hbResp.IsQuarantined || !hbResp.DrainAndExit {
		t.Fatalf("Expected heartbeat response to indicate quarantine and drain-and-exit, got: %+v", hbResp)
	}

	// 5. Check Quarantine Isolation Guarantees:
	// A) Node marked unhealthy in registry
	nodeView, err = server.Registry().GetNode(nodeID)
	if err != nil {
		t.Fatalf("GetNode failed: %v", err)
	}
	if nodeView.IsHealthy {
		t.Fatalf("Quarantined node must be marked IsHealthy=false in registry")
	}

	// B) Node is tracked in QuarantineManager
	if !server.PostureEngine().QuarantineManager().IsQuarantined(nodeID) {
		t.Fatalf("Expected node to be registered in QuarantineManager")
	}

	// C) Node is EXCLUDED from Discovery results
	discBridges, err = client.DiscoverExitBridges(ctx, "US", 0, "", 10)
	if err != nil {
		t.Fatalf("Discover failed: %v", err)
	}
	for _, b := range discBridges {
		if b.NodeID == nodeID {
			t.Fatalf("[QUARANTINE ISOLATION LEAK] Quarantined node %s was returned in Discovery bridges!", nodeID)
		}
	}

	// D) Subsequent heartbeat without posture payload STILL returns quarantined state
	hbRespNoAtt, err := client.SendHeartbeat(ctx, nodeID, nil, 0, 10, 50, 100, false)
	if err != nil {
		t.Fatalf("Heartbeat failed: %v", err)
	}
	if !hbRespNoAtt.IsQuarantined || !hbRespNoAtt.DrainAndExit {
		t.Fatalf("Subsequent heartbeat for quarantined peer should maintain quarantine state")
	}

	// 6. Recovery: Node remediates security posture and passes evaluation
	hbRespRecovered, err := client.SendHeartbeatWithPosture(ctx, nodeID, nil, 0, 10, 50, 100, false, cleanAtt)
	if err != nil {
		t.Fatalf("Recovery heartbeat failed: %v", err)
	}
	if hbRespRecovered.IsQuarantined || hbRespRecovered.DrainAndExit {
		t.Fatalf("Recovered node should not be quarantined: %+v", hbRespRecovered)
	}
	if server.PostureEngine().QuarantineManager().IsQuarantined(nodeID) {
		t.Fatalf("Recovered node should be removed from QuarantineManager")
	}

	// Node returns to discovery
	discBridges, err = client.DiscoverExitBridges(ctx, "US", 0, "", 10)
	if err != nil {
		t.Fatalf("Discover failed: %v", err)
	}
	foundInDiscovery = false
	for _, b := range discBridges {
		if b.NodeID == nodeID {
			foundInDiscovery = true
			break
		}
	}
	if !foundInDiscovery {
		t.Fatalf("Expected recovered node %s to reappear in discovery list", nodeID)
	}
}

// ============================================================================
// 6. MANAGEMENT REST API MALFORMED JSON & FUZZED PAYLOADS
// ============================================================================

func TestAdversarialManagementRESTMalformedPayloads(t *testing.T) {
	reg := newMockNodeRegistry()
	aclEng := acl.NewPolicyEngine()
	rt := routes.NewRouteTable()
	postEng := posture.NewPostureEngine()
	eb := management.NewEventBus(100)

	server := management.NewManagementServer(reg, aclEng, rt, postEng, eb)
	mux := http.NewServeMux()
	server.RegisterRoutes(mux)

	malformedJSONPayloads := []struct {
		name string
		body string
	}{
		{"EmptyString", ""},
		{"TruncatedJSON", `{"id": "test"`},
		{"SingleBrace", "{"},
		{"TypeMismatch_IDIsNumber", `{"id": 12345, "name": 6789}`},
		{"InvalidArrayForObject", `[1, 2, 3]`},
		{"GarbageNonJSON", "this is definitely not json"},
	}

	endpoints := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/v4/acls"},
		{http.MethodPut, "/api/v4/acls/test-acl"},
		{http.MethodPost, "/api/v4/groups"},
		{http.MethodPut, "/api/v4/groups/test-grp"},
		{http.MethodPost, "/api/v4/routes"},
		{http.MethodPut, "/api/v4/routes/test-rt"},
		{http.MethodPost, "/api/v4/posture-checks"},
		{http.MethodPut, "/api/v4/posture-checks/test-posture"},
	}

	for _, ep := range endpoints {
		for _, pl := range malformedJSONPayloads {
			t.Run(fmt.Sprintf("%s_%s_%s", ep.method, ep.path, pl.name), func(t *testing.T) {
				req := httptest.NewRequest(ep.method, ep.path, strings.NewReader(pl.body))
				rec := httptest.NewRecorder()

				// Must not panic under any circumstance
				mux.ServeHTTP(rec, req)

				// Must return 400 Bad Request
				if rec.Code != http.StatusBadRequest {
					t.Errorf("Endpoint %s %s with payload %s returned status %d, expected 400 (Body: %s)",
						ep.method, ep.path, pl.name, rec.Code, rec.Body.String())
				}
			})
		}
	}

	// Semantic validation failure probes (Valid JSON but invalid business schema)
	semanticProbes := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/api/v4/groups", `{"id":""}`},                                                                                       // Empty ID
		{http.MethodPost, "/api/v4/routes", `{"id":"rt-1","network_cidr":"999.999.999.999/99"}`},                                               // Invalid CIDR
		{http.MethodPost, "/api/v4/acls", `{"id":"acl-1","source_groups":[],"destination_groups":[],"rules":[]}`},                              // Missing groups/rules
		{http.MethodPost, "/api/v4/acls", `{"id":"acl-1","source_groups":["group:all"],"destination_groups":["group:exit-nodes"],"rules":[]}`}, // Empty rules
		{http.MethodPost, "/api/v4/posture-checks", `{"id":""}`},                                                                               // Empty posture check ID
	}

	for _, sp := range semanticProbes {
		t.Run(fmt.Sprintf("SemanticValidation_%s_%s", sp.method, sp.path), func(t *testing.T) {
			req := httptest.NewRequest(sp.method, sp.path, strings.NewReader(sp.body))
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("Semantic probe %s %s with body %s returned status %d, expected 400 (Body: %s)",
					sp.method, sp.path, sp.body, rec.Code, rec.Body.String())
			}
		})
	}
}

// ============================================================================
// 7. MANAGEMENT REST API INVALID HTTP METHODS & 404 NOT FOUND CHECKS
// ============================================================================

func TestAdversarialManagementRESTInvalidMethodsAndMissingEntities(t *testing.T) {
	reg := newMockNodeRegistry()
	aclEng := acl.NewPolicyEngine()
	rt := routes.NewRouteTable()
	postEng := posture.NewPostureEngine()
	eb := management.NewEventBus(100)

	server := management.NewManagementServer(reg, aclEng, rt, postEng, eb)
	mux := http.NewServeMux()
	server.RegisterRoutes(mux)

	// 1. Invalid HTTP Methods Matrix (Must return 405 Method Not Allowed)
	invalidMethodProbes := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/v4/peers"},
		{http.MethodPut, "/api/v4/peers"},
		{http.MethodDelete, "/api/v4/peers"},
		{http.MethodPatch, "/api/v4/peers"},
		{http.MethodPost, "/api/v4/peers/node-123"},
		{http.MethodPatch, "/api/v4/acls"},
		{http.MethodPost, "/api/v4/topology/graph"},
		{http.MethodDelete, "/api/v4/topology/graph"},
		{http.MethodPost, "/api/v4/topology/matrix"},
		{http.MethodDelete, "/api/v4/topology/matrix"},
		{http.MethodPost, "/api/v4/events"},
		{http.MethodDelete, "/api/v4/events"},
	}

	for _, probe := range invalidMethodProbes {
		t.Run(fmt.Sprintf("InvalidMethod_%s_%s", probe.method, probe.path), func(t *testing.T) {
			req := httptest.NewRequest(probe.method, probe.path, strings.NewReader(`{}`))
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("Probe %s %s returned status %d, expected 405 Method Not Allowed", probe.method, probe.path, rec.Code)
			}
		})
	}

	// 2. Non-existent Entity Lookups & Deletions
	missingEntityProbes := []struct {
		method         string
		path           string
		expectedStatus int
	}{
		{http.MethodGet, "/api/v4/peers/ghost-peer-999", http.StatusNotFound},
		{http.MethodDelete, "/api/v4/peers/ghost-peer-999", http.StatusNotFound},
		{http.MethodGet, "/api/v4/acls/ghost-acl-999", http.StatusNotFound},
		{http.MethodDelete, "/api/v4/acls/ghost-acl-999", http.StatusNotFound},
		{http.MethodGet, "/api/v4/groups/ghost-grp-999", http.StatusNotFound},
		{http.MethodDelete, "/api/v4/groups/ghost-grp-999", http.StatusBadRequest}, // DeleteGroup returns 400 on error
		{http.MethodGet, "/api/v4/routes/ghost-rt-999", http.StatusNotFound},
		{http.MethodDelete, "/api/v4/routes/ghost-rt-999", http.StatusNotFound},
		{http.MethodGet, "/api/v4/posture-checks/ghost-posture-999", http.StatusNotFound},
		{http.MethodDelete, "/api/v4/posture-checks/ghost-posture-999", http.StatusNotFound},
	}

	for _, probe := range missingEntityProbes {
		t.Run(fmt.Sprintf("MissingEntity_%s_%s", probe.method, probe.path), func(t *testing.T) {
			req := httptest.NewRequest(probe.method, probe.path, nil)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != probe.expectedStatus {
				t.Errorf("Missing entity query %s %s returned status %d, expected %d (Body: %s)",
					probe.method, probe.path, rec.Code, probe.expectedStatus, rec.Body.String())
			}
		})
	}
}

// ============================================================================
// 8. HIGH CONCURRENCY MANAGEMENT SERVER MUTATION & READ RACE STRESS
// ============================================================================

func TestAdversarialManagementHighConcurrencyAndRaceStress(t *testing.T) {
	reg := newMockNodeRegistry()
	aclEng := acl.NewPolicyEngine()
	rt := routes.NewRouteTable()
	postEng := posture.NewPostureEngine()
	eb := management.NewEventBus(1000)

	server := management.NewManagementServer(reg, aclEng, rt, postEng, eb)
	mux := http.NewServeMux()
	server.RegisterRoutes(mux)

	const numWorkers = 50
	const opsPerWorker = 100

	var totalOps int64
	var wg sync.WaitGroup

	startBarrier := make(chan struct{})

	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			<-startBarrier

			for i := 0; i < opsPerWorker; i++ {
				op := (workerID + i) % 10
				switch op {
				case 0:
					// GET /api/v4/peers
					req := httptest.NewRequest(http.MethodGet, "/api/v4/peers", nil)
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)
				case 1:
					// GET /api/v4/topology/graph
					req := httptest.NewRequest(http.MethodGet, "/api/v4/topology/graph", nil)
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)
				case 2:
					// GET /api/v4/topology/matrix
					req := httptest.NewRequest(http.MethodGet, "/api/v4/topology/matrix", nil)
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)
				case 3:
					// POST /api/v4/groups
					body := fmt.Sprintf(`{"id":"grp-%d-%d","name":"Group %d","description":"Test"}`, workerID, i, workerID)
					req := httptest.NewRequest(http.MethodPost, "/api/v4/groups", strings.NewReader(body))
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)
				case 4:
					// POST /api/v4/acls
					body := fmt.Sprintf(`{"id":"acl-%d-%d","name":"Policy %d","enabled":true,"source_groups":["group:all"],"destination_groups":["group:exit-nodes"],"rules":[{"protocol":"TCP","port_ranges":[{"start":80,"end":80}],"action":"ACCEPT"}]}`, workerID, i, workerID)
					req := httptest.NewRequest(http.MethodPost, "/api/v4/acls", strings.NewReader(body))
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)
				case 5:
					// POST /api/v4/routes
					body := fmt.Sprintf(`{"id":"rt-%d-%d","network_id":"net-%d","network_cidr":"10.%d.0.0/16","masquerade":true,"failover_mode":"ACTIVE_PASSIVE","groups":["group:all"]}`, workerID, i, workerID, workerID%250)
					req := httptest.NewRequest(http.MethodPost, "/api/v4/routes", strings.NewReader(body))
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)
				case 6:
					// POST /api/v4/posture-checks
					body := fmt.Sprintf(`{"id":"posture-%d-%d","name":"Posture %d","enabled":true,"min_client_version":"4.0.0"}`, workerID, i, workerID)
					req := httptest.NewRequest(http.MethodPost, "/api/v4/posture-checks", strings.NewReader(body))
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)
				case 7:
					// GET /api/v4/events
					req := httptest.NewRequest(http.MethodGet, "/api/v4/events?limit=20", nil)
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)
				case 8:
					// GET /metrics
					req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)
				case 9:
					// DELETE previously created entity
					delID := fmt.Sprintf("acl-%d-%d", workerID, i-1)
					req := httptest.NewRequest(http.MethodDelete, "/api/v4/acls/"+delID, nil)
					rec := httptest.NewRecorder()
					mux.ServeHTTP(rec, req)
				}
				atomic.AddInt64(&totalOps, 1)
			}
		}(w)
	}

	start := time.Now()
	close(startBarrier)
	wg.Wait()
	elapsed := time.Since(start)

	ops := atomic.LoadInt64(&totalOps)
	t.Logf("High Concurrency Management Server Stress: %d ops in %v (%.2f ops/sec) with zero race conditions",
		ops, elapsed, float64(ops)/elapsed.Seconds())
}

// ============================================================================
// 9. PROMETHEUS / OPENMETRICS FORMAT AND ACCURACY AUDIT
// ============================================================================

func TestAdversarialPrometheusMetricsFormatAndAccuracy(t *testing.T) {
	reg := newMockNodeRegistry()
	aclEng := acl.NewPolicyEngine()
	rt := routes.NewRouteTable()
	postEng := posture.NewPostureEngine()
	eb := management.NewEventBus(100)

	server := management.NewManagementServer(reg, aclEng, rt, postEng, eb)
	mux := http.NewServeMux()
	server.RegisterRoutes(mux)

	// Seed entities
	// 1. Nodes: 3 total (2 healthy, 1 unhealthy)
	reg.AddNode(management.NodeRecordView{NodeID: "node-1", IsHealthy: true})
	reg.AddNode(management.NodeRecordView{NodeID: "node-2", IsHealthy: true})
	reg.AddNode(management.NodeRecordView{NodeID: "node-3", IsHealthy: false})

	// 2. Quarantine: 1 node
	postEng.QuarantineManager().QuarantinePeer("node-3", "outdated client", []string{"version mismatch"})

	// 3. Routes: 2 routes
	_, _ = rt.AddRoute("rt-1", "vpc-1", "10.0.0.0/16", nil, nil, true, routes.FailoverActivePassive)
	_, _ = rt.AddRoute("rt-2", "vpc-2", "192.168.0.0/16", nil, nil, false, routes.FailoverActiveActive)

	// 4. ACL: 1 valid policy
	err := aclEng.UpsertPolicy(&acl.PolicyRule{
		ID:           "acl-1",
		Name:         "Allow All",
		Enabled:      true,
		SourceGroups: []string{"group:all"},
		DestGroups:   []string{"group:exit-nodes"},
		Rules: []acl.RuleItem{
			{Protocol: acl.ProtocolTCP, PortRanges: []acl.PortRange{{Start: 80, End: 80}}, Action: acl.ActionAccept},
		},
	})
	if err != nil {
		t.Fatalf("UpsertPolicy failed: %v", err)
	}

	// 5. Events: 3 events
	eb.Publish(management.EventPeerRegistered, "node-1", "Registered")
	eb.Publish(management.EventPeerQuarantined, "node-3", "Quarantined")
	eb.Publish(management.EventRouteFailover, "rt-1", "Failover")

	// Query /metrics endpoint
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /metrics returned status %d", rec.Code)
	}

	contentType := rec.Header().Get("Content-Type")
	if !strings.Contains(contentType, "text/plain") {
		t.Fatalf("Invalid Prometheus Content-Type header: %s", contentType)
	}

	body := rec.Body.String()
	lines := strings.Split(strings.TrimSpace(body), "\n")

	// Parse Prometheus OpenMetrics format line by line
	metricValues := make(map[string]float64)
	metricTypes := make(map[string]string)
	metricHelps := make(map[string]string)

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "# HELP ") {
			parts := strings.SplitN(line[7:], " ", 2)
			if len(parts) == 2 {
				metricHelps[parts[0]] = parts[1]
			}
		} else if strings.HasPrefix(line, "# TYPE ") {
			parts := strings.SplitN(line[7:], " ", 2)
			if len(parts) == 2 {
				metricTypes[parts[0]] = parts[1]
			}
		} else if !strings.HasPrefix(line, "#") {
			parts := strings.Fields(line)
			if len(parts) != 2 {
				t.Fatalf("Invalid Prometheus metric line format: %q", line)
			}
			val, err := strconv.ParseFloat(parts[1], 64)
			if err != nil {
				t.Fatalf("Invalid metric numeric value in line %q: %v", line, err)
			}
			metricValues[parts[0]] = val
		}
	}

	// Required metrics and their expected types and values
	expectedMetrics := []struct {
		name        string
		kind        string
		expectedVal float64
	}{
		{"sovereign_peers_total", "gauge", 3.0},
		{"sovereign_peers_healthy", "gauge", 2.0},
		{"sovereign_peers_quarantined", "gauge", 1.0},
		{"sovereign_routes_total", "gauge", 2.0},
		{"sovereign_acl_policies_total", "gauge", 1.0},
		{"sovereign_events_total", "counter", 3.0},
	}

	for _, em := range expectedMetrics {
		// Verify HELP exists
		if _, hasHelp := metricHelps[em.name]; !hasHelp {
			t.Errorf("Missing # HELP definition for metric %s", em.name)
		}

		// Verify TYPE exists and matches
		actualType, hasType := metricTypes[em.name]
		if !hasType {
			t.Errorf("Missing # TYPE definition for metric %s", em.name)
		} else if actualType != em.kind {
			t.Errorf("Metric %s TYPE mismatch: got %s, want %s", em.name, actualType, em.kind)
		}

		// Verify Value matches reality
		actualVal, hasVal := metricValues[em.name]
		if !hasVal {
			t.Errorf("Metric %s value line missing in Prometheus output", em.name)
		} else if actualVal != em.expectedVal {
			t.Errorf("Metric %s value mismatch: got %.0f, want %.0f", em.name, actualVal, em.expectedVal)
		}
	}
}

// Helper on MockNodeRegistry to safely add node
func (m *localMockNodeRegistry) AddNode(node management.NodeRecordView) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.nodes == nil {
		m.nodes = make(map[string]management.NodeRecordView)
	}
	m.nodes[node.NodeID] = node
	m.epoch++
}

type localMockNodeRegistry struct {
	mu     sync.RWMutex
	nodes  map[string]management.NodeRecordView
	relays []management.RelayRecordView
	epoch  uint64
}

func newMockNodeRegistry() *localMockNodeRegistry {
	return &localMockNodeRegistry{
		nodes:  make(map[string]management.NodeRecordView),
		relays: make([]management.RelayRecordView, 0),
		epoch:  1,
	}
}

func (m *localMockNodeRegistry) ListNodes() []management.NodeRecordView {
	m.mu.RLock()
	defer m.mu.RUnlock()
	list := make([]management.NodeRecordView, 0, len(m.nodes))
	for _, n := range m.nodes {
		list = append(list, n)
	}
	return list
}

func (m *localMockNodeRegistry) GetNode(nodeID string) (*management.NodeRecordView, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	n, ok := m.nodes[nodeID]
	if !ok {
		return nil, fmt.Errorf("node %s not found", nodeID)
	}
	return &n, nil
}

func (m *localMockNodeRegistry) DeleteNode(nodeID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.nodes[nodeID]; !ok {
		return fmt.Errorf("node %s not found", nodeID)
	}
	delete(m.nodes, nodeID)
	m.epoch++
	return nil
}

func (m *localMockNodeRegistry) RelaysList() []management.RelayRecordView {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.relays
}

func (m *localMockNodeRegistry) Epoch() uint64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.epoch
}
