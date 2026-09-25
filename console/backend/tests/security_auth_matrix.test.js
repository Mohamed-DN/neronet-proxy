const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');
const { signToken } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

describe('WP-503: Full Control Plane Authorization Matrix & IDOR Protection', () => {
  let dbHelper;
  let app;
  let pool;

  let superAdminToken;
  let orgAId;
  let orgBId;
  let ownerTokenOrgA;
  let auditorTokenOrgA;
  let memberTokenOrgA;
  let memberTokenOrgB;
  let nodeAId;
  let nodeBId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    // 1. Super Admin token
    superAdminToken = signToken({ id: 'usr-super-admin', username: 'superadmin', role: 'super-admin' });

    // 2. Setup Organizations A and B
    const orgARes = await pool.query(`
      INSERT INTO organizations (id, name, slug, default_policy)
      VALUES ('org-matrix-alpha', 'Alpha Gov', 'alpha-gov', 'deny')
      RETURNING id
    `);
    orgAId = orgARes.rows[0].id;

    const orgBRes = await pool.query(`
      INSERT INTO organizations (id, name, slug, default_policy)
      VALUES ('org-matrix-beta', 'Beta Defense', 'beta-defense', 'deny')
      RETURNING id
    `);
    orgBId = orgBRes.rows[0].id;

    const passHash = bcrypt.hashSync('SecureSecret123!', 10);

    // 3. Setup Users & Roles for Org A
    // Owner
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-owner-a', 'owner_a', 'owner@alpha.local', $1, 'user', $2)`,
      [passHash, orgAId]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-owner-a', 'usr-owner-a', $1, 'owner')`,
      [orgAId]
    );
    ownerTokenOrgA = signToken({
      id: 'usr-owner-a',
      username: 'owner_a',
      role: 'user',
      organization_id: orgAId,
      org_role: 'owner'
    });

    // Auditor
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-auditor-a', 'auditor_a', 'auditor@alpha.local', $1, 'user', $2)`,
      [passHash, orgAId]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-auditor-a', 'usr-auditor-a', $1, 'auditor')`,
      [orgAId]
    );
    auditorTokenOrgA = signToken({
      id: 'usr-auditor-a',
      username: 'auditor_a',
      role: 'user',
      organization_id: orgAId,
      org_role: 'auditor'
    });

    // Member
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-member-a', 'member_a', 'member@alpha.local', $1, 'user', $2)`,
      [passHash, orgAId]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-member-a', 'usr-member-a', $1, 'member')`,
      [orgAId]
    );
    memberTokenOrgA = signToken({
      id: 'usr-member-a',
      username: 'member_a',
      role: 'user',
      organization_id: orgAId,
      org_role: 'member'
    });

    // Setup Member for Org B (for IDOR tests)
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-member-b', 'member_b', 'member@beta.local', $1, 'user', $2)`,
      [passHash, orgBId]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-member-b', 'usr-member-b', $1, 'member')`,
      [orgBId]
    );
    memberTokenOrgB = signToken({
      id: 'usr-member-b',
      username: 'member_b',
      role: 'user',
      organization_id: orgBId,
      org_role: 'member'
    });

    // Setup Test Nodes in Org A and Org B
    nodeAId = 'svrn-node-alpha-503';
    await pool.query(
      `INSERT INTO nodes (
        id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6,
        role, ip_class, country_code, city, asn, endpoints
      ) VALUES ($1, 'usr-owner-a', $2, 'Alpha Node', 'pkAlpha503000000000000000000000000000000000=',
        '100.64.50.1', 'fd7a:115c:a1e0::50:1', 'EXIT_BRIDGE', 'DATACENTER', 'IT', 'Rome', 12345, '[]'::jsonb)`,
      [nodeAId, orgAId]
    );

    nodeBId = 'svrn-node-beta-503';
    await pool.query(
      `INSERT INTO nodes (
        id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6,
        role, ip_class, country_code, city, asn, endpoints
      ) VALUES ($1, 'usr-member-b', $2, 'Beta Node', 'pkBeta50300000000000000000000000000000000000=',
        '100.64.60.1', 'fd7a:115c:a1e0::60:1', 'CLIENT_ORIGIN', 'RESIDENTIAL', 'FR', 'Paris', 54321, '[]'::jsonb)`,
      [nodeBId, orgBId]
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('1. Unauthenticated (Anonymous) Requests', () => {
    const protectedGetEndpoints = [
      '/api/nodes',
      '/api/acl/rules',
      '/api/audit/logs',
      '/api/users',
      '/api/organizations',
      '/api/compartments'
    ];

    for (const endpoint of protectedGetEndpoints) {
      it(`GET ${endpoint} rejects unauthenticated caller with 401`, async () => {
        const res = await request(app).get(endpoint);
        assert.strictEqual(res.status, 401);
      });
    }

    it('POST /api/acl/rules rejects unauthenticated caller with 401', async () => {
      const res = await request(app)
        .post('/api/acl/rules')
        .send({ src: '10.100.0.0/16', dst: '10.100.1.0/24', action: 'accept' });
      assert.strictEqual(res.status, 401);
    });

    it('POST /api/nodes/:id/quarantine rejects unauthenticated caller with 401', async () => {
      const res = await request(app).post(`/api/nodes/${nodeAId}/quarantine`);
      assert.strictEqual(res.status, 401);
    });

    it('POST /api/nuke/dual-auth/request rejects unauthenticated caller with 401', async () => {
      const res = await request(app).post('/api/nuke/dual-auth/request');
      assert.strictEqual(res.status, 401);
    });
  });

  describe('2. Role "member" (Least Privileged Authenticated User)', () => {
    it('GET /api/nodes allows member to read nodes in their organization', async () => {
      const res = await request(app)
        .get('/api/nodes')
        .set('Authorization', `Bearer ${memberTokenOrgA}`);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.nodes || res.body));
    });

    it('POST /api/acl/rules denies member with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/acl/rules')
        .set('Authorization', `Bearer ${memberTokenOrgA}`)
        .send({
          name: 'Forbidden Rule',
          action: 'ACCEPT',
          source_type: 'TAG',
          source_value: 'dev',
          destination_type: 'TAG',
          destination_value: 'prod',
          destination_port: '80'
        });
      assert.strictEqual(res.status, 403);
    });

    it('POST /api/nodes/:id/quarantine denies member mutating non-owned node (403 or 404)', async () => {
      const res = await request(app)
        .post(`/api/nodes/${nodeAId}/quarantine`)
        .set('Authorization', `Bearer ${memberTokenOrgA}`)
        .send({ reason: 'Unauthorized attempt' });
      assert.ok([403, 404].includes(res.status), `Expected 403 or 404, got ${res.status}`);
    });

    it('POST /api/audit/checkpoints denies member with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/audit/checkpoints')
        .set('Authorization', `Bearer ${memberTokenOrgA}`);
      // Non-auditors/admins cannot create audit checkpoints
      assert.ok([403, 404].includes(res.status), `Expected 403 or 404, got ${res.status}`);
    });

    it('POST /api/nuke/dual-auth/request denies member with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/nuke/dual-auth/request')
        .set('Authorization', `Bearer ${memberTokenOrgA}`)
        .send({ scope: 'all' });
      assert.strictEqual(res.status, 403);
    });
  });

  describe('3. Role "auditor" (Read-Only Posture & Security Verification)', () => {
    it('GET /api/audit/logs allows auditor to inspect audit ledger', async () => {
      const res = await request(app)
        .get('/api/audit/logs')
        .set('Authorization', `Bearer ${auditorTokenOrgA}`);
      assert.strictEqual(res.status, 200);
    });

    it('POST /api/nodes/:id/quarantine denies auditor with 403 Forbidden', async () => {
      const res = await request(app)
        .post(`/api/nodes/${nodeAId}/quarantine`)
        .set('Authorization', `Bearer ${auditorTokenOrgA}`)
        .send({ reason: 'Audit test' });
      assert.strictEqual(res.status, 403);
    });

    it('POST /api/acl/rules denies auditor with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/acl/rules')
        .set('Authorization', `Bearer ${auditorTokenOrgA}`)
        .send({
          name: 'Auditor Rule',
          action: 'ACCEPT',
          source_type: 'TAG',
          source_value: 'audit',
          destination_type: 'TAG',
          destination_value: 'audit',
          destination_port: '443'
        });
      assert.strictEqual(res.status, 403);
    });
  });

  describe('4. Cross-Tenant IDOR (Insecure Direct Object Reference) Prevention', () => {
    it('User in Org B cannot read details of Node in Org A', async () => {
      const res = await request(app)
        .get(`/api/nodes/${nodeAId}`)
        .set('Authorization', `Bearer ${memberTokenOrgB}`);
      assert.ok([403, 404].includes(res.status), `Expected 403 or 404 but got ${res.status}`);
    });

    it('User in Org B cannot quarantine Node in Org A', async () => {
      const res = await request(app)
        .post(`/api/nodes/${nodeAId}/quarantine`)
        .set('Authorization', `Bearer ${memberTokenOrgB}`)
        .send({ reason: 'Cross tenant attack' });
      assert.ok([403, 404].includes(res.status), `Expected 403 or 404 but got ${res.status}`);
    });
  });

  describe('5. Super Admin Platform Oversight', () => {
    it('Super Admin can access global platform organizations', async () => {
      const res = await request(app)
        .get('/api/organizations')
        .set('Authorization', `Bearer ${superAdminToken}`);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.organizations || res.body));
    });
  });
});
