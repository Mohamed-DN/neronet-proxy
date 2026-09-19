package posture

import (
	"testing"
	"time"
)

func boolPtr(v bool) *bool { return &v }

func TestCompareSemver(t *testing.T) {
	tests := []struct {
		a        string
		b        string
		expected int
	}{
		{"1.0.0", "1.0.0", 0},
		{"v1.0.0", "1.0.0", 0},
		{"v4.0.0", "v4.0.0", 0},
		{"v3.9.9", "v4.0.0", -1},
		{"v4.0.1", "v4.0.0", 1},
		{"14.5.0", "14.0.0", 1},
		{"13.9.0", "14.0.0", -1},
		{"1.2", "1.2.0", 0},
		{"1.2", "1.2.1", -1},
		{"v4.0.0-beta", "v4.0.0", -1},
		{"v4.0.0", "v4.0.0-beta", 1},
	}

	for _, tc := range tests {
		res := CompareSemver(tc.a, tc.b)
		if res != tc.expected {
			t.Errorf("CompareSemver(%q, %q) = %d, expected %d", tc.a, tc.b, res, tc.expected)
		}
	}
}

func TestPostureEngineComplianceAndQuarantine(t *testing.T) {
	pe := NewPostureEngine()

	policy := &PosturePolicy{
		ID:           "sec-baseline-v4",
		Name:         "Enterprise Baseline Compliance",
		Enabled:      true,
		TargetGroups: []string{"group:all"},
		MinClientVer: "4.0.0",
		OSRules: []OSVersionRule{
			{OSName: "darwin", MinVersion: "14.0.0"},
			{OSName: "linux", MinVersion: "5.15.0"},
			{OSName: "windows", MinVersion: "10.0.19045"},
		},
		GeoRule: GeoFencingRule{
			AllowedCountries:    []string{"US", "CA", "GB", "DE", "FR", "JP"},
			ProhibitedCountries: []string{"CN", "RU", "IR", "KP"},
			AllowedASNs:         []uint32{7018, 15169, 16509}, // AT&T, Google, AWS
		},
		SecurityRule: SecurityStateRule{
			RequireDiskEncryption: true,
			RequireFirewall:       true,
			RequireRootless:       true,
		},
	}

	err := pe.UpsertPolicy(policy)
	if err != nil {
		t.Fatalf("UpsertPolicy failed: %v", err)
	}

	// 1. Fully compliant node
	attCompliant := &PeerAttestation{
		NodeID:         "node-mac-1",
		OSName:         "darwin",
		OSVersion:      "14.5.0",
		ClientVersion:  "v4.0.2",
		CountryCode:    "US",
		ASN:            7018,
		DiskEncrypted:  boolPtr(true),
		FirewallActive: boolPtr(true),
		IsRootless:     true,
		TimestampUTC:   time.Now().UTC(),
	}

	res := pe.EvaluateAttestation(attCompliant, []string{"group:all"})
	if !res.Compliant || res.Quarantine {
		t.Fatalf("Expected node-mac-1 to be compliant, got: %+v", res)
	}
	if pe.QuarantineManager().IsQuarantined("node-mac-1") {
		t.Fatalf("Compliant node should not be in quarantine manager")
	}

	// 2. Client Version Violation (v3.9.5 < 4.0.0)
	attOldClient := &PeerAttestation{
		NodeID:         "node-old-client",
		OSName:         "darwin",
		OSVersion:      "14.5.0",
		ClientVersion:  "v3.9.5",
		CountryCode:    "US",
		ASN:            7018,
		DiskEncrypted:  boolPtr(true),
		FirewallActive: boolPtr(true),
		IsRootless:     true,
	}
	res = pe.EvaluateAttestation(attOldClient, []string{"group:all"})
	if res.Compliant || !res.Quarantine {
		t.Fatalf("Expected outdated client version to fail and trigger quarantine")
	}
	if !pe.QuarantineManager().IsQuarantined("node-old-client") {
		t.Fatalf("Expected node-old-client to be registered in quarantine manager")
	}

	// 3. OS Version Violation (Linux 5.10.0 < 5.15.0)
	attOldOS := &PeerAttestation{
		NodeID:         "node-old-kernel",
		OSName:         "linux",
		OSVersion:      "5.10.0",
		ClientVersion:  "v4.0.0",
		CountryCode:    "US",
		ASN:            7018,
		DiskEncrypted:  boolPtr(true),
		FirewallActive: boolPtr(true),
		IsRootless:     true,
	}
	res = pe.EvaluateAttestation(attOldOS, []string{"group:all"})
	if res.Compliant || !res.Quarantine {
		t.Fatalf("Expected outdated kernel OS version to fail")
	}

	// 4. Geo-Fencing Prohibited Country (CN)
	attProhibitedCountry := &PeerAttestation{
		NodeID:         "node-roaming-cn",
		OSName:         "darwin",
		OSVersion:      "14.5.0",
		ClientVersion:  "v4.0.0",
		CountryCode:    "CN",
		ASN:            7018,
		DiskEncrypted:  boolPtr(true),
		FirewallActive: boolPtr(true),
		IsRootless:     true,
	}
	res = pe.EvaluateAttestation(attProhibitedCountry, []string{"group:all"})
	if res.Compliant || !res.Quarantine {
		t.Fatalf("Expected prohibited country CN to trigger quarantine")
	}

	// 5. Geo-Fencing Unallowed Country (BR is not in AllowedCountries list)
	attUnapprovedCountry := &PeerAttestation{
		NodeID:         "node-roaming-br",
		OSName:         "darwin",
		OSVersion:      "14.5.0",
		ClientVersion:  "v4.0.0",
		CountryCode:    "BR",
		ASN:            7018,
		DiskEncrypted:  boolPtr(true),
		FirewallActive: boolPtr(true),
		IsRootless:     true,
	}
	res = pe.EvaluateAttestation(attUnapprovedCountry, []string{"group:all"})
	if res.Compliant || !res.Quarantine {
		t.Fatalf("Expected unallowed country BR to trigger quarantine")
	}

	// 6. Security Violations: Unencrypted disk, disabled firewall, running as root
	attInsecureHost := &PeerAttestation{
		NodeID:         "node-insecure-host",
		OSName:         "linux",
		OSVersion:      "6.1.0",
		ClientVersion:  "v4.0.0",
		CountryCode:    "DE",
		ASN:            15169,
		DiskEncrypted:  boolPtr(false), // Violation 1
		FirewallActive: boolPtr(false), // Violation 2
		IsRootless:     false,          // Violation 3
	}
	res = pe.EvaluateAttestation(attInsecureHost, []string{"group:all"})
	if res.Compliant || !res.Quarantine {
		t.Fatalf("Expected insecure host to trigger quarantine")
	}
	if len(res.FailedChecks) < 3 {
		t.Fatalf("Expected at least 3 failed checks for insecure host, got: %v", res.FailedChecks)
	}

	// 7. Test Recovery / Unquarantine: Update node-roaming-cn to return to US
	attRoamedBack := &PeerAttestation{
		NodeID:         "node-roaming-cn",
		OSName:         "darwin",
		OSVersion:      "14.5.0",
		ClientVersion:  "v4.0.0",
		CountryCode:    "US",
		ASN:            7018,
		DiskEncrypted:  boolPtr(true),
		FirewallActive: boolPtr(true),
		IsRootless:     true,
	}
	res = pe.EvaluateAttestation(attRoamedBack, []string{"group:all"})
	if !res.Compliant || res.Quarantine {
		t.Fatalf("Expected roamed back node to pass compliance")
	}
	if pe.QuarantineManager().IsQuarantined("node-roaming-cn") {
		t.Fatalf("Expected node-roaming-cn to be unquarantined after passing posture check")
	}
}

