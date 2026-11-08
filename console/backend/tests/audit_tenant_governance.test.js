const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { settleAuditWrites } = require('../utils/audit');
const { createApp } = require('../server');

describe('Organization governance audit uses the mutated resource scope', () => {
  let db, app, token;
  const org = 'org-audit-governance-target';
  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    await db.pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$1,$1)', [org]);
    app = createApp();
    token = await issueConsoleTestToken({
      id: 'usr-admin',
      username: 'admin',
      role: 'super-admin',
      organization_id: 'org-default'
    });
  });
  after(async () => {
    await settleAuditWrites();
    if (db) await db.cleanup();
  });
  async function event(type, target) {
    await settleAuditWrites();
    const result = await db.pool.query(
      'SELECT * FROM audit_events WHERE event_type=$1 AND target_id=$2 ORDER BY id DESC LIMIT 1',
      [type, target]
    );
    assert.equal(result.rowCount, 1, `${type} must be persisted by the actual handler`);
    return result.rows[0];
  }
  async function user(suffix) {
    const id = `usr-audit-governance-${suffix}`;
    await db.pool.query(
      "INSERT INTO users(id,username,email,password_hash,organization_id) VALUES($1,$1,$2,'hash','org-default')",
      [id, `${id}@test.local`]
    );
    return id;
  }
  it('organization creation is attributed to the created organization', async () => {
    const response = await request(app)
      .post('/api/organizations')
      .auth(token, { type: 'bearer' })
      .send({ name: 'Audit governance created' });
    assert.equal(response.status, 201);
    const id = response.body.organization.id;
    assert.equal((await event('ORG_CREATE', id)).organization_id, id);
  });
  it('organization updates are attributed to the target rather than the platform actor tenant', async () => {
    const response = await request(app)
      .put(`/api/organizations/${org}`)
      .auth(token, { type: 'bearer' })
      .send({ name: 'Audit governance updated', organization_id: 'org-default' });
    assert.equal(response.status, 200);
    assert.equal((await event('ORG_UPDATE', org)).organization_id, org);
  });
  it('organization deletion preserves the deleted resource scope without a foreign key', async () => {
    const id = 'org-audit-governance-delete';
    await db.pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$1,$1)', [id]);
    const response = await request(app).delete(`/api/organizations/${id}`).auth(token, { type: 'bearer' });
    assert.equal(response.status, 200);
    assert.equal((await db.pool.query('SELECT id FROM organizations WHERE id=$1', [id])).rowCount, 0);
    assert.equal((await event('ORG_DELETE', id)).organization_id, id);
  });
  it('does not manufacture a successful organization update when no resource was changed', async () => {
    const id = 'org-audit-governance-absent';
    const response = await request(app)
      .put(`/api/organizations/${id}`)
      .auth(token, { type: 'bearer' })
      .send({ name: 'Never persisted' });
    assert.equal(response.status, 404);
    await settleAuditWrites();
    assert.equal(
      (await db.pool.query("SELECT id FROM audit_events WHERE event_type='ORG_UPDATE' AND target_id=$1", [id]))
        .rowCount,
      0
    );
  });
  it('member addition uses the membership organization even when the user is active elsewhere', async () => {
    const id = await user('add');
    const response = await request(app)
      .post(`/api/organizations/${org}/members`)
      .auth(token, { type: 'bearer' })
      .send({ user_id: id, role: 'member' });
    assert.equal(response.status, 201);
    assert.equal(response.body.membership.organization_id, org);
    assert.equal((await event('ORG_MEMBER_ADD', id)).organization_id, org);
  });
  it('member role changes use the updated membership scope', async () => {
    const id = await user('change');
    await db.pool.query("INSERT INTO memberships(id,user_id,organization_id,role) VALUES($1,$2,$3,'member')", [
      `mem-${id}`,
      id,
      org
    ]);
    const response = await request(app)
      .put(`/api/organizations/${org}/members/${id}`)
      .auth(token, { type: 'bearer' })
      .send({ role: 'auditor' });
    assert.equal(response.status, 200);
    assert.equal((await event('ORG_MEMBER_ROLE_CHANGE', id)).organization_id, org);
  });
  it('member removal retains the deleted membership scope', async () => {
    const id = await user('remove');
    await db.pool.query("INSERT INTO memberships(id,user_id,organization_id,role) VALUES($1,$2,$3,'member')", [
      `mem-${id}`,
      id,
      org
    ]);
    const response = await request(app)
      .delete(`/api/organizations/${org}/members/${id}`)
      .auth(token, { type: 'bearer' });
    assert.equal(response.status, 200);
    assert.equal((await event('ORG_MEMBER_REMOVE', id)).organization_id, org);
  });
});
