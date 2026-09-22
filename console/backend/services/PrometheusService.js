const { readFleetState } = require('./MetricsCollector');
const { checkValkeyHealth } = require('../db/valkey');

class PrometheusService {
  constructor() {
    this.reset();
  }

  reset() {
    this.httpRequests = new Map(); // key: `${method}:${status}` -> count
    this.httpRequestDurationSum = new Map(); // key: `${method}:${status}` -> sum_ms
    this.httpRequestDurationCount = new Map(); // key: `${method}:${status}` -> count
    this.heartbeatLatencyMs = 0;
    this.heartbeatLatencySum = 0;
    this.heartbeatLatencyCount = 0;
    this.aclDroppedPacketsTotal = 0;
    this.derpFallbackTotal = 0;
  }

  recordHttpRequest(method, status, durationMs) {
    const key = `${method.toUpperCase()}:${status}`;
    this.httpRequests.set(key, (this.httpRequests.get(key) || 0) + 1);
    this.httpRequestDurationSum.set(key, (this.httpRequestDurationSum.get(key) || 0) + durationMs);
    this.httpRequestDurationCount.set(key, (this.httpRequestDurationCount.get(key) || 0) + 1);
  }

  recordHeartbeatLatency(latencyMs) {
    this.heartbeatLatencyMs = latencyMs;
    this.heartbeatLatencySum += latencyMs;
    this.heartbeatLatencyCount += 1;
  }

  recordAclDrop(count = 1) {
    this.aclDroppedPacketsTotal += count;
  }

  recordDerpFallback(count = 1) {
    this.derpFallbackTotal += count;
  }