// TestGeoFencingDefaultAllowAndCensoredCountries ensures Geo-Fencing is strictly configurable with
// default ALLOW for all countries, ensuring heavily censored countries (RU, EG, CN, IN) are NOT
// hardcoded as blocked, allowing users to bypass censorship while traveling.
func TestGeoFencingDefaultAllowAndCensoredCountries(t *testing.T) {
	pe := NewPostureEngine()

	// Policy without explicit Geo-Fencing restrictions (default configuration)
	defaultPolicy := &PosturePolicy{
		ID:           "default-open-policy",
		Name:         "Default Allow Geo Policy",
		Enabled:      true,
		TargetGroups: []string{"group:all"},
		MinClientVer: "4.0.0",
		GeoRule: GeoFencingRule{
			AllowedCountries:    []string{}, // Empty = allow all countries
			ProhibitedCountries: []string{}, // Empty = no prohibited countries
			AllowedASNs:         []uint32{}, // Empty = no ASN restrictions
		},
	}

	err := pe.UpsertPolicy(defaultPolicy)
	if err != nil {
		t.Fatalf("UpsertPolicy failed: %v", err)
	}

	// Test heavily censored countries and roaming locations: RU, EG, CN, IN, IR, TR, SA
	censoredCountries := []string{"RU", "EG", "CN", "IN", "IR", "TR", "SA", "VN", "MM", "CU"}

	for _, country := range censoredCountries {
		t.Run("DefaultAllow_"+country, func(t *testing.T) {
			att := &PeerAttestation{
				NodeID:        "traveler-" + country,
				OSName:        "linux",
				OSVersion:     "6.1.0",
				ClientVersion: "v4.0.0",
				CountryCode:   country,
				ASN:           12345,
				TimestampUTC:  time.Now().UTC(),
			}

			res := pe.EvaluateAttestation(att, []string{"group:all"})
			if !res.Compliant || res.Quarantine {
				t.Fatalf("Country %s should be ALLOWED by default, but got failure: %+v", country, res)
			}
			if pe.QuarantineManager().IsQuarantined("traveler-" + country) {
				t.Fatalf("Node in %s should not be quarantined under default policy", country)
			}
		})
	}

	// Verify that Geo-Fencing restriction only occurs when explicitly configured
	customStrictPolicy := &PosturePolicy{
		ID:           "strict-policy",
		Name:         "Strictly Configured Policy",
		Enabled:      true,
		TargetGroups: []string{"group:strict"},
		GeoRule: GeoFencingRule{
			AllowedCountries:    []string{"US", "GB"},
			ProhibitedCountries: []string{"KP"},
		},
	}

	err = pe.UpsertPolicy(customStrictPolicy)
	if err != nil {
		t.Fatalf("UpsertPolicy for strict policy failed: %v", err)
	}

	// Test that group:strict restricts EG, but group:all remains ALLOWED
	attEGStrict := &PeerAttestation{
		NodeID:        "strict-eg",
		OSName:        "linux",
		OSVersion:     "6.1.0",
		ClientVersion: "v4.0.0",
		CountryCode:   "EG",
	}
	resStrict := pe.EvaluateAttestation(attEGStrict, []string{"group:strict"})
	if resStrict.Compliant {
		t.Fatalf("Expected country EG to be rejected under explicit strict whitelist")
	}

	attEGDefault := &PeerAttestation{
		NodeID:        "default-eg",
		OSName:        "linux",
		OSVersion:     "6.1.0",
		ClientVersion: "v4.0.0",
		CountryCode:   "EG",
	}
	resDefault := pe.EvaluateAttestation(attEGDefault, []string{"group:default"})
	if !resDefault.Compliant {
		t.Fatalf("Expected country EG to pass under default group")
	}
}

