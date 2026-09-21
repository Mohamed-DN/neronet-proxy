package control_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	qt "github.com/frankban/quicktest"
	"github.com/sovereign/proxy/v4/pkg/control"
)

func TestContractFixturesRoundTrip(t *testing.T) {
	c := qt.New(t)

	fixturesDir := filepath.Join("..", "..", "api", "contract", "v4", "fixtures")

	tests := []struct {
		name     string
		instance func() any
	}{
		{"ChallengeRequest.json", func() any { return &control.ChallengeRequest{} }},
		{"ChallengeResponse.json", func() any { return &control.ChallengeResponse{} }},
		{"RegisterRequest.json", func() any { return &control.RegisterRequest{} }},
		{"RegisterResponse.json", func() any { return &control.RegisterResponse{} }},
		{"HeartbeatRequest.json", func() any { return &control.HeartbeatRequest{} }},
		{"HeartbeatResponse.json", func() any { return &control.HeartbeatResponse{} }},
		{"DiscoverRequest.json", func() any { return &control.DiscoverRequest{} }},
		{"DiscoverResponse.json", func() any { return &control.DiscoverResponse{} }},
		{"CircuitRequest.json", func() any { return &control.CircuitRequest{} }},
		{"CircuitResponse.json", func() any { return &control.CircuitResponse{} }},
		{"ACLSyncRequest.json", func() any { return &control.ACLSyncRequest{} }},
		{"ACLSyncResponse.json", func() any { return &control.ACLSyncResponse{} }},
		{"RouteSyncRequest.json", func() any { return &control.RouteSyncRequest{} }},
		{"RouteSyncResponse.json", func() any { return &control.RouteSyncResponse{} }},
		{"NetmapRequest.json", func() any { return &control.NetmapRequest{} }},
		{"NetmapResponse.json", func() any { return &control.NetmapResponse{} }},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(fixturesDir, tc.name))
			c.Assert(err, qt.IsNil)

			inst := tc.instance()
			err = json.Unmarshal(raw, inst)
			c.Assert(err, qt.IsNil)

			remarshaled, err := json.Marshal(inst)
			c.Assert(err, qt.IsNil)

			var origVal any
			err = json.Unmarshal(raw, &origVal)
			c.Assert(err, qt.IsNil)

			var roundTripVal any
			err = json.Unmarshal(remarshaled, &roundTripVal)
			c.Assert(err, qt.IsNil)

			c.Assert(roundTripVal, qt.DeepEquals, origVal)
		})
	}
}
