package routing

import (
	"errors"
	"testing"
)

// ADR 0040: an exit whose country is unknown never satisfies a request for a country, and
// a request that names no country is refused rather than answered with an unknown one.

func exit(id, country string) *NodeCandidate {
	return &NodeCandidate{
		NodeID: id, CountryCode: country, Role: "EXIT_BRIDGE",
		Metrics: NodeMetrics{AvailableBandwidthMbps: 90, MaxBandwidthMbps: 100, RTTms: 10, ReputationScore: 0.95},
	}
}

func TestAnExitWithAnUnknownCountryNeverMatchesACountry(t *testing.T) {
	e := NewRoutingEngine()
	e.AddCandidate(exit("unknown-place", ""))
	if got, err := e.SelectByCountry("US"); err == nil || !errors.Is(err, ErrNoCandidateFound) {
		t.Fatalf("an exit with no country answered a request for US: %+v, %v", got, err)
	}
	e.AddCandidate(exit("it-exit", "IT"))
	got, err := e.SelectByCountry("it")
	if err != nil || got.NodeID != "it-exit" {
		t.Fatalf("SelectByCountry(it) = %+v, %v; want the Italian exit", got, err)
	}
}

func TestARequestWithoutACountryIsNotAnsweredWithAnUnknownOne(t *testing.T) {
	e := NewRoutingEngine()
	e.AddCandidate(exit("unknown-place", ""))
	if got, err := e.SelectByCountry(""); err == nil {
		t.Fatalf("an empty country matched an exit with an unknown one: %+v", got)
	}
}
