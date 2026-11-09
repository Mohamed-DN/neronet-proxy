// Console v2 (T4): the API tells the truth about what a node has not reported, says what kind
// of device a row is, and tells the browser the caller's role inside their organisation.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

const key = () => crypto.randomBytes(32).toString('base64');

describe('console v2 T4: honest node fields and organisation role', () => {
  let dbHelper;
  let pool;
  let app;
  let adminToken;
  let memberToken;
  let ownerToken;
  const orgId = 'org-truth-a';
  const gatewayKey = key();

  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'Truth A', 'truth-a', 'deny')
       ON CONFLICT (id) DO NOTHING`,
      [orgId]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-truth-admin', 'truthadmin', 'ta@truth.local', 'x', 'admin', $1),
         ('usr-truth-member', 'truthmember', 'tm@truth.local', 'x', 'user', $1),
         ('usr-truth-owner', 'truthowner', 'to@truth.local', 'x', 'super-admin', $1)
       ON CONFLICT (id) DO NOTHING`,
      [orgId]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-truth-admin', 'usr-truth-admin', $1, 'admin'),
         ('mem-truth-member', 'usr-truth-member', $1, 'member'),
         ('mem-truth-owner', 'usr-truth-owner', $1, 'owner')
       ON CONFLICT (id) DO NOTHING`,
      [orgId]
    );
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
       VALUES ('node-truth-gw', $1, 'usr-truth-admin', 'gw', '100.64.40.1', 'fd00:40::1', $2, 'RELAY', TRUE, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [orgId, gatewayKey]
    );
    const token = (id, username, role) =>
      issueConsoleTestToken({ sub: id, id, username, role, organization_id: orgId });
    adminToken = await token('usr-truth-admin', 'truthadmin', 'admin');
    memberToken = await token('usr-truth-member', 'truthmember', 'user');
    ownerToken = await token('usr-truth-owner', 'truthowner', 'super-admin');
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM nodes WHERE device_kind = 'profile'");
    await pool.query("UPDATE nodes SET profile_gateway_endpoint = NULL WHERE id = 'node-truth-gw'");
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('a node that never reported has null latency, jitter, cpu, battery and last_seen_at', async () => {
    // The columns default to 0 and 100, so a row that never heartbeat holds numbers nobody measured.
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
       VALUES ('node-truth-silent', $1, 'usr-truth-admin', 'silent', '100.64.40.2', 'fd00:40::2', $2, 'CLIENT_ORIGIN', TRUE, FALSE)`,
      [orgId, key()]
    );

    const res = await request(app).get('/api/nodes/node-truth-silent').set(auth(adminToken));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.node.latency_ms, null, 'latency was invented (the old fallback was 15)');
    assert.strictEqual(res.body.node.jitter_ms, null, 'jitter was invented (the old value was 1)');
    assert.strictEqual(res.body.node.cpu_usage_pct, null, 'cpu was invented (the old fallback was 0)');
    assert.strictEqual(res.body.node.battery_pct, null, 'battery was invented (the old fallback was 100)');
    assert.strictEqual(res.body.node.last_seen_at, null, 'last_seen_at fell back to created_at');
  });

  it('a node that reported keeps the values it measured', async () => {
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined,
                          latency_ms, cpu_usage_pct, battery_pct, last_heartbeat)
       VALUES ('node-truth-live', $1, 'usr-truth-admin', 'live', '100.64.40.3', 'fd00:40::3', $2, 'CLIENT_ORIGIN', TRUE, FALSE,
               12.5, 37, 55, NOW())`,
      [orgId, key()]
    );

    const node = (await request(app).get('/api/nodes/node-truth-live').set(auth(adminToken))).body.node;

    assert.strictEqual(node.latency_ms, 12.5);
    assert.strictEqual(node.cpu_usage_pct, 37);
    assert.strictEqual(node.battery_pct, 55);
    assert.ok(node.last_seen_at, 'a reporting node has a last_seen_at');
    await pool.query("DELETE FROM nodes WHERE id = 'node-truth-live'");
  });

  it('a profile device is listed with device_kind profile', async () => {
    await request(app)
      .put('/api/devices/gateway')
      .set(auth(adminToken))
      .send({ node_id: 'node-truth-gw', endpoint: 'gw.example:51820' });
    const reg = await request(app)
      .post('/api/devices/profile')
      .set(auth(memberToken))
      .send({ name: 'phone', public_key: key(), preshared_key: key() });
    assert.strictEqual(reg.status, 201);

    const list = await request(app).get('/api/nodes?limit=200').set(auth(adminToken));
    const device = list.body.nodes.find((n) => n.id === reg.body.device_id);

    assert.ok(device, 'the profile device is in the device list');
    assert.strictEqual(device.device_kind, 'profile');
  });

  it('a mesh node is labelled device_kind mesh', async () => {
    const node = (await request(app).get('/api/nodes/node-truth-gw').set(auth(adminToken))).body.node;

    assert.strictEqual(node.device_kind, 'mesh');
  });

  it('the gateway node carries profile_gateway_endpoint, and other nodes carry null', async () => {
    await request(app)
      .put('/api/devices/gateway')
      .set(auth(adminToken))
      .send({ node_id: 'node-truth-gw', endpoint: 'gw.example:51820' });

    const gateway = (await request(app).get('/api/nodes/node-truth-gw').set(auth(adminToken))).body.node;
    assert.strictEqual(gateway.profile_gateway_endpoint, 'gw.example:51820');

    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
       VALUES ('node-truth-plain', $1, 'usr-truth-admin', 'plain', '100.64.40.4', 'fd00:40::4', $2, 'CLIENT_ORIGIN', TRUE, FALSE)`,
      [orgId, key()]
    );
    const plain = (await request(app).get('/api/nodes/node-truth-plain').set(auth(adminToken))).body.node;
    assert.strictEqual(plain.profile_gateway_endpoint, null);
    await pool.query("DELETE FROM nodes WHERE id = 'node-truth-plain'");
  });

  it('/api/auth/me returns org_role from the membership', async () => {
    const member = await request(app).get('/api/auth/me').set(auth(memberToken));
    assert.strictEqual(member.status, 200);
    assert.strictEqual(member.body.user.org_role, 'member');

    const owner = await request(app).get('/api/auth/me').set(auth(ownerToken));
    assert.strictEqual(owner.status, 200);
    assert.strictEqual(owner.body.user.org_role, 'owner');
  });

  it('/api/auth/me returns org_role null when the user has no membership', async () => {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-truth-nomem', 'truthnomem', 'tn@truth.local', 'x', 'user', $1) ON CONFLICT (id) DO NOTHING`,
      [orgId]
    );
    const token = await issueConsoleTestToken({
      sub: 'usr-truth-nomem',
      id: 'usr-truth-nomem',
      username: 'truthnomem',
      role: 'user',
      organization_id: orgId
    });

    const res = await request(app).get('/api/auth/me').set(auth(token));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.org_role, null, 'no membership means no invented role');
  });
});
