package control

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestHeartbeatCarriesMeasuredRTT covers the per-country latency column, which had
// no measurement behind it: the control plane substituted a constant, and before
// that a random number.
func TestHeartbeatCarriesMeasuredRTT(t *testing.T) {
	var received []uint32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body HeartbeatRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		received = append(received, body.RTTMillis)

		// Enough delay that the measured round trip cannot round down to zero.
		time.Sleep(3 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"acknowledged":true}`))
	}))
	defer server.Close()

	client := NewClient(server.URL)

	for i := 0; i < 3; i++ {
		if _, err := client.SendHeartbeat(t.Context(), "node-1", nil, 0, 0, 0, 100, false); err != nil {
			t.Fatalf("heartbeat %d: %v", i, err)
		}
	}

	if len(received) != 3 {
		t.Fatalf("expected 3 heartbeats, got %d", len(received))
	}
	if received[0] != 0 {
		t.Errorf("the first heartbeat has no previous round trip to report, got %d", received[0])
	}
	for i := 1; i < 3; i++ {
		if received[i] == 0 {
			t.Errorf("heartbeat %d reported no round trip after one was measured", i)
		}
	}
}

// TestRTTIsNotMeasuredBeforeFirstHeartbeat pins the sentinel: zero means unmeasured,
// so the console can tell "no data" apart from "a very fast path".
func TestRTTIsNotMeasuredBeforeFirstHeartbeat(t *testing.T) {
	client := NewClient("http://127.0.0.1:1")
	if got := client.lastRTTMillis(); got != 0 {
		t.Errorf("a fresh client reported %d ms before measuring anything", got)
	}
}

// TestRTTRoundsUp keeps a sub-millisecond round trip from reporting the value that
// means "not measured".
func TestRTTRoundsUp(t *testing.T) {
	client := NewClient("http://127.0.0.1:1")
	client.recordRTT(120 * time.Microsecond)

	if got := client.lastRTTMillis(); got != 1 {
		t.Errorf("120us reported as %d ms, want 1", got)
	}
}

// TestHeartbeatReportsUnknownNode covers a node stranded permanently after the
// control plane lost its row: the daemon logged "did not acknowledge heartbeat"
// every fifteen seconds and never enrolled again, because a 404 was indistinguishable
// from any other unacknowledged beat.
func TestHeartbeatReportsUnknownNode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"unknown node_id node-gone"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL)

	_, err := client.SendHeartbeat(t.Context(), "node-gone", nil, 0, 0, 0, 100, false)
	if !errors.Is(err, ErrNodeUnknown) {
		t.Errorf("a 404 heartbeat returned %v, want ErrNodeUnknown so the caller can re-enrol", err)
	}
}

// TestHeartbeatAcknowledgedIsNotUnknown keeps the recovery path from firing on a
// healthy beat, which would re-enrol the node on every heartbeat.
func TestHeartbeatAcknowledgedIsNotUnknown(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"acknowledged":true}`))
	}))
	defer server.Close()

	resp, err := NewClient(server.URL).SendHeartbeat(t.Context(), "node-1", nil, 0, 0, 0, 100, false)
	if err != nil {
		t.Fatalf("healthy heartbeat: %v", err)
	}
	if !resp.Acknowledged {
		t.Error("a healthy heartbeat was not acknowledged")
	}
}
