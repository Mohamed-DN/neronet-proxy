package posture

import "testing"

// ADR 0042: nothing measures a country. A node that states none has an unknown location,
// and a rule that names countries must not pass on unknown.

func geoPolicy(allowed, prohibited []string) *PosturePolicy {
	return &PosturePolicy{
		ID: "geo", Name: "geo", Enabled: true, TargetGroups: []string{"group:all"},
		GeoRule: GeoFencingRule{AllowedCountries: allowed, ProhibitedCountries: prohibited},
	}
}

func evaluateWithoutCountry(t *testing.T, p *PosturePolicy) PostureResult {
	t.Helper()
	pe := NewPostureEngine()
	if err := pe.UpsertPolicy(p); err != nil {
		t.Fatal(err)
	}
	att := &PeerAttestation{NodeID: "node-unknown-place", OSName: "linux", OSVersion: "6.1.0", ClientVersion: "v4.0.0"}
	return pe.EvaluateAttestation(att, []string{"group:all"})
}

func TestAnAllowListIsNotMetByAnUnknownCountry(t *testing.T) {
	res := evaluateWithoutCountry(t, geoPolicy([]string{"IT", "DE"}, nil))
	if res.Compliant || res.Status != StatusUnverified {
		t.Fatalf("an allow list passed a node with no country: %+v", res)
	}
	if res.Quarantine {
		t.Fatalf("an unknown country is not a violation and must not quarantine: %+v", res)
	}
	found := false
	for _, u := range res.UnknownChecks {
		found = found || u == "country was not reported"
	}
	if !found {
		t.Fatalf("unknown checks = %v, want the country named", res.UnknownChecks)
	}
}

func TestAProhibitedListCannotBeCheckedWithoutACountry(t *testing.T) {
	res := evaluateWithoutCountry(t, geoPolicy(nil, []string{"KP"}))
	if res.Compliant || res.Status != StatusUnverified {
		t.Fatalf("a prohibited list passed a node whose country is unknown: %+v", res)
	}
}

func TestWithoutACountryRuleAnUnknownCountryChangesNothing(t *testing.T) {
	res := evaluateWithoutCountry(t, geoPolicy(nil, nil))
	if !res.Compliant || len(res.UnknownChecks) != 0 {
		t.Fatalf("a policy with no country rule was affected by an unknown country: %+v", res)
	}
}

func TestAStatedCountryIsStillJudged(t *testing.T) {
	pe := NewPostureEngine()
	if err := pe.UpsertPolicy(geoPolicy([]string{"IT"}, nil)); err != nil {
		t.Fatal(err)
	}
	ok := &PeerAttestation{NodeID: "a", OSName: "linux", OSVersion: "6.1.0", ClientVersion: "v4.0.0", CountryCode: "IT"}
	if res := pe.EvaluateAttestation(ok, []string{"group:all"}); !res.Compliant {
		t.Fatalf("a listed country failed: %+v", res)
	}
	bad := &PeerAttestation{NodeID: "b", OSName: "linux", OSVersion: "6.1.0", ClientVersion: "v4.0.0", CountryCode: "FR"}
	if res := pe.EvaluateAttestation(bad, []string{"group:all"}); res.Compliant || !res.Quarantine {
		t.Fatalf("an unlisted country passed: %+v", res)
	}
}
