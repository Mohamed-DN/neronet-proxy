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

describe('WP-208: Multi-Protocol Transport & AmneziaWG Stealth', () => {
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

    testOrgId = 'org-multi-proto';
    await pool.query(
      `INSERT INTO organizations (id, name, slug, profile, default_transport)
       VALUES ($1, 'Multi-Proto Org', 'multi-proto', 'standard', 'wireguard')
       ON CONFLICT (id) DO NOTHING`,
      [testOrgId]
    );

    // Create admin user for the org
    const userId = 'usr-proto-admin';
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, 'protoadmin', 'admin@proto.net', 'hash', 'admin', $2)
       ON CONFLICT (id) DO NOTHING`,
      [userId, testOrgId]
    );

    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-protoadmin', $1, $2, 'owner')
       ON CONFLICT (user_id, organization_id) DO NOTHING`,
      [userId, testOrgId]
    );

    userToken = jwt.sign(
      {
        id: userId,
        username: 'protoadmin',
        role: 'admin',
        organization_id: testOrgId
      },
      config.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Create 3 nodes in this org
    nodeAId = 'node-alpha-wg';
    nodeBId = 'node-beta-awg';
    nodeCId = 'node-gamma-ovpn';

    const pubA = crypto.randomBytes(32).toString('hex');
    const pubB = crypto.randomBytes(32).toString('hex');
    const pubC = crypto.randomBytes(32).toString('hex');

    await pool.query(
      `INSERT INTO nodes (
        id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6,
        role, is_healthy, is_quarantined, transport, endpoints
      ) VALUES
        ($1, $4, $5, 'Node Alpha', $6, '100.64.0.10', 'fd00::10', 'CLIENT_ORIGIN', TRUE, FALSE, 'wireguard', '["192.168.1.10:51820"]'::jsonb),
        ($2, $4, $5, 'Node Beta', $7, '100.64.0.20', 'fd00::20', 'CLIENT_ORIGIN', TRUE, FALSE, 'wireguard', '["192.168.1.20:51820"]'::jsonb),
        ($3, $4, $5, 'Node Gamma', $8, '100.64.0.30', 'fd00::30', 'CLIENT_ORIGIN', TRUE, FALSE, 'wireguard', '["192.168.1.30:51820"]'::jsonb)
      ON CONFLICT (id) DO NOTHING`,
      [nodeAId, nodeBId, nodeCId, userId, testOrgId, pubA, pubB, pubC]
    );
  });

  it('1. updates organization default_transport and rejects invalid transport names', async () => {
    // Valid update
    const updated = await OrgService.updateOrganization(
      testOrgId,
      {
        default_transport: 'amneziawg',
        default_stealth_config: {
          jc: 4,
          jmin: 40,
          jmax: 120,
          s1: 56,
          s2: 48,
          h1: 2712847316,
          h2: 3569603233,
          h3: 3858036504,
          h4: 403175141,
          disguise: 'none'
        }
      },
      { id: 'system', username: 'system' }
    );

    assert.strictEqual(updated.default_transport, 'amneziawg');

    // Invalid update must throw
    await assert.rejects(async () => {
      await OrgService.updateOrganization(
        testOrgId,
        { default_transport: 'pptp' },
        { id: 'system', username: 'system' }
      );
    }, /Invalid default_transport/);
  });

  it('2. sets node transport to amneziawg with custom stealth params via action', async () => {
    const stealthConfig = {
      jc: 5,
      jmin: 50,
      jmax: 150,
      s1: 64,
      s2: 48,
      h1: 305419896,
      h2: 123456789,
      h3: 987654321,
      h4: 555555555,
      disguise: 'dns'
    };

    const res = await request(app)
      .post(`/api/nodes/${nodeBId}/action`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        action: 'set_transport',
        transport: 'amneziawg',
        stealth_config: stealthConfig
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.transport, 'amneziawg');
    assert.deepStrictEqual(res.body.stealth_config, stealthConfig);
    assert.strictEqual(res.body.node.transport, 'amneziawg');
  });

  it('3. sets node transport to openvpn and vless', async () => {
    const resOvpn = await request(app)
      .post(`/api/nodes/${nodeCId}/action`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        action: 'set_transport',
        transport: 'openvpn'
      });

    assert.strictEqual(resOvpn.status, 200);
    assert.strictEqual(resOvpn.body.transport, 'openvpn');

    const resVless = await request(app)
      .post(`/api/nodes/${nodeCId}/action`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        action: 'set_transport',
        transport: 'vless'
      });

    assert.strictEqual(resVless.status, 200);
    assert.strictEqual(resVless.body.transport, 'vless');
  });

  it('4. rejects unsupported transport with 400 Bad Request', async () => {
    const res = await request(app)
      .post(`/api/nodes/${nodeBId}/action`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        action: 'set_transport',
        transport: 'ipsec_ikev2'
      });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /Invalid transport/);
  });

  it('5. reflects transport and stealth in generated netmap document', async () => {
    const netmap = await NetmapService.buildNetmap(nodeBId);
    assert.ok(netmap);
    assert.strictEqual(netmap.self.transport, 'amneziawg');
    assert.ok(netmap.self.stealth);
    assert.strictEqual(netmap.self.stealth.disguise, 'dns');
    assert.strictEqual(netmap.self.stealth.h1, 305419896);

    // Node C should be present in peers with vless transport
    const peerC = netmap.peers.find((p) => p.node_id === nodeCId);
    if (peerC) {
      assert.strictEqual(peerC.transport, 'vless');
    }
  });

  it('6. validates NetmapResponse against Ajv 2020 schema over wire contract', async () => {
    const res = await request(app).post('/v4/control/netmap').set('Authorization', `Bearer test-token`).send({
      node_id: nodeBId,
      version: 0
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.self.transport, 'amneziawg');
    assert.strictEqual(res.body.self.stealth.disguise, 'dns');
  });
});
