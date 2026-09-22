package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNodeMetricsCollector_RenderPrometheus(t *testing.T) {
	collector := &NodeMetricsCollector{
		startTime: time.Now().Add(-10 * time.Second),
	}

	collector.RecordHeartbeat(45*time.Millisecond, true, false)
	collector.RecordHeartbeat(120*time.Millisecond, false, true)
	collector.UpdateEpochs(5, 3)

	metrics := collector.RenderPrometheus()

	expectedMetrics := []string{
		"sovereign_node_uptime_seconds",
		"sovereign_node_heartbeats_total 2",
		"sovereign_node_heartbeat_failures_total 1",
		"sovereign_node_heartbeat_latency_ms 120",
		"sovereign_node_quarantined 1",
		"sovereign_node_acl_epoch 5",
		"sovereign_node_route_epoch 3",
		"sovereign_node_memory_bytes{type=\"alloc\"}",
		"sovereign_node_memory_bytes{type=\"sys\"}",
		"sovereign_node_goroutines",
	}

	for _, expected := range expectedMetrics {
		if !strings.Contains(metrics, expected) {
			t.Errorf("RenderPrometheus missing expected token: %q\nRendered:\n%s", expected, metrics)
		}
	}
}

func TestNodeMetricsServer_HTTP(t *testing.T) {
	globalNodeMetrics.RecordHeartbeat(25*time.Millisecond, true, false)
	globalNodeMetrics.UpdateEpochs(10, 8)

	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(globalNodeMetrics.RenderPrometheus()))
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	resp, err := http.Get(server.URL + "/metrics")
	if err != nil {
		t.Fatalf("Failed to query metrics server: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", resp.StatusCode)
	}

	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "text/plain") {
		t.Errorf("Expected text/plain Content-Type, got %s", contentType)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("Failed to read response body: %v", err)
	}

	if !strings.Contains(string(body), "sovereign_node_heartbeats_total") {
		t.Errorf("Response body missing metric: %s", string(body))
	}
}
