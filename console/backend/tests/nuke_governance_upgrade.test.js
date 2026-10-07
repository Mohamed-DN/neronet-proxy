const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupTestDatabase } = require('./helpers/db');
const { runPostgresMigrations } = require('../db/migrator');
const { createApp } = require('../server');
const config = require('../config/env');

describe('Legacy governance accounts upgrade once to revocable memberships', () => {
  let db;
  let pool;
  let app;
  const migration = '033_governance_memberships.sql';
  const actors = {};
  const api = (method, path, id, body) =>
    request(app)[method](`/api/nuke${path}`).set('Authorization', `Bearer ${actors[id]}`).send(body);

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    assert.match(db.dbName, /^neronet_t_/);
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, db.dbName);
    // Model an installation immediately before this upgrade, using its real
    // migration ledger and PostgreSQL runner rather than duplicating the SQL.
    await pool.query('DELETE FROM _migrations WHERE name = $1', [migration]);
    await pool.query(
      "INSERT INTO organizations (id, name, slug) VALUES ('gov-upgrade-a', 'Upgrade A', 'gov-upgrade-a'), ('gov-upgrade-b', 'Upgrade B', 'gov-upgrade-b')"
    );
    for (const [id, org, role] of [
      ['upgrade-owner-a', 'gov-upgrade-a', 'owner'],
      ['upgrade-admin-a', 'gov-upgrade-a', 'admin'],
      ['upgrade-owner-b', 'gov-upgrade-b', 'owner'],
      ['upgrade-admin-b', 'gov-upgrade-b', 'admin'],
      ['upgrade-demoted', 'gov-upgrade-b', 'owner'],
      ['upgrade-null-org', null, 'admin']
    ]) {
      await pool.query(
        "INSERT INTO users (id, username, email, password_hash, organization_id, role) VALUES ($1, $1, $2, 'fixture', $3, $4)",
        [id, `${id}@test.invalid`, org, role]
      );
      actors[id] = jwt.sign({ id, username: id, role, organization_id: org }, config.JWT_SECRET, { expiresIn: '1h' });
    }
    await pool.query(
      "INSERT INTO memberships (id, user_id, organization_id, role) VALUES ('upgrade-existing-member', 'upgrade-demoted', 'gov-upgrade-b', 'member')"
    );
    app = createApp();
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  it('migrates missing legacy memberships, maps a null tenant to default and preserves an existing demotion', async () => {
    assert.equal((await pool.query("SELECT * FROM memberships WHERE user_id = 'upgrade-owner-a'")).rowCount, 0);
    await runPostgresMigrations(pool);
    const rows = (
      await pool.query(
        "SELECT user_id, organization_id, role FROM memberships WHERE user_id LIKE 'upgrade-%' ORDER BY user_id"
      )
    ).rows;
    assert.deepEqual(rows, [
      { user_id: 'upgrade-admin-a', organization_id: 'gov-upgrade-a', role: 'admin' },
      { user_id: 'upgrade-admin-b', organization_id: 'gov-upgrade-b', role: 'admin' },
      { user_id: 'upgrade-demoted', organization_id: 'gov-upgrade-b', role: 'member' },
      { user_id: 'upgrade-null-org', organization_id: 'org-default', role: 'admin' },
      { user_id: 'upgrade-owner-a', organization_id: 'gov-upgrade-a', role: 'owner' },
      { user_id: 'upgrade-owner-b', organization_id: 'gov-upgrade-b', role: 'owner' }
    ]);
    assert.equal((await pool.query('SELECT * FROM _migrations WHERE name = $1', [migration])).rowCount, 1);
  });

  it('keeps legacy owner/admin legal hold and two-person organization destruction working after upgrade', async () => {
    const hold = await api('post', '/legal-hold', 'upgrade-admin-a', {
      organization_id: 'gov-upgrade-a',
      reason: 'Upgrade compatibility'
    });
    assert.equal(hold.status, 201, JSON.stringify(hold.body));
    assert.equal((await api('delete', `/legal-hold/${hold.body.hold.id}`, 'upgrade-owner-a')).status, 200);
    const pending = await api('post', '/dual-auth/request', 'upgrade-owner-a', {
      target_type: 'organization',
      target_id: 'gov-upgrade-a'
    });
    assert.equal(pending.status, 201, JSON.stringify(pending.body));
    const result = await api('post', `/dual-auth/approve/${pending.body.authorization.id}`, 'upgrade-admin-a', {});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(
      (await pool.query("SELECT status FROM organization_keys WHERE organization_id = 'gov-upgrade-a'")).rows[0].status,
      'destroyed'
    );
    assert.ok(
      (await pool.query("SELECT destroyed_at FROM organizations WHERE id = 'gov-upgrade-a'")).rows[0].destroyed_at
    );
  });

  it('never resurrects a removed legacy membership and denies pending approvals and new mutations', async () => {
    const pending = await api('post', '/dual-auth/request', 'upgrade-owner-b', {
      target_type: 'organization',
      target_id: 'gov-upgrade-b'
    });
    assert.equal(pending.status, 201, JSON.stringify(pending.body));
    await pool.query("DELETE FROM memberships WHERE user_id = 'upgrade-admin-b'");
    await runPostgresMigrations(pool);
    assert.equal((await pool.query("SELECT * FROM memberships WHERE user_id = 'upgrade-admin-b'")).rowCount, 0);
    assert.equal(
      (await api('post', `/dual-auth/approve/${pending.body.authorization.id}`, 'upgrade-admin-b', {})).status,
      403
    );
    assert.equal(
      (
        await api('post', '/dual-auth/request', 'upgrade-admin-b', {
          target_type: 'organization',
          target_id: 'gov-upgrade-b'
        })
      ).status,
      403
    );
    assert.equal(
      (
        await api('post', '/legal-hold', 'upgrade-admin-b', {
          organization_id: 'gov-upgrade-b',
          reason: 'Removed membership'
        })
      ).status,
      403
    );
    assert.equal(
      (await pool.query('SELECT status FROM nuke_authorizations WHERE id = $1', [pending.body.authorization.id]))
        .rows[0].status,
      'pending'
    );
    assert.equal(
      (await pool.query("SELECT destroyed_at FROM organizations WHERE id = 'gov-upgrade-b'")).rows[0].destroyed_at,
      null
    );
  });

  it('does not promote an existing member from a residual legacy owner field', async () => {
    const res = await api('post', '/legal-hold', 'upgrade-demoted', {
      organization_id: 'gov-upgrade-b',
      reason: 'Residual owner field'
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    const fallback = await api('post', '/legal-hold', 'upgrade-null-org', {
      organization_id: 'org-default',
      reason: 'Default tenant compatibility'
    });
    assert.equal(fallback.status, 201, JSON.stringify(fallback.body));
  });
});
