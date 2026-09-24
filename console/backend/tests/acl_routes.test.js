const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

describe('WP-407: Visual ACL Rule Editor, Policy Routing & Organization Default Policy', () => {
  let dbHelper;
  let pool;
  let app;

  const orgId = 'org-acl-enterprise';
  const superAdminId = 'usr-acl-superadmin';
  const standardUserId = 'usr-acl-standard';

  let superAdminToken;
  let standardToken;
  let testNodeId = 'node-acl-preview-1';
  let createdRuleId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    // 1. Create Organization
    await pool.query(`
      INSERT INTO organizations (id, name, slug, default_policy)
      VALUES ('${orgId}', 'Enterprise Net Org', 'enterprise-net-org', 'open')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Create Superadmin User and Standard User
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, role, organization_id)
      VALUES
        ('${superAdminId}', 'aclsuperadmin', 'admin@enterprise.local', 'fakehash', 'super-admin', '${orgId}'),
        ('${standardUserId}', 'aclregular', 'user@enterprise.local', 'fakehash', 'user', '${orgId}')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 3. Create Node for compilation preview testing
    await pool.query(`
      INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
      VALUES
        ('${testNodeId}', '${orgId}', '${superAdminId}', 'HQ Core Gateway', '100.64.10.1', 'fd00:beef::10:1', 'TestPubKey1111111111111111111111111111111111=', 'RELAY', TRUE, FALSE),
        ('node-peer-2', '${orgId}', '${superAdminId}', 'Branch Edge 2', '100.64.10.2', 'fd00:beef::10:2', 'TestPubKey2222222222222222222222222222222222=', 'CLIENT_ORIGIN', TRUE, FALSE)
      ON CONFLICT (id) DO NOTHING;
    `);

    superAdminToken = jwt.sign(
      { sub: superAdminId, id: superAdminId, username: 'aclsuperadmin', role: 'super-admin', organization_id: orgId },
      config.JWT_SECRET
    );

    standardToken = jwt.sign(
      { sub: standardUserId, id: standardUserId, username: 'aclregular', role: 'user', organization_id: orgId },
      config.JWT_SECRET
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('1. GET /api/acl/rules returns empty rules list and reports mesh is open', async () => {
    const res = await request(app)
      .get('/api/acl/rules')
      .set('Authorization', `Bearer ${standardToken}`);

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.rules));
    assert.strictEqual(typeof res.body.epoch, 'number');
    assert.strictEqual(res.body.policy_is_open, true);
  });

  it('2. POST /api/acl/rules rejects invalid CIDRs with 400', async () => {
    const res = await request(app)
      .post('/api/acl/rules')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        source_cidr: 'not-a-valid-cidr',
        destination_cidr: '100.64.0.0/16',
        protocol: 'TCP',
        port_start: 80,
        port_end: 443,
        action: 'ACCEPT'
      });

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
  });

  it('3. POST /api/acl/rules successfully creates a zero-trust rule and advances epoch', async () => {
    const res = await request(app)
      .post('/api/acl/rules')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        priority: 50,
        source_cidr: '100.64.10.0/24',
        destination_cidr: '100.64.0.0/16',
        protocol: 'TCP',
        port_start: 443,
        port_end: 443,
        action: 'ACCEPT',
        description: 'Allow HTTPS traffic between branches'
      });

    assert.strictEqual(res.status, 201);
    assert.ok(res.body.rule);
    assert.strictEqual(res.body.rule.action, 'ACCEPT');
    assert.strictEqual(res.body.rule.protocol, 'TCP');
    assert.strictEqual(res.body.rule.priority, 50);
    createdRuleId = res.body.rule.id;
    assert.ok(createdRuleId);
  });

  it('4. PUT /api/acl/rules/:id updates rule attributes', async () => {
    const res = await request(app)
      .put(`/api/acl/rules/${createdRuleId}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        priority: 25,
        action: 'DROP',
        description: 'Block HTTPS traffic during maintenance'
      });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.rule);
    assert.strictEqual(res.body.rule.priority, 25);
    assert.strictEqual(res.body.rule.action, 'DROP');
    assert.strictEqual(res.body.rule.description, 'Block HTTPS traffic during maintenance');
  });

  it('5. GET /api/acl/default-policy retrieves organization default policy', async () => {
    const res = await request(app)
      .get('/api/acl/default-policy')
      .set('Authorization', `Bearer ${standardToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.organization_id, orgId);
    assert.strictEqual(res.body.default_policy, 'open');
  });

  it('6. PUT /api/acl/default-policy toggles policy to zero-trust deny', async () => {
    const res = await request(app)
      .put('/api/acl/default-policy')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ default_policy: 'deny' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.default_policy, 'deny');

    const verify = await request(app)
      .get('/api/acl/default-policy')
      .set('Authorization', `Bearer ${standardToken}`);
    assert.strictEqual(verify.body.default_policy, 'deny');
  });

  it('7. POST /api/acl/simulate evaluates packet against active rule and returns DROP verdict', async () => {
    const res = await request(app)
      .post('/api/acl/simulate')
      .set('Authorization', `Bearer ${standardToken}`)
      .send({
        source_ip: '100.64.10.1',
        destination_ip: '100.64.10.2',
        protocol: 'TCP',
        port: 443
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.verdict, 'DROP');
    assert.ok(res.body.matched_rule);
    assert.strictEqual(res.body.matched_rule.id, createdRuleId);
  });

  it('8. POST /api/acl/simulate evaluates unmatched packet against default deny policy', async () => {
    const res = await request(app)
      .post('/api/acl/simulate')
      .set('Authorization', `Bearer ${standardToken}`)
      .send({
        source_ip: '10.0.0.1',
        destination_ip: '10.0.0.2',
        protocol: 'UDP',
        port: 53
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.verdict, 'DROP');
    assert.strictEqual(res.body.matched_rule, null);
    assert.ok(res.body.reason.includes('DENY'));
  });

  it('9. POST /api/acl/preview compiles preview for target node with candidate rule without persisting', async () => {
    const res = await request(app)
      .post('/api/acl/preview')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        node_id: testNodeId,
        candidate_rule: {
          priority: 10,
          source_cidr: '100.64.0.0/10',
          destination_cidr: '100.64.0.0/10',
          protocol: 'UDP',
          port_start: 51820,
          port_end: 51820,
          action: 'ACCEPT'
        }
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.node_id, testNodeId);
    assert.strictEqual(res.body.is_preview, true);
    assert.ok(Array.isArray(res.body.inbound_rules));
    assert.ok(Array.isArray(res.body.outbound_rules));
  });

  it('10. DELETE /api/acl/rules/:id deletes rule and reopens mesh', async () => {
    const res = await request(app)
      .delete(`/api/acl/rules/${createdRuleId}`)
      .set('Authorization', `Bearer ${superAdminToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.deleted, createdRuleId);
    assert.strictEqual(res.body.policy_is_open, true);

    const listRes = await request(app)
      .get('/api/acl/rules')
      .set('Authorization', `Bearer ${standardToken}`);
    assert.strictEqual(listRes.body.rules.length, 0);
  });
});