// TestUnknownChecksAreUnverifiedNotCompliant covers the third outcome.
//
// The engine had two: pass or quarantine. A node that reported nothing about disk
// encryption took the pass branch, so "compliant" meant "nothing was found wrong",
// which on a fleet that measures nothing is every node.
func TestUnknownChecksAreUnverifiedNotCompliant(t *testing.T) {
	pe := NewPostureEngine()

	err := pe.UpsertPolicy(&PosturePolicy{
		ID:           "sec-baseline",
		Name:         "Host hardening baseline",
		Enabled:      true,
		TargetGroups: []string{"group:all"},
		SecurityRule: SecurityStateRule{
			RequireDiskEncryption: true,
			RequireFirewall:       true,
		},
	})
	if err != nil {
		t.Fatalf("UpsertPolicy failed: %v", err)
	}

	// What a node built from this branch actually sends: both security booleans
	// absent from the measurement.
	unmeasured := &PeerAttestation{
		NodeID:        "node-unmeasured",
		OSName:        "linux",
		OSVersion:     "12",
		ClientVersion: "v4.0.0",
		CountryCode:   "IT",
		IsRootless:    true,
		TimestampUTC:  time.Now().UTC(),
	}

	res := pe.EvaluateAttestation(unmeasured, []string{"group:all"})

	if res.Status != StatusUnverified {
		t.Fatalf("status = %q, want %q", res.Status, StatusUnverified)
	}
	if res.Compliant {
		t.Fatalf("an attestation that measured neither required check was reported compliant: %+v", res)
	}
	if res.Quarantine {
		t.Fatalf("an unverified node was quarantined; not measuring is not a violation: %+v", res)
	}
	if len(res.UnknownChecks) != 2 {
		t.Fatalf("expected both required checks to be listed as unknown, got %v", res.UnknownChecks)
	}
	if len(res.FailedChecks) != 0 {
		t.Fatalf("nothing failed, but the result lists failures: %v", res.FailedChecks)
	}

	// One known failure outranks the unknowns: a measured false is a violation.
	partial := &PeerAttestation{
		NodeID:        "node-partial",
		OSName:        "linux",
		OSVersion:     "12",
		ClientVersion: "v4.0.0",
		DiskEncrypted: boolPtr(false),
		IsRootless:    true,
	}

	res = pe.EvaluateAttestation(partial, []string{"group:all"})
	if res.Status != StatusNonCompliant {
		t.Fatalf("status = %q, want %q for a measured failing check", res.Status, StatusNonCompliant)
	}
	if !res.Quarantine {
		t.Fatalf("a measured violation did not quarantine: %+v", res)
	}

	// Everything measured and passing is the only route to compliance.
	measured := &PeerAttestation{
		NodeID:         "node-measured",
		OSName:         "linux",
		OSVersion:      "12",
		ClientVersion:  "v4.0.0",
		DiskEncrypted:  boolPtr(true),
		FirewallActive: boolPtr(true),
		IsRootless:     true,
	}

	res = pe.EvaluateAttestation(measured, []string{"group:all"})
	if res.Status != StatusVerifiedCompliant || !res.Compliant {
		t.Fatalf("status = %q compliant = %t, want %q / true", res.Status, res.Compliant, StatusVerifiedCompliant)
	}
}

