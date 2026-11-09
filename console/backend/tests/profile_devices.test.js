// ADR 0029, phase A1: profile devices join through a gateway with a standard WireGuard
// profile. The device's private key never reaches the server: the caller sends the public
// key (and the PSK the gateway must know), and gets back what the profile needs.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { settleAuditWrites } = require('../utils/audit');
const { createApp } = require('../server');

const key = () => crypto.randomBytes(32).toString('base64');

describe('ADR 0029 A1: profile devices through a gateway', () => {
  let dbHelper;
  let pool;
  let app;
  let adminToken;
  let memberToken;
  let otherAdminToken;
  const orgA = 'org-prof-a';
  const orgB = 'org-prof-b';
  const gatewayKey = key();

  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const register = (token, body) => request(app).post('/api/devices/profile').set(auth(token)).send(body);
  const setGateway = (token, body) => request(app).put('/api/devices/gateway').set(auth(token)).send(body);

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ($1, 'Prof A', 'prof-a', 'deny'), ($2, 'Prof B', 'prof-b', 'deny') ON CONFLICT (id) DO NOTHING`,
      [orgA, orgB]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-prof-admin', 'profadmin', 'pa@prof.local', 'x', 'admin', $1),
         ('usr-prof-member', 'profmember', 'pm@prof.local', 'x', 'user', $1),
         ('usr-prof-badmin', 'profbadmin', 'pb@prof.local', 'x', 'admin', $2)
       ON CONFLICT (id) DO NOTHING`,
      [orgA, orgB]
    );
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
       VALUES ('node-prof-gw', $1, 'usr-prof-admin', 'gw', '100.64.30.1', 'fd00:30::1', $2, 'RELAY', TRUE, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [orgA, gatewayKey]
    );
    const token = (id, username, role, org) =>
      issueConsoleTestToken({ sub: id, id, username, role, organization_id: org });
    adminToken = await token('usr-prof-admin', 'profadmin', 'admin', orgA);
    memberToken = await token('usr-prof-member', 'profmember', 'user', orgA);
    otherAdminToken = await token('usr-prof-badmin', 'profbadmin', 'admin', orgB);
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM nodes WHERE device_kind = 'profile'");
    await pool.query('UPDATE nodes SET profile_gateway_endpoint = NULL');
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('refuses a device while the organisation has no gateway', async () => {
    const res = await register(memberToken, { name: 'phone', public_key: key(), preshared_key: key() });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'no_profile_gateway');
  });

  it('lets only an administrator name the gateway, and only a node of their organisation', async () => {
    assert.strictEqual(
      (await setGateway(memberToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      403
    );
    assert.strictEqual(
      (await setGateway(otherAdminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      404
    );
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'not an endpoint' })).status,
      400
    );
    const ok = await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.gateway.endpoint, 'gw.example:51820');
  });

  it('registers a device from its public key and answers with what the profile needs, never a private key', async () => {
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      200
    );
    const pub = key();
    const psk = key();
    const res = await register(memberToken, { name: 'phone', public_key: pub, preshared_key: psk });
    assert.strictEqual(res.status, 201);
    assert.match(res.body.device_id, /^dev-[0-9a-f]{12}$/);
    assert.match(res.body.overlay_ipv4, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/);
    assert.deepStrictEqual(res.body.gateway, { public_key: gatewayKey, endpoint: 'gw.example:51820' });
    assert.deepStrictEqual(res.body.allowed_ips, ['100.64.0.0/10']);
    assert.ok(res.body.console_url.startsWith('https://'));
    assert.ok(!/private/i.test(JSON.stringify(res.body)), 'no private key field in the answer');
    assert.ok(!JSON.stringify(res.body).includes(psk), 'the PSK is not echoed back');

    const row = (
      await pool.query(
        'SELECT device_kind, public_key, preshared_key, organization_id, user_id FROM nodes WHERE id = $1',
        [res.body.device_id]
      )
    ).rows[0];
    assert.deepStrictEqual(row, {
      device_kind: 'profile',
      public_key: pub,
      preshared_key: psk,
      organization_id: orgA,
      user_id: 'usr-prof-member'
    });
  });

  it('refuses keys that are not 32 bytes and a public key already in use', async () => {
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      200
    );
    const short = crypto.randomBytes(16).toString('base64');
    assert.strictEqual(
      (await register(memberToken, { name: 'p', public_key: short, preshared_key: key() })).status,
      400
    );
    assert.strictEqual(
      (await register(memberToken, { name: 'p', public_key: key(), preshared_key: 'nope' })).status,
      400
    );
    assert.strictEqual(
      (await register(memberToken, { name: '', public_key: key(), preshared_key: key() })).status,
      400
    );
    assert.strictEqual(
      (await register(memberToken, { name: 'p', public_key: gatewayKey, preshared_key: key() })).status,
      409
    );
  });

  it('audits the new device without its PSK', async () => {
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      200
    );
    const psk = key();
    const res = await register(memberToken, { name: 'laptop', public_key: key(), preshared_key: psk });
    assert.strictEqual(res.status, 201);
    await settleAuditWrites();
    const rows = (
      await pool.query(
        "SELECT message, metadata_json FROM audit_events WHERE event_type = 'PROFILE_DEVICE_CREATED' AND target_id = $1",
        [res.body.device_id]
      )
    ).rows;
    assert.strictEqual(rows.length, 1);
    assert.ok(!JSON.stringify(rows[0]).includes(psk));
  });

  it('moves the netmap version so the gateway learns the device', async () => {
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      200
    );
    const before = Number((await pool.query("SELECT epoch FROM mesh_epochs WHERE name='netmap'")).rows[0].epoch);
    assert.strictEqual(
      (await register(memberToken, { name: 'p', public_key: key(), preshared_key: key() })).status,
      201
    );
    const after = Number((await pool.query("SELECT epoch FROM mesh_epochs WHERE name='netmap'")).rows[0].epoch);
    assert.ok(after > before);
  });
});
