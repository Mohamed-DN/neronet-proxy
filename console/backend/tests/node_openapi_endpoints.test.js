const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const crypto = require('crypto');

const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');
const { generateCurve25519Keypair } = require('../utils/crypto');
const { signToken } = require('../middleware/auth');

describe('WP-405: OpenAPI 3.1.0 Node Management Endpoints', () => {
  let dbHelper;
  let app;
  let adminUser;
  let adminToken;
  let testNodeId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();

    const adminRes = await dbHelper.pool.query(
      "SELECT id, username, role FROM users WHERE role = 'super-admin' LIMIT 1"
    );
    adminUser = adminRes.rows[0];
    adminToken = signToken(adminUser);

    testNodeId = `node-test-${crypto.randomBytes(4).toString('hex')}`;
    const kp = generateCurve25519Keypair();

    await dbHelper.pool.query(
      `INSERT INTO nodes (
        id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6, role,
        ip_class, country_code, city, asn, endpoints, onion_routing_enabled,
        onion_hops, kill_switch_enabled, is_healthy, is_quarantined, latency_ms,
        created_at, updated_at
      ) VALUES (
        $1, $2, (SELECT id FROM organizations LIMIT 1), 'node-alpha', $3, '10.200.0.99', 'fd00:beef::99', 'CLIENT_ORIGIN',
        'UNKNOWN', 'IT', 'Rome', 0, '[]'::jsonb, FALSE,
        0, FALSE, TRUE, FALSE, 14.5,
        NOW(), NOW()
      )`,
      [testNodeId, adminUser.id, kp.publicKeyBase64]
    );
  });

  after(async () => {
    if (dbHelper) {
      await dbHelper.cleanup();
    }
  });

  it('1. POST /api/nodes/:id/quarantine puts node in quarantine and writes reason', async () => {
    const res = await request(app)
      .post(`/api/nodes/${testNodeId}/quarantine`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Suspicious outbound DNS beaconing' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.result.is_quarantined, true);
    assert.strictEqual(res.body.result.status, 'quarantined');

    const check = await dbHelper.pool.query('SELECT is_quarantined, quarantine_reason FROM nodes WHERE id = $1', [
      testNodeId
    ]);
    assert.strictEqual(check.rows[0].is_quarantined, true);
    assert.strictEqual(check.rows[0].quarantine_reason, 'Suspicious outbound DNS beaconing');
  });

  it('2. POST /api/nodes/:id/unquarantine restores node to active', async () => {
    const res = await request(app)
      .post(`/api/nodes/${testNodeId}/unquarantine`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.result.is_quarantined, false);
    assert.strictEqual(res.body.result.status, 'active');

    const check = await dbHelper.pool.query('SELECT is_quarantined, quarantine_reason FROM nodes WHERE id = $1', [
      testNodeId
    ]);
    assert.strictEqual(check.rows[0].is_quarantined, false);
    assert.strictEqual(check.rows[0].quarantine_reason, null);
  });

  it('3. POST /api/nodes/:id/revoke revokes node key permanently and removes node', async () => {
    const res = await request(app)
      .post(`/api/nodes/${testNodeId}/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Hardware decommissioned' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);

    const checkNode = await dbHelper.pool.query('SELECT id FROM nodes WHERE id = $1', [testNodeId]);
    assert.strictEqual(checkNode.rows.length, 0);

    const checkRev = await dbHelper.pool.query('SELECT reason FROM revoked_keys WHERE node_id = $1', [testNodeId]);
    assert.strictEqual(checkRev.rows.length, 1);
    assert.strictEqual(checkRev.rows[0].reason, 'Hardware decommissioned');
  });
});