// TestUnverifiedDoesNotLiftAnExistingQuarantine: a node that stops reporting a check
// it previously failed must not be released by its own silence.
func TestUnverifiedDoesNotLiftAnExistingQuarantine(t *testing.T) {
	pe := NewPostureEngine()

	err := pe.UpsertPolicy(&PosturePolicy{
		ID:           "sec-baseline",
		Enabled:      true,
		TargetGroups: []string{"group:all"},
		SecurityRule: SecurityStateRule{RequireDiskEncryption: true},
	})
	if err != nil {
		t.Fatalf("UpsertPolicy failed: %v", err)
	}

	failing := &PeerAttestation{NodeID: "node-quiet", DiskEncrypted: boolPtr(false)}
	if res := pe.EvaluateAttestation(failing, nil); !res.Quarantine {
		t.Fatalf("expected the measured violation to quarantine, got %+v", res)
	}

	silent := &PeerAttestation{NodeID: "node-quiet"}
	res := pe.EvaluateAttestation(silent, nil)
	if res.Status != StatusUnverified {
		t.Fatalf("status = %q, want %q", res.Status, StatusUnverified)
	}
	if !pe.QuarantineManager().IsQuarantined("node-quiet") {
		t.Fatalf("the quarantine was lifted by a node that simply stopped reporting the check")
	}
}

// TestNilAttestationIsUnverified: no attestation is the strongest unknown, and it
// must not panic the caller either.
func TestNilAttestationIsUnverified(t *testing.T) {
	pe := NewPostureEngine()

	res := pe.EvaluateAttestation(nil, []string{"group:all"})
	if res.Status != StatusUnverified || res.Compliant {
		t.Fatalf("EvaluateAttestation(nil) = %+v, want an unverified, non-compliant result", res)
	}
}
