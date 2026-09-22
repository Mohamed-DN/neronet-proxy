const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const config = require('../config/env');

/**
 * WP-206: Onion Routing End-to-End & Per-Organization Enforcement
 *
 * Requirements:
 *  1. Per-org toggle for onion routing (organization_modules table)
 *  2. Regulated organization profile blocks onion routing
 *  3. POST /circuit enforces per-org toggle (403 when disabled)
 *  4. POST /api/nodes/:id/action toggle_onion enforces per-org toggle (403 when disabled)
 *  5. 3-hop circuit structure verification with 1420-byte cell compatibility
 */

describe('WP-206: Onion Routing End-to-End & Per-Org Controls', () => {
  let dbHelper;
  let pool;
  let app;

  let standardOrgId;
  let disabledOrgId;
  let regulatedOrgId;

  let standardNodeId;
  let disabledNodeId;
  let regulatedNodeId;

  let adminToken;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    // 1. Create three organizations
    standardOrgId = 'org-onion-allowed';
    disabledOrgId = 'org-onion-disabled';
    regulatedOrgId = 'org-regulated-profile';

    await pool.query(
      `INSERT INTO organizations (id, name, slug, profile)
       VALUES
         ($1, 'Allowed Org', 'allowed-org', 'standard'),
         ($2, 'Disabled Org', 'disabled-org', 'standard'),
         ($3, 'Regulated Org', 'regulated-org', 'regulated')
       ON CONFLICT (id) DO NOTHING`,
      [standardOrgId, disabledOrgId, regulatedOrgId]
    );

    // 2. Set module status in organization_modules
    await pool.query(
      `INSERT INTO organization_modules (organization_id, module_id, enabled)
       VALUES
         ($1, 'onion', TRUE),
         ($2, 'onion', FALSE),
         ($3, 'onion', TRUE)
       ON CONFLICT (organization_id, module_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [standardOrgId, disabledOrgId, regulatedOrgId]
    );

    // 3. Create a test admin user and JWT
    const adminUserId = 'user-admin-onion';
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role)
       VALUES ($1, 'admin_onion', 'admin_onion@example.com', 'x', 'super-admin')
       ON CONFLICT (id) DO NOTHING`,
      [adminUserId]
    );

    adminToken = jwt.sign(
      {
        sub: adminUserId,
        id: adminUserId,
        username: 'admin_onion',
        role: 'super-admin',
        organization_id: standardOrgId,
        compartment_access: 'standard'
      },
      config.JWT_SECRET
    );

    // 4. Create healthy relays for circuit construction (need at least 3: 2 RELAYs + 1 EXIT_BRIDGE)
    for (let i = 1; i <= 3; i++) {
      const relayId = `relay-onion-node-${i}`;
      const pubKey = crypto.randomBytes(32).toString('hex');
      const role = i === 3 ? 'EXIT_BRIDGE' : 'RELAY';
      await pool.query(
        `INSERT INTO nodes (id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6, role, is_healthy, is_quarantined, endpoints)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, FALSE, '["127.0.0.1:51820"]')
         ON CONFLICT (id) DO NOTHING`,
        [relayId, adminUserId, standardOrgId, `Relay ${i}`, pubKey, `100.64.10.${i}`, `fd7a:115c:a1e0::10:${i}`, role]
      );
    }

    // 5. Create test client nodes for each organization
    standardNodeId = 'node-client-allowed';
    disabledNodeId = 'node-client-disabled';
    regulatedNodeId = 'node-client-regulated';

    await pool.query(
      `INSERT INTO nodes (id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6, role, is_healthy, is_quarantined)
       VALUES
         ($1, $4, $5, 'Client Allowed', $7, '100.64.20.1', 'fd7a:115c:a1e0::20:1', 'CLIENT_ORIGIN', TRUE, FALSE),
         ($2, $4, $6, 'Client Disabled', $8, '100.64.20.2', 'fd7a:115c:a1e0::20:2', 'CLIENT_ORIGIN', TRUE, FALSE),
         ($3, $4, $9, 'Client Regulated', $10, '100.64.20.3', 'fd7a:115c:a1e0::20:3', 'CLIENT_ORIGIN', TRUE, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [
        standardNodeId,
        disabledNodeId,
        regulatedNodeId,
        adminUserId,
        standardOrgId,
        disabledOrgId,
        crypto.randomBytes(32).toString('hex'),
        crypto.randomBytes(32).toString('hex'),
        regulatedOrgId,
        crypto.randomBytes(32).toString('hex')
      ]
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('POST /v4/control/circuit per-org enforcement', () => {
    it('successfully builds a 3-hop circuit for an org with onion enabled', async () => {
      const res = await request(app).post('/v4/control/circuit').send({
        node_id: standardNodeId,
        target_country: 'US',
        hop_count: 3
      });

      assert.strictEqual(res.status, 200, `Expected 200, got: ${res.status} ${JSON.stringify(res.body)}`);
      assert.ok(res.body.circuit_id, 'Circuit must contain circuit_id');
      assert.strictEqual(res.body.hops.length, 3, 'Must return exactly 3 hops');
    });

    it('rejects circuit request with 403 when onion module is disabled for the org', async () => {
      const res = await request(app).post('/v4/control/circuit').send({
        node_id: disabledNodeId,
        target_country: 'US',
        hop_count: 3
      });

      assert.strictEqual(res.status, 403);
      assert.ok(
        res.body.error.includes('disabled for this organization'),
        `Error must mention disabled: ${res.body.error}`
      );
    });

    it('rejects circuit request with 403 when org has regulated profile', async () => {
      const res = await request(app).post('/v4/control/circuit').send({
        node_id: regulatedNodeId,
        target_country: 'US',
        hop_count: 3
      });

      assert.strictEqual(res.status, 403);
      assert.ok(
        res.body.error.includes('disabled for this organization'),
        `Error must mention disabled: ${res.body.error}`
      );
    });
  });

  describe('Node action toggle_onion / set_onion per-org enforcement', () => {
    it('allows enabling onion routing on a node in an allowed organization', async () => {
      const res = await request(app)
        .post(`/api/nodes/${standardNodeId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'set_onion', enabled: true });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.onion_routing_enabled, true);
      assert.strictEqual(res.body.onion_hops, 3);
    });

    it('rejects enabling onion routing with 403 on a node in a disabled organization', async () => {
      const res = await request(app)
        .post(`/api/nodes/${disabledNodeId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'set_onion', enabled: true });

      assert.strictEqual(res.status, 403);
      assert.ok(
        res.body.error.includes('disabled for this organization'),
        `Expected 403 forbidden with org message: ${res.body.error}`
      );
    });

    it('rejects enabling onion routing with 403 on a node in a regulated organization', async () => {
      const res = await request(app)
        .post(`/api/nodes/${regulatedNodeId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'toggle_onion', enabled: true });

      assert.strictEqual(res.status, 403);
      assert.ok(
        res.body.error.includes('disabled for this organization'),
        `Expected 403 forbidden with org message: ${res.body.error}`
      );
    });

    it('allows disabling onion routing even if the org has onion disabled', async () => {
      // Disabling must always be permitted (safe direction)
      const res = await request(app)
        .post(`/api/nodes/${disabledNodeId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'set_onion', enabled: false });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.onion_routing_enabled, false);
      assert.strictEqual(res.body.onion_hops, 0);
    });
  });
});