  async renderMetrics() {
    let fleet = {
      liveNodes: 0,
      enrolledNodes: 0,
      quarantinedNodes: 0,
      activeUsers: 0,
      rxBytes: 0,
      txBytes: 0
    };

    try {
      fleet = await readFleetState();
    } catch (err) {
      // Fallback if database is unavailable
    }

    let valkeyConnected = 0;
    try {
      const vh = await checkValkeyHealth();
      if (vh && vh.status === 'connected') {
        valkeyConnected = 1;
      }
    } catch (err) {
      valkeyConnected = 0;
    }

    const uptime = Math.floor(process.uptime());
    const mem = process.memoryUsage();

    const lines = [];

    lines.push('# HELP sovereign_control_plane_uptime_seconds NeroNet control plane process uptime in seconds');
    lines.push('# TYPE sovereign_control_plane_uptime_seconds gauge');
    lines.push(`sovereign_control_plane_uptime_seconds ${uptime}`);
    lines.push('');

    lines.push('# HELP sovereign_nodes_total Total registered mesh nodes');
    lines.push('# TYPE sovereign_nodes_total gauge');
    lines.push(`sovereign_nodes_total ${fleet.enrolledNodes || 0}`);
    lines.push('');

    lines.push('# HELP sovereign_nodes_live Currently active mesh nodes reporting heartbeats');
    lines.push('# TYPE sovereign_nodes_live gauge');
    lines.push(`sovereign_nodes_live ${fleet.liveNodes || 0}`);
    lines.push('');

    lines.push('# HELP sovereign_nodes_quarantined Quarantined non-compliant mesh nodes');
    lines.push('# TYPE sovereign_nodes_quarantined gauge');
    lines.push(`sovereign_nodes_quarantined ${fleet.quarantinedNodes || 0}`);
    lines.push('');

    lines.push('# HELP sovereign_users_total Total registered control plane users');
    lines.push('# TYPE sovereign_users_total gauge');
    lines.push(`sovereign_users_total ${fleet.activeUsers || 0}`);
    lines.push('');

    lines.push('# HELP sovereign_traffic_rx_bytes_total Cumulative network bandwidth received across all nodes');
    lines.push('# TYPE sovereign_traffic_rx_bytes_total counter');
    lines.push(`sovereign_traffic_rx_bytes_total ${fleet.rxBytes || 0}`);
    lines.push('');

    lines.push('# HELP sovereign_traffic_tx_bytes_total Cumulative network bandwidth transmitted across all nodes');
    lines.push('# TYPE sovereign_traffic_tx_bytes_total counter');
    lines.push(`sovereign_traffic_tx_bytes_total ${fleet.txBytes || 0}`);
    lines.push('');

    lines.push('# HELP sovereign_heartbeat_latency_ms Latest heartbeat processing latency in milliseconds');
    lines.push('# TYPE sovereign_heartbeat_latency_ms gauge');
    lines.push(`sovereign_heartbeat_latency_ms ${this.heartbeatLatencyMs}`);
    lines.push('');

    lines.push('# HELP sovereign_acl_dropped_packets_total Total ACL packets or requests dropped by policy');
    lines.push('# TYPE sovereign_acl_dropped_packets_total counter');
    lines.push(`sovereign_acl_dropped_packets_total ${this.aclDroppedPacketsTotal}`);
    lines.push('');

    lines.push('# HELP sovereign_derp_fallback_total Total DERP relay fallback events for symmetric NAT traversal');
    lines.push('# TYPE sovereign_derp_fallback_total counter');
    lines.push(`sovereign_derp_fallback_total ${this.derpFallbackTotal}`);
    lines.push('');

    lines.push('# HELP sovereign_valkey_connected Valkey cache connectivity status (1 for connected, 0 for disconnected)');
    lines.push('# TYPE sovereign_valkey_connected gauge');
    lines.push(`sovereign_valkey_connected ${valkeyConnected}`);
    lines.push('');

    lines.push('# HELP sovereign_process_memory_bytes Node.js process memory usage');
    lines.push('# TYPE sovereign_process_memory_bytes gauge');
    lines.push(`sovereign_process_memory_bytes{type="rss"} ${mem.rss}`);
    lines.push(`sovereign_process_memory_bytes{type="heap_total"} ${mem.heapTotal}`);
    lines.push(`sovereign_process_memory_bytes{type="heap_used"} ${mem.heapUsed}`);
    lines.push('');

    lines.push('# HELP sovereign_http_requests_total Total HTTP requests handled by the control plane');
    lines.push('# TYPE sovereign_http_requests_total counter');
    if (this.httpRequests.size === 0) {
      lines.push('sovereign_http_requests_total{method="GET",status="200"} 0');
    } else {
      for (const [key, count] of this.httpRequests.entries()) {
        const [method, status] = key.split(':');
        lines.push(`sovereign_http_requests_total{method="${method}",status="${status}"} ${count}`);
      }
    }
    lines.push('');

    lines.push('# HELP sovereign_http_request_duration_ms_sum Total duration of HTTP requests in milliseconds');
    lines.push('# TYPE sovereign_http_request_duration_ms_sum counter');
    if (this.httpRequestDurationSum.size === 0) {
      lines.push('sovereign_http_request_duration_ms_sum{method="GET",status="200"} 0');
    } else {
      for (const [key, sum] of this.httpRequestDurationSum.entries()) {
        const [method, status] = key.split(':');
        lines.push(`sovereign_http_request_duration_ms_sum{method="${method}",status="${status}"} ${sum}`);
      }
    }
    lines.push('');

    lines.push('# HELP sovereign_http_request_duration_ms_count Count of measured HTTP requests');
    lines.push('# TYPE sovereign_http_request_duration_ms_count counter');
    if (this.httpRequestDurationCount.size === 0) {
      lines.push('sovereign_http_request_duration_ms_count{method="GET",status="200"} 0');
    } else {
      for (const [key, count] of this.httpRequestDurationCount.entries()) {
        const [method, status] = key.split(':');
        lines.push(`sovereign_http_request_duration_ms_count{method="${method}",status="${status}"} ${count}`);
      }
    }
    lines.push('');

    return lines.join('\n');
  }
}

const singleton = new PrometheusService();
module.exports = singleton;
