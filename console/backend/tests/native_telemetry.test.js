const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { nodeKey, register } = require('./helpers/nodeEnrolment');
const { seedHiddenTier, tokens, ORG_A, ORG_B, NODES } = require('./helpers/hiddenTier');
const { createApp } = require('../server');
const config = require('../config/env');

describe('Authenticated native telemetry snapshots', () => {
  let db;
  let app;
  let adminToken;
  before(async () => {
    db = await setupTestDatabase();
    app = createApp();
    const { rows } = await db.pool.query("SELECT id FROM users WHERE role='super-admin' LIMIT 1");
    adminToken = jwt.sign({ id: rows[0].id, sub: rows[0].id, role: 'super-admin' }, config.JWT_SECRET);
  });
  after(async () => {
    if (db) await db.cleanup();
  });
  async function enrol(key = nodeKey()) {
    const res = await register(app, { public_key_hex: key, role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.equal(res.status, 200);
    return {
      key,
      id: res.body.assigned_node_id,
      credential: res.body.credential,
      session: res.body.telemetry_session || crypto.randomUUID(),
      response: res.body
    };
  }
  const payload = (node, overrides = {}) => ({
    version: 1,
    session_id: node.session,
    sequence: '1',
    counter_epoch: '1',
    source: 'wireguard-device',
    traffic_available: true,
    rx_bytes: '1024',
    tx_bytes: '2048',
    memory_runtime_sys_bytes: '12345678',
    ...overrides
  });
  const beat = (node, telemetry, credential = node.credential) => {
    let req = request(app).post('/v4/control/heartbeat');
    if (credential) req = req.set('Authorization', `Bearer ${credential}`);
    return req.send({ node_id: node.id, telemetry });
  };
  const get = (token = adminToken) =>
    request(app).get('/api/stats/native-telemetry').set('Authorization', `Bearer ${token}`);
  async function sample(node) {
    const response = await get();
    assert.equal(response.status, 200);
    const found = response.body.nodes.find((row) => row.node_id === node.id);
    assert.ok(found, 'visible node missing from native telemetry');
    return found;
  }

  it('issues a distinct server session on every authenticated registration', async () => {
    const a = await enrol();
    assert.match(a.response.telemetry_session || '', /^[0-9a-f-]{36}$/);
    const b = await enrol(a.key);
    assert.notEqual(a.response.telemetry_session, b.response.telemetry_session);
  });
  it('persists exact cumulative counters and byte units instead of adding snapshots', async () => {
    const n = await enrol();
    assert.equal((await beat(n, payload(n))).status, 200);
    assert.equal((await beat(n, payload(n, { sequence: '2', rx_bytes: '2048' }))).status, 200);
    const row = await sample(n);
    assert.equal(row.rx_bytes, '2048');
    assert.equal(row.tx_bytes, '2048');
    assert.equal(row.memory_runtime_sys_bytes, '12345678');
    assert.equal(row.memory_usage_pct, null);
    assert.equal(row.source, 'wireguard-device');
    assert.equal(row.status, 'fresh');
  });
  it('keeps integers above JavaScript precision and signed 64-bit range exact', async () => {
    const n = await enrol();
    const exact = '18446744073709551615';
    assert.equal((await beat(n, payload(n, { rx_bytes: exact, tx_bytes: exact, sequence: exact }))).status, 200);
    assert.equal((await sample(n)).rx_bytes, exact);
    assert.equal((await sample(n)).sequence, exact);
  });
  it('deduplicates retries without advancing observation freshness', async () => {
    const n = await enrol();
    const body = payload(n);
    assert.equal((await beat(n, body)).status, 200);
    const before = await sample(n);
    assert.equal((await beat(n, body)).status, 200);
    const after = await sample(n);
    assert.equal(after.received_at, before.received_at);
    assert.equal(after.rx_bytes, '1024');
    assert.equal((await beat(n, { ...body, rx_bytes: '9999' })).status, 409);
  });
  it('rejects older sequences and counter rollback within an epoch', async () => {
    const n = await enrol();
    assert.equal((await beat(n, payload(n, { sequence: '2' }))).status, 200);
    assert.equal((await beat(n, payload(n))).status, 409);
    assert.equal((await beat(n, payload(n, { sequence: '3', rx_bytes: '1' }))).status, 409);
    assert.equal((await sample(n)).sequence, '2');
  });
  it('allows an explicit newer counter epoch and refuses replay of its predecessor', async () => {
    const n = await enrol();
    assert.equal((await beat(n, payload(n))).status, 200);
    assert.equal((await beat(n, payload(n, { sequence: '2', counter_epoch: '2', rx_bytes: '1' }))).status, 200);
    assert.equal((await beat(n, payload(n, { sequence: '3' }))).status, 409);
    assert.equal((await sample(n)).counter_epoch, '2');
  });
  it('invalidates old sessions on re-enrolment and exposes unknown until a new observation', async () => {
    const n = await enrol();
    assert.equal((await beat(n, payload(n))).status, 200);
    const newer = await enrol(n.key);
    const conflict = await beat(newer, payload(n));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'native_telemetry_session_changed');
    assert.equal((await sample(newer)).status, 'unknown');
    assert.equal((await sample(newer)).rx_bytes, null);
    assert.equal((await beat(newer, payload(newer))).status, 200);
  });
  it('does not accept a snapshot through the development authentication bypass', async () => {
    const n = await enrol();
    assert.equal((await beat(n, payload(n), null)).status, 401);
  });
  it('rejects a credential for a different node', async () => {
    const a = await enrol();
    const b = await enrol();
    assert.equal((await beat(a, payload(a), b.credential)).status, 403);
  });
  it('marks absent data plane measurements unknown, preserving measured runtime memory', async () => {
    const n = await enrol();
    const body = payload(n, { traffic_available: false });
    delete body.rx_bytes;
    delete body.tx_bytes;
    assert.equal((await beat(n, body)).status, 200);
    const row = await sample(n);
    assert.equal(row.rx_bytes, null);
    assert.equal(row.tx_bytes, null);
    assert.equal(row.memory_runtime_sys_bytes, '12345678');
    assert.equal(row.traffic_available, false);
  });
  for (const invalid of ['18446744073709551616', '-1', '1.5', '01', 9007199254740992]) {
    it(`rejects noncanonical or out-of-range counter ${invalid}`, async () => {
      const n = await enrol();
      assert.equal((await beat(n, payload(n, { rx_bytes: invalid }))).status, 400);
    });
  }
  it('keeps an unmodified legacy heartbeat compatible without fabricating native data', async () => {
    const n = await enrol();
    const response = await request(app)
      .post('/v4/control/heartbeat')
      .set('Authorization', `Bearer ${n.credential}`)
      .send({ node_id: n.id });
    assert.equal(response.status, 200);
    assert.equal((await sample(n)).status, 'unknown');
  });
  it('keeps watermark and freshness after a new app instance, independent of Valkey', async () => {
    const n = await enrol();
    assert.equal((await beat(n, payload(n))).status, 200);
    const first = await sample(n);
    app = createApp();
    assert.equal((await beat(n, payload(n))).status, 200);
    assert.equal((await sample(n)).received_at, first.received_at);
  });
  it('keeps duplicate delivery stale instead of making an old observation fresh', async () => {
    const n = await enrol();
    const body = payload(n);
    assert.equal((await beat(n, body)).status, 200);
    await db.pool.query("UPDATE node_native_telemetry SET received_at=NOW()-interval '61 seconds' WHERE node_id=$1", [
      n.id
    ]);
    assert.equal((await beat(n, body)).status, 200);
    const row = await sample(n);
    assert.equal(row.status, 'stale');
    assert.equal(row.rx_bytes, '1024');
  });
  it('serializes simultaneous retries and refuses a late smaller sequence', async () => {
    const n = await enrol();
    const replies = await Promise.all([beat(n, payload(n)), beat(n, payload(n))]);
    assert.deepEqual(
      replies.map((r) => r.status),
      [200, 200]
    );
    const newer = await Promise.all([beat(n, payload(n, { sequence: '2' })), beat(n, payload(n, { sequence: '3' }))]);
    assert.equal(newer[1].status, 200);
    assert.ok([200, 409].includes(newer[0].status));
    assert.equal((await sample(n)).sequence, '3');
  });
  it('rechecks credential revocation after waiting for the lifecycle lock', async () => {
    const n = await enrol();
    const lock = await db.pool.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(7429149)');
    let pending;
    try {
      pending = beat(n, payload(n)).then((response) => response);
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = await db.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock_shared%'"
        );
        if (result.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(waiting, 'request did not reach its transaction lock');
      await lock.query('UPDATE node_credentials SET revoked_at=NOW() WHERE node_id=$1', [n.id]);
      await lock.query('COMMIT');
      assert.equal((await pending).status, 401);
      assert.equal((await sample(n)).status, 'unknown');
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      if (pending) await pending;
    }
  });
  it('does not expose native snapshots after a tenant or owner transfer', async () => {
    const n = await enrol();
    assert.equal((await beat(n, payload(n))).status, 200);
    await seedHiddenTier(db.pool);
    await db.pool.query('UPDATE nodes SET organization_id=$2, user_id=$3 WHERE id=$1', [n.id, ORG_A, NODES.v2.user]);
    const old = await sample(n);
    assert.equal(old.rx_bytes, null);
    assert.equal((await beat(n, payload(n, { sequence: '2' }))).status, 409);
    const auth = tokens();
    const response = await get(auth.ownerB);
    assert.equal(response.status, 200);
    assert.ok(!response.body.nodes.some((row) => row.node_id === n.id));
    await db.pool.query('UPDATE nodes SET organization_id=$2 WHERE id=$1', [n.id, ORG_B]);
  });
  it('filters hidden compartments and current member scope before exposing even unknown rows', async () => {
    const auth = tokens();
    const own = await get(auth.owner);
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.nodes.map((n) => n.node_id).sort(), [NODES.v1.id, NODES.v2.id].sort());
    const member = await get(auth.member);
    assert.deepEqual(
      member.body.nodes.map((n) => n.node_id),
      [NODES.v2.id]
    );
    const root = await get(auth.rootOwner);
    assert.equal(root.body.nodes.length, 3);
    await db.pool.query("UPDATE users SET status='revoked' WHERE id='usr-sec-owner'");
    try {
      assert.equal((await get(auth.owner)).status, 403);
    } finally {
      await db.pool.query("UPDATE users SET status='active' WHERE id='usr-sec-owner'");
    }
  });
});
