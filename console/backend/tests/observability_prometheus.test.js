const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../server');
const PrometheusService = require('../services/PrometheusService');
const logger = require('../utils/logger');

describe('WP-305: Observability — Prometheus Metrics & Structured Logging', () => {
  let app;

  before(async () => {
    app = createApp();
  });

  beforeEach(() => {
    PrometheusService.reset();
  });

  describe('Prometheus Metrics HTTP Endpoint', () => {
    it('1. GET /metrics returns 200 with text/plain OpenMetrics content-type', async () => {
      const res = await request(app).get('/metrics');
      assert.strictEqual(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/plain/);
      assert.match(res.headers['content-type'], /version=0\.0\.4/);
    });

    it('2. GET /api/metrics also serves the exact same telemetry', async () => {
      const res = await request(app).get('/api/metrics');
      assert.strictEqual(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/plain/);
    });

    it('3. Output conforms to Prometheus exposition format with HELP and TYPE descriptors', async () => {
      const res = await request(app).get('/metrics');
      const body = res.text;

      const expectedDescriptors = [
        '# HELP sovereign_control_plane_uptime_seconds',
        '# TYPE sovereign_control_plane_uptime_seconds gauge',
        '# HELP sovereign_nodes_total',
        '# TYPE sovereign_nodes_total gauge',
        '# HELP sovereign_nodes_live',
        '# TYPE sovereign_nodes_live gauge',
        '# HELP sovereign_nodes_quarantined',
        '# TYPE sovereign_nodes_quarantined gauge',
        '# HELP sovereign_users_total',
        '# TYPE sovereign_users_total gauge',
        '# HELP sovereign_traffic_rx_bytes_total',
        '# TYPE sovereign_traffic_rx_bytes_total counter',
        '# HELP sovereign_traffic_tx_bytes_total',
        '# TYPE sovereign_traffic_tx_bytes_total counter',
        '# HELP sovereign_heartbeat_latency_ms',
        '# TYPE sovereign_heartbeat_latency_ms gauge',
        '# HELP sovereign_acl_dropped_packets_total',
        '# TYPE sovereign_acl_dropped_packets_total counter',
        '# HELP sovereign_derp_fallback_total',
        '# TYPE sovereign_derp_fallback_total counter',
        '# HELP sovereign_valkey_connected',
        '# TYPE sovereign_valkey_connected gauge',
        '# HELP sovereign_process_memory_bytes',
        '# TYPE sovereign_process_memory_bytes gauge',
        '# HELP sovereign_http_requests_total',
        '# TYPE sovereign_http_requests_total counter',
        '# HELP sovereign_http_request_duration_ms_sum',
        '# TYPE sovereign_http_request_duration_ms_sum counter',
        '# HELP sovereign_http_request_duration_ms_count',
        '# TYPE sovereign_http_request_duration_ms_count counter'
      ];

      for (const desc of expectedDescriptors) {
        assert.ok(body.includes(desc), `Metrics output missing descriptor: ${desc}`);
      }
    });

    it('4. Correctly tracks HTTP request counts and durations through requestMetrics middleware', async () => {
      // Send sample requests to measure
      await request(app).get('/api/health');
      await request(app).get('/api/health');

      const res = await request(app).get('/metrics');
      const body = res.text;

      assert.match(
        body,
        /sovereign_http_requests_total\{method="GET",status="200"\} [1-9][0-9]*/,
        'Should record at least 1 GET 200 request'
      );
      assert.match(
        body,
        /sovereign_http_request_duration_ms_sum\{method="GET",status="200"\} [0-9]+/,
        'Should record request duration sum'
      );
      assert.match(
        body,
        /sovereign_http_request_duration_ms_count\{method="GET",status="200"\} [1-9][0-9]*/,
        'Should record request duration count'
      );
    });

    it('5. Correctly reflects operational telemetry for heartbeat latency, ACL drops, and DERP fallbacks', async () => {
      PrometheusService.recordHeartbeatLatency(85);
      PrometheusService.recordAclDrop(14);
      PrometheusService.recordDerpFallback(3);

      const res = await request(app).get('/metrics');
      const body = res.text;

      assert.ok(
        body.includes('sovereign_heartbeat_latency_ms 85'),
        'Heartbeat latency gauge must match recorded value'
      );
      assert.ok(
        body.includes('sovereign_acl_dropped_packets_total 14'),
        'ACL dropped counter must match recorded count'
      );
      assert.ok(
        body.includes('sovereign_derp_fallback_total 3'),
        'DERP fallback counter must match recorded count'
      );
    });
  });

  describe('Structured JSON Logging', () => {
    const originalLogFormat = process.env.LOG_FORMAT;
    const originalNodeEnv = process.env.NODE_ENV;
    let interceptedLogs = [];
    const origConsoleLog = console.log;
    const origConsoleWarn = console.warn;
    const origConsoleError = console.error;

    before(() => {
      console.log = (...args) => interceptedLogs.push({ stream: 'stdout', msg: args[0] });
      console.warn = (...args) => interceptedLogs.push({ stream: 'stderr_warn', msg: args[0] });
      console.error = (...args) => interceptedLogs.push({ stream: 'stderr_error', msg: args[0] });
    });

    after(() => {
      console.log = origConsoleLog;
      console.warn = origConsoleWarn;
      console.error = origConsoleError;
      process.env.LOG_FORMAT = originalLogFormat;
      process.env.NODE_ENV = originalNodeEnv;
    });

    beforeEach(() => {
      interceptedLogs = [];
    });

    it('1. Emits valid, structured JSON lines when LOG_FORMAT=json', () => {
      process.env.LOG_FORMAT = 'json';
      delete process.env.NODE_ENV;

      assert.strictEqual(logger.isJsonLogging(), true);

      logger.info('Node mesh enrolled', { nodeId: 'node-abc-123', ip: '10.200.0.5' });
      assert.strictEqual(interceptedLogs.length, 1);

      const parsed = JSON.parse(interceptedLogs[0].msg);
      assert.strictEqual(parsed.level, 'info');
      assert.strictEqual(parsed.message, 'Node mesh enrolled');
      assert.strictEqual(parsed.service, 'neronet-control-plane');
      assert.strictEqual(parsed.nodeId, 'node-abc-123');
      assert.strictEqual(parsed.ip, '10.200.0.5');
      assert.ok(parsed.timestamp, 'Timestamp must be present');
    });

    it('2. Properly formats Error objects with stack traces in JSON logs', () => {
      process.env.LOG_FORMAT = 'json';

      const testError = new Error('Database connection timeout');
      testError.name = 'DatabaseTimeoutError';

      logger.error('Database query failed', testError);
      assert.strictEqual(interceptedLogs.length, 1);

      const parsed = JSON.parse(interceptedLogs[0].msg);
      assert.strictEqual(parsed.level, 'error');
      assert.strictEqual(parsed.message, 'Database query failed');
      assert.strictEqual(parsed.error.name, 'DatabaseTimeoutError');
      assert.strictEqual(parsed.error.message, 'Database connection timeout');
      assert.ok(parsed.error.stack.includes('Database connection timeout'), 'Stack trace must be serialized');
    });

    it('3. Falls back to human-friendly ANSI output when LOG_FORMAT is not json and not in production', () => {
      delete process.env.LOG_FORMAT;
      process.env.NODE_ENV = 'test';

      assert.strictEqual(logger.isJsonLogging(), false);

      logger.info('Human readable test log');
      assert.strictEqual(interceptedLogs.length, 1);
      assert.ok(interceptedLogs[0].msg.includes('[INFO]'));
      assert.throws(() => JSON.parse(interceptedLogs[0].msg), 'Human format should not be JSON');
    });
  });
});
