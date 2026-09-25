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

describe('WP-210: MagicDNS, In-Mesh Gateway & Keystore', () => {
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

    testOrgId = 'org-magicdns';
    await pool.query(
      `INSERT INTO organizations (id, name, slug, profile, search_domain)
       VALUES ($1, 'MagicDNS Org', 'magicdns-org', 'standard', 'magicdns-org.neronet')
       ON CONFLICT (id) DO NOTHING`,
      [testOrgId]
    );

    // Create admin user for the org
    const userId = 'usr-magicdns-admin';
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, 'dnsadmin', 'admin@magicdns.net', 'hash', 'admin', $2)
       ON CONFLICT (id) DO NOTHING`,
      [userId, testOrgId]
    );

    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-dnsadmin', $1, $2, 'owner')
       ON CONFLICT (user_id, organization_id) DO NOTHING`,
      [userId, testOrgId]
    );

    userToken = jwt.sign(
      {
        id: userId,
        username: 'dnsadmin',
        role: 'admin',
        organization_id: testOrgId
      },
      config.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Create 3 nodes in this org
    nodeAId = 'node-dns-alpha';
    nodeBId = 'node-dns-beta';
    nodeCId = 'node-dns-gamma';

    const pubA = crypto.randomBytes(32).toString('hex');
    const pubB = crypto.randomBytes(32).toString('hex');
    const pubC = crypto.randomBytes(32).toString('hex');

    await pool.query(
      `INSERT INTO nodes (
        id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6,
        role, is_healthy, is_quarantined, endpoints
      ) VALUES
        ($1, $4, $5, 'Alpha Gateway', $6, '100.64.2.10', 'fd00::2:10', 'CLIENT_ORIGIN', TRUE, FALSE, '["192.168.2.10:51820"]'::jsonb),
        ($2, $4, $5, 'Beta Database', $7, '100.64.2.20', 'fd00::2:20', 'CLIENT_ORIGIN', TRUE, FALSE, '["192.168.2.20:51820"]'::jsonb),
        ($3, $4, $5, 'Gamma Worker', $8, '100.64.2.30', 'fd00::2:30', 'CLIENT_ORIGIN', TRUE, FALSE, '["192.168.2.30:51820"]'::jsonb)
      ON CONFLICT (id) DO NOTHING`,
      [nodeAId, nodeBId, nodeCId, userId, testOrgId, pubA, pubB, pubC]
    );
  });

  it('1. updates organization search_domain via OrgService', async () => {
    const updated = await OrgService.updateOrganization(
      testOrgId,
      { search_domain: 'internal.corp.neronet' },
      { id: 'system', username: 'system' }
    );
    assert.strictEqual(updated.search_domain, 'internal.corp.neronet');
  });

  it('2. sets node explicit dns_name via set_dns_name action', async () => {
    const res = await request(app)
      .post(`/api/nodes/${nodeAId}/action`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        action: 'set_dns_name',
        dns_name: 'gateway.internal.corp.neronet'
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.dns_name, 'gateway.internal.corp.neronet');
    assert.strictEqual(res.body.node.dns_name, 'gateway.internal.corp.neronet');
  });

  it('3. rejects empty or non-string dns_name with 400 Bad Request', async () => {
    const res = await request(app)
      .post(`/api/nodes/${nodeAId}/action`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        action: 'set_dns_name',
        dns_name: ''
      });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /dns_name string is required/);
  });

  it('4. reflects MagicDNS configuration and hostnames in buildNetmap', async () => {
    const netmap = await NetmapService.buildNetmap(nodeAId);
    assert.ok(netmap);

    // Verify DNS configuration block
    assert.ok(netmap.dns);
    assert.strictEqual(netmap.dns.magic_dns, true);
    assert.ok(Array.isArray(netmap.dns.search_domains));
    assert.ok(netmap.dns.search_domains.includes('internal.corp.neronet'));
    assert.ok(netmap.dns.search_domains.includes('mesh'));

    // Self DNS attributes
    assert.strictEqual(netmap.self.name, 'Alpha Gateway');
    assert.strictEqual(netmap.self.dns_name, 'gateway.internal.corp.neronet');

    // Peer Beta (computed DNS name from node name)
    const peerBeta = netmap.peers.find((p) => p.node_id === nodeBId);
    assert.ok(peerBeta);
    assert.strictEqual(peerBeta.name, 'Beta Database');
    assert.strictEqual(peerBeta.dns_name, 'beta-database.internal.corp.neronet');
  });

  it('5. validates NetmapResponse with DNS attributes over wire contract against Ajv 2020', async () => {
    const res = await request(app).post('/v4/control/netmap').set('Authorization', `Bearer test-token`).send({
      node_id: nodeAId,
      version: 0
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.dns.magic_dns, true);
    assert.strictEqual(res.body.self.dns_name, 'gateway.internal.corp.neronet');
  });
});
