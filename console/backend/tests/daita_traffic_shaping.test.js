const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const config = require('../config/env');
const NetmapService = require('../services/NetmapService');
const OrgService = require('../services/OrgService');

describe('WP-209: DAITA Anti-AI Traffic Fingerprinting & Shaping', () => {
  let dbHelper;
  let pool;
  let app;

  let testOrgId;
  let nodeAId;
  let nodeBId;
  let nodeCId;

  let userToken;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    testOrgId = 'org-daita-shaping';
    await pool.query(
      `INSERT INTO organizations (id, name, slug, profile, default_daita_mode)
       VALUES ($1, 'DAITA Org', 'daita-org', 'standard', 'off')
       ON CONFLICT (id) DO NOTHING`,
      [testOrgId]
    );

    // Create admin user for the org
    const userId = 'usr-daita-admin';
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, 'daitaadmin', 'admin@daita.net', 'hash', 'admin', $2)
       ON CONFLICT (id) DO NOTHING`,
      [userId, testOrgId]
    );

    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-daitaadmin', $1, $2, 'owner')
       ON CONFLICT (user_id, organization_id) DO NOTHING`,
      [userId, testOrgId]
    );

    userToken = jwt.sign(
      {
        id: userId,
        username: 'daitaadmin',
        role: 'admin',
        organization_id: testOrgId
      },
      config.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Create 3 nodes in this org
    nodeAId = 'node-daita-alpha';
    nodeBId = 'node-daita-beta';
    nodeCId = 'node-daita-gamma';

    const pubA = crypto.randomBytes(32).toString('hex');
    const pubB = crypto.randomBytes(32).toString('hex');
    const pubC = crypto.randomBytes(32).toString('hex');

    await pool.query(
      `INSERT INTO nodes (
        id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6,
        role, is_healthy, is_quarantined, daita_mode, endpoints
      ) VALUES
        ($1, $4, $5, 'DAITA Alpha', $6, '100.64.1.10', 'fd00::1:10', 'CLIENT_ORIGIN', TRUE, FALSE, 'off', '["192.168.1.10:51820"]'::jsonb),
        ($2, $4, $5, 'DAITA Beta', $7, '100.64.1.20', 'fd00::1:20', 'CLIENT_ORIGIN', TRUE, FALSE, 'off', '["192.168.1.20:51820"]'::jsonb),
        ($3, $4, $5, 'DAITA Gamma', $8, '100.64.1.30', 'fd00::1:30', 'CLIENT_ORIGIN', TRUE, FALSE, 'off', '["192.168.1.30:51820"]'::jsonb)
      ON CONFLICT (id) DO NOTHING`,
      [nodeAId, nodeBId, nodeCId, userId, testOrgId, pubA, pubB, pubC]
    );
  });

  it('1. updates organization default_daita_mode and rejects invalid modes', async () => {
    // Valid update to balanced
    const updated = await OrgService.updateOrganization(
      testOrgId,
      { default_daita_mode: 'balanced' },
      { id: 'system', username: 'system' }
    );
    assert.strictEqual(updated.default_daita_mode, 'balanced');

    // Valid update to paranoid
    const updatedParanoid = await OrgService.updateOrganization(
      testOrgId,
      { default_daita_mode: 'paranoid' },
      { id: 'system', username: 'system' }
    );
    assert.strictEqual(updatedParanoid.default_daita_mode, 'paranoid');

    // Invalid update must throw
    await assert.rejects(async () => {
      await OrgService.updateOrganization(
        testOrgId,
        { default_daita_mode: 'super_stealth' },
        { id: 'system', username: 'system' }
      );
    }, /Invalid default_daita_mode/);
  });

  it('2. sets node DAITA mode to balanced and paranoid via action', async () => {
    const resBalanced = await request(app)
      .post(`/api/nodes/${nodeBId}/action`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        action: 'set_daita',
        daita_mode: 'balanced'
      });

    assert.strictEqual(resBalanced.status, 200);
    assert.strictEqual(resBalanced.body.success, true);
    assert.strictEqual(resBalanced.body.daita_mode, 'balanced');
    assert.strictEqual(resBalanced.body.node.daita_mode, 'balanced');

    const resParanoid = await request(app)
      .post(`/api/nodes/${nodeCId}/action`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        action: 'set_daita',
        mode: 'paranoid'
      });

    assert.strictEqual(resParanoid.status, 200);
    assert.strictEqual(resParanoid.body.success, true);
    assert.strictEqual(resParanoid.body.daita_mode, 'paranoid');
    assert.strictEqual(resParanoid.body.node.daita_mode, 'paranoid');
  });

  it('3. rejects unsupported daita_mode with 400 Bad Request', async () => {
    const res = await request(app)
      .post(`/api/nodes/${nodeBId}/action`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        action: 'set_daita',
        daita_mode: 'extreme'
      });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /Invalid daita_mode/);
  });

  it('4. reflects daita_mode in generated netmap document', async () => {
    const netmapB = await NetmapService.buildNetmap(nodeBId);
    assert.ok(netmapB);
    assert.strictEqual(netmapB.self.daita_mode, 'balanced');

    // Peer C has paranoid mode
    const peerC = netmapB.peers.find((p) => p.node_id === nodeCId);
    assert.ok(peerC);
    assert.strictEqual(peerC.daita_mode, 'paranoid');

    // Peer A has off mode, so daita_mode shouldn't be populated
    const peerA = netmapB.peers.find((p) => p.node_id === nodeAId);
    assert.ok(peerA);
    assert.strictEqual(peerA.daita_mode, undefined);
  });

  it('5. validates NetmapResponse with DAITA attributes against Ajv 2020 schema', async () => {
    const res = await request(app).post('/v4/control/netmap').set('Authorization', `Bearer test-token`).send({
      node_id: nodeBId,
      version: 0
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.self.daita_mode, 'balanced');
  });
});
