package control

import (
	"encoding/json"
	"math"
	"strconv"
	"testing"
)

// The control plane is JavaScript: a JSON number above 2^53 arrives rounded. WireGuard
// counters are uint64 and cumulative, so a long-lived session must cross the wire as
// a decimal string, the convention NativeTelemetry already uses.
func TestPeerPathCountersSurviveAJavaScriptReader(t *testing.T) {
	for _, value := range []uint64{0, 1 << 53, 1<<53 + 1, math.MaxUint64} {
		observation := PeerPathObservation{
			PeerID:    "node-b",
			State:     "observed",
			WGRxBytes: strconv.FormatUint(value, 10),
			WGTxBytes: strconv.FormatUint(value, 10),
		}
		raw, err := json.Marshal(observation)
		if err != nil {
			t.Fatal(err)
		}
		// A generic decoder reads numbers as float64, as JSON.parse does.
		var generic map[string]any
		if err := json.Unmarshal(raw, &generic); err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"wg_rx_bytes", "wg_tx_bytes"} {
			got, ok := generic[field].(string)
			if !ok || got != strconv.FormatUint(value, 10) {
				t.Fatalf("%s for %d decoded as %#v", field, value, generic[field])
			}
		}
	}
}
