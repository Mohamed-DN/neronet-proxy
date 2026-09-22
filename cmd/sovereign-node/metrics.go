package main

import (
	"fmt"
	"log"
	"net/http"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

// NodeMetricsCollector aggregates and formats OpenMetrics / Prometheus telemetry
// for an active sovereign mesh node daemon.
type NodeMetricsCollector struct {
	startTime       time.Time
	heartbeatsSent  uint64
	heartbeatErrors uint64
	lastHeartbeatMs uint64
	policyEpoch     uint64
	routeEpoch      uint64
	isQuarantined   uint32
}

var globalNodeMetrics = &NodeMetricsCollector{
	startTime: time.Now(),
}

// RecordHeartbeat tracks heartbeat roundtrip latency and delivery status.
func (m *NodeMetricsCollector) RecordHeartbeat(duration time.Duration, success bool, isQuarantined bool) {
	atomic.AddUint64(&m.heartbeatsSent, 1)
	if !success {
		atomic.AddUint64(&m.heartbeatErrors, 1)
	}
	atomic.StoreUint64(&m.lastHeartbeatMs, uint64(duration.Milliseconds()))
	q := uint32(0)
	if isQuarantined {
		q = 1
	}
	atomic.StoreUint32(&m.isQuarantined, q)
}

// UpdateEpochs updates recorded policy and route epochs.
func (m *NodeMetricsCollector) UpdateEpochs(policyEp, routeEp uint64) {
	if policyEp > 0 {
		atomic.StoreUint64(&m.policyEpoch, policyEp)
	}
	if routeEp > 0 {
		atomic.StoreUint64(&m.routeEpoch, routeEp)
	}
}

// RenderPrometheus produces the Prometheus text exposition format (version 0.0.4).
func (m *NodeMetricsCollector) RenderPrometheus() string {
	var sb strings.Builder
	uptime := int64(time.Since(m.startTime).Seconds())

	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	sb.WriteString("# HELP sovereign_node_uptime_seconds Sovereign node daemon uptime in seconds\n")
	sb.WriteString("# TYPE sovereign_node_uptime_seconds gauge\n")
	sb.WriteString(fmt.Sprintf("sovereign_node_uptime_seconds %d\n", uptime))

	sb.WriteString("# HELP sovereign_node_heartbeats_total Total heartbeat attempts sent to control plane\n")
	sb.WriteString("# TYPE sovereign_node_heartbeats_total counter\n")
	sb.WriteString(fmt.Sprintf("sovereign_node_heartbeats_total %d\n", atomic.LoadUint64(&m.heartbeatsSent)))

	sb.WriteString("# HELP sovereign_node_heartbeat_failures_total Total failed heartbeats\n")
	sb.WriteString("# TYPE sovereign_node_heartbeat_failures_total counter\n")
	sb.WriteString(fmt.Sprintf("sovereign_node_heartbeat_failures_total %d\n", atomic.LoadUint64(&m.heartbeatErrors)))

	sb.WriteString("# HELP sovereign_node_heartbeat_latency_ms Duration of last heartbeat roundtrip in ms\n")
	sb.WriteString("# TYPE sovereign_node_heartbeat_latency_ms gauge\n")
	sb.WriteString(fmt.Sprintf("sovereign_node_heartbeat_latency_ms %d\n", atomic.LoadUint64(&m.lastHeartbeatMs)))

	sb.WriteString("# HELP sovereign_node_quarantined Posture quarantine status (1 quarantined, 0 compliant)\n")
	sb.WriteString("# TYPE sovereign_node_quarantined gauge\n")
	sb.WriteString(fmt.Sprintf("sovereign_node_quarantined %d\n", atomic.LoadUint32(&m.isQuarantined)))

	sb.WriteString("# HELP sovereign_node_acl_epoch Current synced ACL policy epoch\n")
	sb.WriteString("# TYPE sovereign_node_acl_epoch gauge\n")
	sb.WriteString(fmt.Sprintf("sovereign_node_acl_epoch %d\n", atomic.LoadUint64(&m.policyEpoch)))

	sb.WriteString("# HELP sovereign_node_route_epoch Current synced subnet route epoch\n")
	sb.WriteString("# TYPE sovereign_node_route_epoch gauge\n")
	sb.WriteString(fmt.Sprintf("sovereign_node_route_epoch %d\n", atomic.LoadUint64(&m.routeEpoch)))

	sb.WriteString("# HELP sovereign_node_memory_bytes Memory allocated by the node runtime\n")
	sb.WriteString("# TYPE sovereign_node_memory_bytes gauge\n")
	sb.WriteString(fmt.Sprintf("sovereign_node_memory_bytes{type=\"alloc\"} %d\n", memStats.Alloc))
	sb.WriteString(fmt.Sprintf("sovereign_node_memory_bytes{type=\"sys\"} %d\n", memStats.Sys))

	sb.WriteString("# HELP sovereign_node_goroutines Current number of running goroutines\n")
	sb.WriteString("# TYPE sovereign_node_goroutines gauge\n")
	sb.WriteString(fmt.Sprintf("sovereign_node_goroutines %d\n", runtime.NumGoroutine()))

	return sb.String()
}

// startMetricsServer begins serving Prometheus telemetry on the designated address.
func startMetricsServer(addr string) (*http.Server, error) {
	if addr == "" {
		return nil, nil
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(globalNodeMetrics.RenderPrometheus()))
	})
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[SOVEREIGN-NODE] Metrics server error: %v", err)
		}
	}()
	log.Printf("[SOVEREIGN-NODE] Prometheus metrics exporter active on http://%s/metrics", addr)
	return srv, nil
}
