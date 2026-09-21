const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');
const { signToken } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

describe('WP-106: Organizations, RBAC, and Tenant Isolation', () => {
  let dbHelper;
  let app;
  let pool;

  // Test entities
  let superAdminToken;
  let orgAId;
  let orgBId;
  let userAOwnerToken;
  let userAAuditorToken;
  let userBMemberToken;
  let nodeAId;
  let nodeBId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    // 1. Setup Super Admin
    superAdminToken = signToken({ id: 'usr-admin', username: 'admin', role: 'super-admin' });

    // 2. Create Org A and Org B
    const orgARes = await pool.query(`
      INSERT INTO organizations (id, name, slug, default_policy)
      VALUES ('org-bank-alpha', 'Bank Alpha', 'bank-alpha', 'deny')
      RETURNING id
    `);
    orgAId = orgARes.rows[0].id;

    const orgBRes = await pool.query(`
      INSERT INTO organizations (id, name, slug, default_policy)
      VALUES ('org-bank-beta', 'Bank Beta', 'bank-beta', 'deny')
      RETURNING id
    `);
    orgBId = orgBRes.rows[0].id;

    // 3. Create Users
    const passHash = bcrypt.hashSync('Password123!', 10);

    // User A Owner
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-a-owner', 'alice_owner', 'alice@alpha.local', $1, 'user', $2)`,
      [passHash, orgAId]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-a-1', 'usr-a-owner', $1, 'owner')`,
      [orgAId]
    );
    userAOwnerToken = signToken({
      id: 'usr-a-owner',
      username: 'alice_owner',
      role: 'user',
      organization_id: orgAId,
      org_role: 'owner'
    });

    // User A Auditor
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-a-auditor', 'arthur_auditor', 'arthur@alpha.local', $1, 'user', $2)`,
      [passHash, orgAId]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-a-2', 'usr-a-auditor', $1, 'auditor')`,
      [orgAId]
    );
    userAAuditorToken = signToken({
      id: 'usr-a-auditor',
      username: 'arthur_auditor',
      role: 'user',
      organization_id: orgAId,
      org_role: 'auditor'
    });

    // User B Member
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-b-member', 'bob_member', 'bob@beta.local', $1, 'user', $2)`,
      [passHash, orgBId]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-b-1', 'usr-b-member', $1, 'member')`,
      [orgBId]
    );
    userBMemberToken = signToken({
      id: 'usr-b-member',
      username: 'bob_member',
      role: 'user',
      organization_id: orgBId,
      org_role: 'member'
    });

    // 4. Create Nodes in Org A and Org B
    nodeAId = 'svrn-node-alpha-1';
    await pool.query(
      `INSERT INTO nodes (
        id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6,
        role, ip_class, country_code, city, asn, endpoints
      ) VALUES ($1, 'usr-a-owner', $2, 'Alpha Gateway', 'pubkeyAlpha1111111111111111111111111111111=',
        '100.64.10.1', 'fd7a:115c:a1e0::a:1', 'EXIT_BRIDGE', 'DATACENTER', 'DE', 'Frankfurt', 12345, '[]'::jsonb)`,
      [nodeAId, orgAId]
    );

    nodeBId = 'svrn-node-beta-1';
    await pool.query(
      `INSERT INTO nodes (
        id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6,
        role, ip_class, country_code, city, asn, endpoints
      ) VALUES ($1, 'usr-b-member', $2, 'Beta Node', 'pubkeyBeta111111111111111111111111111111111=',
        '100.64.20.1', 'fd7a:115c:a1e0::b:1', 'CLIENT_ORIGIN', 'RESIDENTIAL', 'CH', 'Zurich', 54321, '[]'::jsonb)`,
      [nodeBId, orgBId]
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('1. Organization Management & Lifecycle', () => {
    it('allows super-admin to create an organization', async () => {
      const res = await request(app)
        .post('/api/organizations')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ name: 'Gamma Corp', default_policy: 'deny' });

      assert.strictEqual(res.status, 201);
      assert.ok(res.body.organization.id);
      assert.strictEqual(res.body.organization.name, 'Gamma Corp');
      assert.strictEqual(res.body.organization.default_policy, 'deny');
    });

    it('denies non-super-admin from creating organizations', async () => {
      const res = await request(app)
        .post('/api/organizations')
        .set('Authorization', `Bearer ${userAOwnerToken}`)
        .send({ name: 'Illegal Org' });

      assert.strictEqual(res.status, 403);
    });

    it('allows organization owner to add and list members', async () => {
      // Create new user to add
      const newUserRes = await pool.query(`
        INSERT INTO users (id, username, email, password_hash, role)
        VALUES ('usr-a-newbie', 'newbie', 'newbie@alpha.local', 'hash', 'user')
        RETURNING id
      `);
      const newUserId = newUserRes.rows[0].id;

      // Add as member
      const addRes = await request(app)
        .post(`/api/organizations/${orgAId}/members`)
        .set('Authorization', `Bearer ${userAOwnerToken}`)
        .send({ user_id: newUserId, role: 'member' });

      assert.strictEqual(addRes.status, 201);

      // List members
      const listRes = await request(app)
        .get(`/api/organizations/${orgAId}/members`)
        .set('Authorization', `Bearer ${userAOwnerToken}`);

      assert.strictEqual(listRes.status, 200);
      assert.strictEqual(listRes.body.members.length >= 3, true);
    });

    it('refuses to remove the last owner of an organization', async () => {
      const res = await request(app)
        .delete(`/api/organizations/${orgAId}/members/usr-a-owner`)
        .set('Authorization', `Bearer ${userAOwnerToken}`);

      assert.strictEqual(res.status, 400);
      assert.match(res.body.error, /last owner/i);
    });
  });

  describe('2. Cross-Tenant Isolation (Must return 404 to prevent existence oracle)', () => {
    it('returns 404 when Org A owner attempts to read Org B node', async () => {
      const res = await request(app).get(`/api/nodes/${nodeBId}`).set('Authorization', `Bearer ${userAOwnerToken}`);

      assert.strictEqual(res.status, 404, 'Must return 404 not found, not 403');
    });

    it('returns 404 when Org A owner attempts to update Org B node', async () => {
      const res = await request(app)
        .put(`/api/nodes/${nodeBId}`)
        .set('Authorization', `Bearer ${userAOwnerToken}`)
        .send({ name: 'Hacked Name' });

      assert.strictEqual(res.status, 404);
    });

    it('returns 404 when Org A owner attempts to delete Org B node', async () => {
      const res = await request(app).delete(`/api/nodes/${nodeBId}`).set('Authorization', `Bearer ${userAOwnerToken}`);

      assert.strictEqual(res.status, 404);
    });

    it('returns 404 when Org A owner attempts to inspect Org B detail', async () => {
      const res = await request(app)
        .get(`/api/organizations/${orgBId}`)
        .set('Authorization', `Bearer ${userAOwnerToken}`);

      assert.strictEqual(res.status, 404);
    });
  });

  describe('3. Auditor / Viewer Role Protection (Full Mutating Route Matrix)', () => {
    it('allows auditor to read organization nodes', async () => {
      const res = await request(app).get('/api/nodes').set('Authorization', `Bearer ${userAAuditorToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        res.body.nodes.some((n) => n.id === nodeAId),
        true
      );
    });

    it('blocks auditor from creating nodes with 403', async () => {
      const res = await request(app)
        .post('/api/nodes')
        .set('Authorization', `Bearer ${userAAuditorToken}`)
        .send({ name: 'Auditor Attempt' });

      assert.strictEqual(res.status, 403);
      assert.ok(res.body.error.toLowerCase().includes('read-only'));
    });

    it('blocks auditor from updating nodes with 403', async () => {
      const res = await request(app)
        .put(`/api/nodes/${nodeAId}`)
        .set('Authorization', `Bearer ${userAAuditorToken}`)
        .send({ name: 'Auditor Edit' });

      assert.strictEqual(res.status, 403);
    });

    it('blocks auditor from deleting nodes with 403', async () => {
      const res = await request(app)
        .delete(`/api/nodes/${nodeAId}`)
        .set('Authorization', `Bearer ${userAAuditorToken}`);

      assert.strictEqual(res.status, 403);
    });

    it('blocks auditor from creating pre-auth keys with 403', async () => {
      const res = await request(app)
        .post('/api/preauth-keys')
        .set('Authorization', `Bearer ${userAAuditorToken}`)
        .send({ is_reusable: false });

      assert.strictEqual(res.status, 403);
    });

    it('blocks auditor from revoking pre-auth keys with 403', async () => {
      const res = await request(app)
        .delete('/api/preauth-keys/pak_dummy')
        .set('Authorization', `Bearer ${userAAuditorToken}`);

      assert.strictEqual(res.status, 403);
    });
  });

  describe('4. Super-Admin Platform-Wide Visibility', () => {
    it('allows super-admin to view nodes across all organizations', async () => {
      const res = await request(app).get('/api/nodes').set('Authorization', `Bearer ${superAdminToken}`);

      assert.strictEqual(res.status, 200);
      const nodeIds = new Set(res.body.nodes.map((n) => n.id));
      assert.ok(nodeIds.has(nodeAId), 'Super-admin must see Org A nodes');
      assert.ok(nodeIds.has(nodeBId), 'Super-admin must see Org B nodes');
    });
  });
});
