const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { register, nodeKey } = require('./helpers/nodeEnrolment');
const { seedHiddenTier, tokens, NODES, ORG_A, ORG_B, DEFAULT_COMPARTMENT } = require('./helpers/hiddenTier');
const { seedNative } = require('./helpers/nativeMetricsFixture');
const MetricsCollector = require('../services/MetricsCollector');

describe('Native observations reach overview, source-aware history and node DTOs', () => {
  let db, app, auth;
  const get = (path, actor = 'owner') => request(app).get(`/api${path}`).set('Authorization', `Bearer ${auth[actor]}`);
  const sample = async () => {
    await MetricsCollector.collectOnce();
    await db.pool.query('SELECT pg_sleep(0.02)');
  };
  const advance = (id, rx = '200', tx = '400') =>
    db.pool.query(
      `UPDATE node_native_telemetry SET sequence=sequence+1,rx_bytes=$2,tx_bytes=$3,
      received_at=clock_timestamp() WHERE node_id=$1`,
      [id, rx, tx]
    );
  before(async () => {
    db = await setupTestDatabase();
    app = createApp();
  });
  beforeEach(async () => {
    await db.pool.query('DELETE FROM nodes');
    await seedHiddenTier(db.pool);
    auth = tokens();
    for (const n of Object.values(NODES)) await seedNative(db.pool, n.id, { ago: 10 });
    await db.pool.query('UPDATE nodes SET last_heartbeat=NOW(),rx_bytes=999,tx_bytes=888,memory_usage_pct=777');
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  it('uses real authenticated heartbeat observations in the existing overview and node endpoints', async () => {
    const registered = await register(app, { public_key_hex: nodeKey(), role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.equal(registered.status, 200);
    const n = registered.body;
    const response = await request(app)
      .post('/v4/control/heartbeat')
      .set('Authorization', `Bearer ${n.credential}`)
      .send({
        node_id: n.assigned_node_id,
        memory_usage_mb: 777,
        telemetry: {
          version: 1,
          session_id: n.telemetry_session,
          sequence: '1',
          counter_epoch: '1',
          source: 'wireguard-device',
          traffic_available: true,
          rx_bytes: '9007199254740993',
          tx_bytes: '18446744073709551615',
          memory_runtime_sys_bytes: '12345678'
        }
      });
    assert.equal(response.status, 200);
    const overview = await get('/stats/overview?org_id=org-default', 'superAdmin');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.total_rx_bytes, '9007199254740993');
    assert.equal(overview.body.total_tx_bytes, '18446744073709551615');
    assert.equal(overview.body.total_bandwidth_bytes, '18455751272964292608');
    assert.equal(overview.body.memory_runtime_sys_bytes, '12345678');
    assert.equal(overview.body.avg_memory_pct, null);
    const detail = await get(`/nodes/${n.assigned_node_id}`, 'superAdmin');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.node.rx_bytes, '9007199254740993');
    assert.equal(detail.body.node.memory_runtime_sys_bytes, '12345678');
    assert.equal(detail.body.node.memory_usage_pct, null);
    assert.equal(detail.body.node.native_telemetry.status, 'fresh');
  });
  it('aggregates only scoped native counters and reports explicit coverage', async () => {
    const { body } = await get('/stats/overview');
    assert.equal(body.total_rx_bytes, '200');
    assert.equal(body.total_tx_bytes, '400');
    assert.equal(body.memory_runtime_sys_bytes, '8192');
    assert.equal(body.avg_memory_pct, null);
    assert.equal(body.traffic.source, 'wireguard-device');
    assert.equal(body.traffic.status, 'measured');
    assert.equal(body.traffic.measured_nodes, 2);
    assert.equal(body.traffic.total_nodes, 2);
  });
  it('does not replace missing native measurements with legacy zeros or memory percentages', async () => {
    await db.pool.query('DELETE FROM node_native_telemetry');
    const { body } = await get('/stats/overview');
    assert.equal(body.total_rx_bytes, null);
    assert.equal(body.total_bandwidth_bytes, null);
    assert.equal(body.avg_memory_pct, null);
    assert.equal(body.memory_runtime_sys_bytes, null);
    assert.equal(body.traffic.status, 'unknown');
    const node = (await get(`/nodes/${NODES.v1.id}`)).body.node;
    assert.equal(node.rx_bytes, null);
    assert.equal(node.memory_usage_pct, null);
    assert.equal(node.native_telemetry.status, 'unknown');
  });
  it('does not claim complete fleet traffic when one visible observation is stale', async () => {
    await db.pool.query("UPDATE node_native_telemetry SET received_at=NOW()-interval '120 seconds' WHERE node_id=$1", [
      NODES.v1.id
    ]);
    const { body } = await get('/stats/overview');
    assert.equal(body.total_rx_bytes, null);
    assert.equal(body.memory_runtime_sys_bytes, null);
    assert.equal(body.traffic.status, 'partial');
    assert.equal(body.traffic.stale_nodes, 1);
    assert.equal(body.traffic.measured_nodes, 1);
    const node = (await get(`/nodes/${NODES.v1.id}`)).body.node;
    assert.equal(node.rx_bytes, null);
    assert.equal(node.native_telemetry.status, 'stale');
  });
  it('can show runtime memory when the device cannot measure traffic', async () => {
    await db.pool.query('UPDATE node_native_telemetry SET traffic_available=FALSE,rx_bytes=NULL,tx_bytes=NULL');
    const { body } = await get('/stats/overview');
    assert.equal(body.total_rx_bytes, null);
    assert.equal(body.memory_runtime_sys_bytes, '8192');
    assert.equal(body.traffic.unavailable_nodes, 2);
  });
  it('collects native source metadata and derives rates from actual observation intervals', async () => {
    await sample();
    for (const n of Object.values(NODES)) await advance(n.id);
    await sample();
    const rows = (await get('/stats/timeseries')).body;
    assert.equal(rows.at(-1).rx_bytes, '400');
    assert.equal(rows.at(-1).tx_bytes, '800');
    assert.ok(rows.at(-1).rx_bytes_per_second > 19 && rows.at(-1).rx_bytes_per_second < 21);
    assert.equal(rows.at(-1).memory_usage_pct, null);
    assert.equal(rows.at(-1).memory_runtime_sys_bytes, '8192');
    assert.equal(rows.at(-1).traffic.measured_nodes, 2);
    assert.equal(rows.at(-1).traffic.source, 'wireguard-device');
  });
  it('does not treat repeated copies of one observation as a measured zero rate', async () => {
    await sample();
    await sample();
    assert.equal((await get('/stats/timeseries')).body.at(-1).rx, null);
    assert.equal((await get('/stats/overview')).body.total_bandwidth_rx_mb_s, null);
  });
  it('requires a new baseline after an epoch change even if the counters have already regrown', async () => {
    await sample();
    await db.pool.query(
      'UPDATE node_native_telemetry SET counter_epoch=2,sequence=2,rx_bytes=1000,tx_bytes=2000,received_at=clock_timestamp()'
    );
    await sample();
    assert.equal((await get('/stats/timeseries')).body.at(-1).rx, null);
    assert.equal((await get('/stats/overview')).body.total_bandwidth_tx_mb_s, null);
    for (const n of Object.values(NODES)) await advance(n.id, '2000', '4000');
    await sample();
    assert.ok((await get('/stats/timeseries')).body.at(-1).rx_bytes_per_second > 0);
  });
  it('subtracts counters above signed64 and JavaScript precision before converting the rate', async () => {
    await db.pool.query('UPDATE node_native_telemetry SET rx_bytes=18446744073709551614,tx_bytes=18446744073709551614');
    await sample();
    for (const n of Object.values(NODES)) await advance(n.id, '18446744073709551615', '18446744073709551615');
    await sample();
    const row = (await get('/stats/timeseries')).body.at(-1);
    assert.equal(row.rx_bytes, '36893488147419103230');
    assert.ok(row.rx_bytes_per_second > 0.19 && row.rx_bytes_per_second < 0.21);
  });
  it('withdraws a historical rate from overview when current source generation changes', async () => {
    await sample();
    for (const n of Object.values(NODES)) await advance(n.id);
    await sample();
    assert.ok((await get('/stats/overview')).body.total_bandwidth_rx_bytes_s > 0);
    await db.pool.query('UPDATE node_native_telemetry SET counter_epoch=2');
    assert.equal((await get('/stats/overview')).body.total_bandwidth_rx_bytes_s, null);
    assert.ok((await get('/stats/timeseries')).body.at(-1).rx_bytes_per_second > 0);
  });
  it('does not promote historical legacy rows into native traffic evidence', async () => {
    await db.pool.query(`INSERT INTO node_metric_samples
      (sampled_at,node_id,organization_id,user_id,is_hidden,is_live,is_quarantined,rx_bytes,tx_bytes)
      SELECT NOW()-interval '20 seconds',id,organization_id,user_id,FALSE,TRUE,FALSE,123,456 FROM nodes`);
    await sample();
    const row = (await get('/stats/timeseries')).body.at(-1);
    assert.equal(row.rx, null);
    assert.equal(row.tx, null);
  });
  it('does not freshen a stale observation by collecting it now', async () => {
    await sample();
    await db.pool.query("UPDATE node_native_telemetry SET received_at=NOW()-interval '120 seconds'");
    await sample();
    const row = (await get('/stats/timeseries')).body.at(-1);
    assert.equal(row.rx_bytes, null);
    assert.equal(row.memory_runtime_sys_bytes, null);
    assert.equal(row.rx, null);
    assert.equal(row.traffic.stale_nodes, 2);
  });
  it('filters default-hidden node DTOs and their counts before responding', async () => {
    await db.pool.query('UPDATE compartments SET is_hidden=TRUE WHERE id=$1', [DEFAULT_COMPARTMENT]);
    try {
      const list = await get('/nodes');
      assert.equal(list.status, 200);
      assert.equal(list.body.total, 0);
      assert.deepEqual(list.body.nodes, []);
      assert.equal((await get(`/nodes/${NODES.v1.id}`)).status, 404);
    } finally {
      await db.pool.query('UPDATE compartments SET is_hidden=FALSE WHERE id=$1', [DEFAULT_COMPARTMENT]);
    }
  });
  it('does not expose captured native history or observations after ownership transfer', async () => {
    await sample();
    for (const n of Object.values(NODES)) await advance(n.id);
    await sample();
    await db.pool.query('UPDATE nodes SET organization_id=$2,user_id=$3 WHERE id=$1', [
      NODES.v1.id,
      ORG_B,
      NODES.b1.user
    ]);
    const overview = (await get('/stats/overview', 'ownerB')).body;
    assert.equal(overview.total_rx_bytes, null);
    assert.equal(overview.traffic.unknown_nodes, 1);
    const node = (await get(`/nodes/${NODES.v1.id}`, 'ownerB')).body.node;
    assert.equal(node.rx_bytes, null);
    assert.equal((await get(`/nodes/${NODES.v1.id}`)).status, 404);
    assert.equal((await get('/stats/timeseries', 'ownerB')).body.at(-1).rx_bytes, '200');
  });
  it('resolves current account scope for node telemetry despite an older token claim', async () => {
    await db.pool.query("UPDATE users SET organization_id=$1 WHERE id='usr-sec-owner'", [ORG_B]);
    await db.pool.query(
      "INSERT INTO memberships (id,user_id,organization_id,role) VALUES ('native-moved-owner','usr-sec-owner',$1,'owner')",
      [ORG_B]
    );
    try {
      assert.equal((await get(`/nodes/${NODES.v1.id}`)).status, 404);
      const list = (await get('/nodes')).body;
      assert.deepEqual(
        list.nodes.map((n) => n.id),
        [NODES.b1.id]
      );
    } finally {
      await db.pool.query("DELETE FROM memberships WHERE id='native-moved-owner'");
      await db.pool.query("UPDATE users SET organization_id=$1 WHERE id='usr-sec-owner'", [ORG_A]);
    }
  });
  it('does not attach a new owners observation to an already authorized old node DTO', async () => {
    const telemetry = require('../services/NativeTelemetry');
    const original = telemetry.readForNodes;
    telemetry.readForNodes = async (...args) => {
      await db.pool.query('UPDATE nodes SET organization_id=$2,user_id=$3 WHERE id=$1', [
        NODES.v1.id,
        ORG_B,
        NODES.b1.user
      ]);
      await seedNative(db.pool, NODES.v1.id, { rx: '99999', tx: '88888' });
      return original(...args);
    };
    try {
      const response = await get(`/nodes/${NODES.v1.id}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.node.rx_bytes, null);
      assert.equal(response.body.node.native_telemetry.status, 'unknown');
    } finally {
      telemetry.readForNodes = original;
    }
  });
});
