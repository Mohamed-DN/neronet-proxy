const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDatabase } = require('./helpers/db');
const { bootstrapPostgresAdmin } = require('../db/seed');

const REPAIR = path.resolve(__dirname, '../db/migrations/049_super_admin_organization_membership.sql');

// A production install runs migrations on an empty users table, so migration 017's backfill
// has nobody to move; the admin is then created by the bootstrap. Both must leave the
// super-admin an owner of org-default.
async function ownerRows(pool) {
  const user = await pool.query(`SELECT id, organization_id FROM users WHERE role = 'super-admin'`);
  const mem = await pool.query(
    `SELECT m.user_id, m.organization_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.role = 'super-admin'`
  );
  return { users: user.rows, memberships: mem.rows };
}

async function emptyUsers(pool) {
  await pool.query('DELETE FROM memberships');
  await pool.query(`DELETE FROM users`);
}

describe('super-admin organisation on a fresh install', () => {
  let db;
  before(async () => {
    db = await setupTestDatabase();
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  it('bootstrap makes the admin an owner of org-default, idempotently', async () => {
    await emptyUsers(db.pool);
    assert.equal(await bootstrapPostgresAdmin(db.pool), true);
    assert.equal(await bootstrapPostgresAdmin(db.pool), false);
    const { users, memberships } = await ownerRows(db.pool);
    assert.equal(users.length, 1);
    assert.equal(users[0].organization_id, 'org-default');
    assert.deepEqual(
      memberships.map((m) => [m.user_id, m.organization_id, m.role]),
      [[users[0].id, 'org-default', 'owner']]
    );
  });

  it('repair migration fixes a broken install and is idempotent', async () => {
    await emptyUsers(db.pool);
    await db.pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, status) VALUES
        ('usr-a','a','a@t.local','h','super-admin','active'),
        ('usr-b','b','b@t.local','h','super-admin','active'),
        ('usr-u','u','u@t.local','h','user','active')`
    );
    await db.pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES ('mem-b','usr-b','org-default','owner')`
    );
    const sql = fs.readFileSync(REPAIR, 'utf8');
    await db.pool.query(sql);
    await db.pool.query(sql);
    const { users, memberships } = await ownerRows(db.pool);
    assert.deepEqual(
      users.map((u) => u.organization_id),
      ['org-default', 'org-default']
    );
    assert.deepEqual(memberships.map((m) => [m.user_id, m.role]).sort(), [
      ['usr-a', 'owner'],
      ['usr-b', 'owner']
    ]);
    const plain = await db.pool.query(`SELECT organization_id FROM users WHERE id = 'usr-u'`);
    assert.equal(plain.rows[0].organization_id, null);
    const count = await db.pool.query(`SELECT count(*)::int AS n FROM memberships`);
    assert.equal(count.rows[0].n, 2);
  });
});
