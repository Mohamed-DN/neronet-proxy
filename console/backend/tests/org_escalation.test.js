const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

// Two ways an organisation admin could raise their own privileges:
// - re-adding themselves through POST /members with role owner, which upserted the
//   role, though only an owner may change roles through PUT;
// - switching a regulated organisation to the standard profile, which turns nuke,
//   deniability and onion back on. ADR 0015 has the organisation unable to do that.

describe('Organisation admins cannot raise their own privileges', () => {
  let dbHelper;
  let pool;
  let app;
  const orgId = 'org-esc-reg';

  function token(id, role, organizationId) {
    return jwt.sign({ sub: id, id, username: id, role, organization_id: organizationId }, config.JWT_SECRET);
  }

  async function addUser(id, orgRole, platformRole = 'user', organizationId = orgId) {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, $1, $2, 'hash', $3, $4)`,
      [id, `${id}@esc.test`, platformRole, organizationId]
    );
    if (orgRole) {
      await pool.query('INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)', [
        `mem-${id}`,
        id,
        organizationId,
        orgRole
      ]);
    }
    return token(id, platformRole, organizationId);
  }

  async function membershipRole(userId) {
    const res = await pool.query('SELECT role FROM memberships WHERE user_id = $1 AND organization_id = $2', [
      userId,
      orgId
    ]);
    return res.rows[0] ? res.rows[0].role : null;
  }

  async function profile() {
    return (await pool.query('SELECT profile FROM organizations WHERE id = $1', [orgId])).rows[0].profile;
  }

  let admin;
  let owner;
  let superAdmin;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy, profile)
       VALUES ($1, 'Escalation Bank', 'esc-bank', 'deny', 'regulated')`,
      [orgId]
    );
    admin = await addUser('usr-esc-admin', 'admin');
    owner = await addUser('usr-esc-owner', 'owner');
    superAdmin = await addUser('usr-esc-super', null, 'super-admin', 'org-default');
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('an admin cannot re-add themselves as owner', async () => {
    const res = await request(app)
      .post(`/api/organizations/${orgId}/members`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ user_id: 'usr-esc-admin', role: 'owner' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(await membershipRole('usr-esc-admin'), 'admin');
  });

  it('adding an existing member does not change their role', async () => {
    await addUser('usr-esc-member', 'member');

    const res = await request(app)
      .post(`/api/organizations/${orgId}/members`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ user_id: 'usr-esc-member', role: 'admin' });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(await membershipRole('usr-esc-member'), 'member');
  });

  it('an owner can still add a new owner', async () => {
    await addUser('usr-esc-newcomer', null);

    const res = await request(app)
      .post(`/api/organizations/${orgId}/members`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ user_id: 'usr-esc-newcomer', role: 'owner' });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(await membershipRole('usr-esc-newcomer'), 'owner');
  });

  it('neither an admin nor an owner can leave the regulated profile', async () => {
    for (const caller of [admin, owner]) {
      const res = await request(app)
        .put(`/api/organizations/${orgId}`)
        .set('Authorization', `Bearer ${caller}`)
        .send({ profile: 'standard' });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(await profile(), 'regulated');
    }

    const nuke = await request(app).get('/api/nuke/state').set('Authorization', `Bearer ${owner}`);
    assert.strictEqual(nuke.status, 404, 'the high-risk modules stay off');
  });

  it('the platform super-admin can', async () => {
    const res = await request(app)
      .put(`/api/organizations/${orgId}`)
      .set('Authorization', `Bearer ${superAdmin}`)
      .send({ profile: 'standard' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(await profile(), 'standard');
  });
});
