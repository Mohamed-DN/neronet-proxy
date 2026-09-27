const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

// The risk overviews listed every node on the platform, with its name, owner and
// score, to any signed-in user.

describe('Risk overviews are scoped to the caller’s organisation', () => {
  let dbHelper;
  let pool;
  let app;
  let memberA;
  let superAdmin;

  function token(id, role, orgId) {
    return jwt.sign({ sub: id, id, username: id, role, organization_id: orgId }, config.JWT_SECRET);
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ('org-risk-a', 'A', 'risk-a'), ('org-risk-b', 'B', 'risk-b')`
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-risk-a', 'riska', 'riska@risk.test', 'hash', 'user', 'org-risk-a'),
         ('usr-risk-b', 'riskb', 'riskb@risk.test', 'hash', 'user', 'org-risk-b')`
    );
    await pool.query(
      `INSERT INTO nodes (id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6, risk_score) VALUES
         ('node-risk-a', 'usr-risk-a', 'org-risk-a', 'alpha-host', 'pk-risk-a', '100.64.97.1', 'fd7a:115c:a1e0::97:1', 50),
         ('node-risk-b', 'usr-risk-b', 'org-risk-b', 'bravo-secret-host', 'pk-risk-b', '100.64.97.2', 'fd7a:115c:a1e0::97:2', 90)`
    );
    memberA = token('usr-risk-a', 'user', 'org-risk-a');
    const adminId = (await pool.query("SELECT id FROM users WHERE role = 'super-admin' LIMIT 1")).rows[0].id;
    superAdmin = token(adminId, 'super-admin', 'org-default');
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  for (const path of ['/api/risk/scores', '/api/risk/dashboard', '/api/risk/leaderboard']) {
    it(`${path} shows another organisation's nodes to nobody but the platform super-admin`, async () => {
      const member = await request(app).get(path).set('Authorization', `Bearer ${memberA}`);
      assert.strictEqual(member.status, 200);
      assert.ok(!JSON.stringify(member.body).includes('bravo-secret-host'));
      assert.ok(JSON.stringify(member.body).includes('alpha-host'));

      const admin = await request(app).get(path).set('Authorization', `Bearer ${superAdmin}`);
      assert.ok(JSON.stringify(admin.body).includes('bravo-secret-host'));
    });
  }

  it('/api/risk/summary counts the caller’s organisation only', async () => {
    const res = await request(app).get('/api/risk/summary').set('Authorization', `Bearer ${memberA}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total_nodes, 1);
  });
});
