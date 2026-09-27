const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

// GET /api/compartments/:id took the organisation from ?org_id= and never checked
// it against the caller's, unlike the list route: a caller who knew another
// organisation's id read its compartments.

describe('A compartment is read only within its organisation', () => {
  let dbHelper;
  let app;

  const token = (id, orgId, role = 'user') =>
    jwt.sign({ sub: id, id, username: id, role, organization_id: orgId }, config.JWT_SECRET);

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();
    const pool = dbHelper.pool;

    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ('org-cmp-a', 'A', 'cmp-a'), ('org-cmp-b', 'B', 'cmp-b')`
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-cmp-a', 'cmpa', 'cmpa@cmp.test', 'hash', 'user', 'org-cmp-a'),
         ('usr-cmp-b', 'cmpb', 'cmpb@cmp.test', 'hash', 'user', 'org-cmp-b')`
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-cmp-a', 'usr-cmp-a', 'org-cmp-a', 'member'),
         ('mem-cmp-b', 'usr-cmp-b', 'org-cmp-b', 'member')`
    );
    await pool.query(
      `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr)
       VALUES ('cmp-b-finance', 'org-cmp-b', 'Finance B', 'finance-b', '100.64.50.0/24')`
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it("refuses another organisation's compartment named through ?org_id", async () => {
    const res = await request(app)
      .get('/api/compartments/cmp-b-finance?org_id=org-cmp-b')
      .set('Authorization', `Bearer ${token('usr-cmp-a', 'org-cmp-a')}`);

    assert.strictEqual(res.status, 404);
    assert.ok(!JSON.stringify(res.body).includes('Finance B'));
  });

  it('serves it to its own organisation', async () => {
    const res = await request(app)
      .get('/api/compartments/cmp-b-finance')
      .set('Authorization', `Bearer ${token('usr-cmp-b', 'org-cmp-b')}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.compartment.name, 'Finance B');
  });
});
