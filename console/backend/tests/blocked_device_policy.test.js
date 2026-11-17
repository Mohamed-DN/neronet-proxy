// A member must not undo an administrator's block by removing the blocked device and
// adding a fresh one. The console page hides the shortcut; the server enforces it.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { settleAuditWrites } = require('../utils/audit');
const { createApp } = require('../server');
const { AUTO_QUARANTINE_REASON } = require('../utils/quarantine');

const key = () => crypto.randomBytes(32).toString('base64');

describe('blocked device policy for members', () => {
  let dbHelper;
  let pool;
  let app;
  let adminToken;
  let memberToken;
  let otherMemberToken;
  const org = 'org-blockpol';
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const register = (token) =>
    request(app)
      .post('/api/devices/profile')
      .set(auth(token))
      .send({ name: 'phone', public_key: key(), preshared_key: key() });
  const remove = (token, id) => request(app).delete(`/api/nodes/${id}`).set(auth(token));
  let n = 0;
  const addDevice = async (id, owner, quarantined, reason) => {
    n += 1;
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role,
                          is_healthy, is_quarantined, quarantine_reason, device_kind)
       VALUES ($1, $2, $3, $1, $4, $5, $6, 'CLIENT_ORIGIN', $7, $8, $9, 'profile')`,
      [id, org, owner, `100.64.77.${n}`, `fd00:77::${n}`, key(), !quarantined, quarantined, reason]
    );
  };

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'Block Pol', 'block-pol', 'deny')
       ON CONFLICT (id) DO NOTHING`,
      [org]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-bp-admin', 'bpadmin', 'a@bp.example.com', 'x', 'admin', $1),
         ('usr-bp-member', 'bpmember', 'm@bp.example.com', 'x', 'user', $1),
         ('usr-bp-other', 'bpother', 'o@bp.example.com', 'x', 'user', $1)
       ON CONFLICT (id) DO NOTHING`,
      [org]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-bp-admin', 'usr-bp-admin', $1, 'admin'),
         ('mem-bp-member', 'usr-bp-member', $1, 'member'),
         ('mem-bp-other', 'usr-bp-other', $1, 'member')
       ON CONFLICT (id) DO NOTHING`,
      [org]
    );
    const gw = key();
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined,
                          profile_gateway_endpoint, is_default_profile_gateway)
       VALUES ('node-bp-gw', $1, 'usr-bp-admin', 'gw', '100.64.76.1', 'fd00:76::1', $2, 'RELAY', TRUE, FALSE, 'gw.example.com:51820', TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [org, gw]
    );
    const token = (id, username, role) => issueConsoleTestToken({ sub: id, id, username, role, organization_id: org });
    adminToken = await token('usr-bp-admin', 'bpadmin', 'admin');
    memberToken = await token('usr-bp-member', 'bpmember', 'user');
    otherMemberToken = await token('usr-bp-other', 'bpother', 'user');
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM nodes WHERE device_kind = 'profile' AND id LIKE 'dev-bp-%'");
  });

  after(async () => {
    await settleAuditWrites();
    if (dbHelper) await dbHelper.cleanup();
  });

  it('refuses a member removing a blocked device, and audits the attempt', async () => {
    await addDevice('dev-bp-1', 'usr-bp-member', true, 'Manual security quarantine');
    const res = await remove(memberToken, 'dev-bp-1');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'device_blocked');
    assert.ok(res.body.message);
    const still = await pool.query("SELECT 1 FROM nodes WHERE id = 'dev-bp-1'");
    assert.strictEqual(still.rows.length, 1);
    await settleAuditWrites();
    const audit = await pool.query(
      "SELECT 1 FROM audit_events WHERE event_type = 'NODE_REMOVE_REFUSED' AND target_id = 'dev-bp-1'"
    );
    assert.strictEqual(audit.rows.length, 1);
  });

  it('still lets a member remove a device that is not blocked', async () => {
    await addDevice('dev-bp-2', 'usr-bp-member', false, null);
    assert.strictEqual((await remove(memberToken, 'dev-bp-2')).status, 200);
  });

  it('lets an administrator remove a blocked device', async () => {
    await addDevice('dev-bp-3', 'usr-bp-member', true, 'Manual security quarantine');
    assert.strictEqual((await remove(adminToken, 'dev-bp-3')).status, 200);
  });

  it('refuses a member who owns a manually blocked device a new profile device', async () => {
    await addDevice('dev-bp-4', 'usr-bp-member', true, 'Lost phone');
    const res = await register(memberToken);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'owner_has_blocked_device');
    assert.ok(res.body.message);
  });

  it('refuses a member with a block that has no recorded reason (an administrator set it)', async () => {
    await addDevice('dev-bp-5', 'usr-bp-member', true, null);
    assert.strictEqual((await register(memberToken)).body.code, 'owner_has_blocked_device');
  });

  it('does not refuse a device blocked only by the risk engine', async () => {
    await addDevice('dev-bp-6', 'usr-bp-member', true, AUTO_QUARANTINE_REASON);
    assert.strictEqual((await register(memberToken)).status, 201);
  });

  it('does not refuse another member, nor an administrator, because of someone else block', async () => {
    await addDevice('dev-bp-7', 'usr-bp-member', true, 'Lost phone');
    assert.strictEqual((await register(otherMemberToken)).status, 201);
    assert.strictEqual((await register(adminToken)).status, 201);
  });

  it('lets a member add a device once the block is lifted', async () => {
    await addDevice('dev-bp-8', 'usr-bp-member', true, 'Lost phone');
    await pool.query("UPDATE nodes SET is_quarantined = FALSE, quarantine_reason = NULL WHERE id = 'dev-bp-8'");
    assert.strictEqual((await register(memberToken)).status, 201);
  });
});
