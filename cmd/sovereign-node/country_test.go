package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// ADR 0042: no country unless the operator sets one.

func TestNoCountryIsReportedUnlessTheOperatorSetsOne(t *testing.T) {
	got, err := normaliseCountry("")
	if err != nil || got != "" {
		t.Fatalf("empty = %q, %v; want unknown", got, err)
	}
	if got, _ := normaliseCountry("  it "); got != "IT" {
		t.Fatalf("it = %q, want IT", got)
	}
	for _, bad := range []string{"USA", "U", "1X", "É1", "u s"} {
		if _, err := normaliseCountry(bad); err == nil {
			t.Fatalf("%q was accepted as a country", bad)
		}
	}
}

func TestACapabilityWithoutACountryCarriesNoCountryField(t *testing.T) {
	raw, err := json.Marshal(capability(false, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "country_code") {
		t.Fatalf("capability without a country still names one: %s", raw)
	}
	raw, _ = json.Marshal(capability(false, "IT", 0))
	if !strings.Contains(string(raw), `"country_code":"IT"`) {
		t.Fatalf("an explicit country was dropped: %s", raw)
	}
}

func TestTheAttestationCarriesNoCountryUnlessOneWasSet(t *testing.T) {
	if att := buildAttestation("n", "", false, time.Now()); att.CountryCode != "" {
		t.Fatalf("attestation country = %q, want none", att.CountryCode)
	}
}
