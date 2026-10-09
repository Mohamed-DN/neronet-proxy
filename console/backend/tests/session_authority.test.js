const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');
const { verifyToken } = require('../middleware/auth');

describe('Current account authority for existing console sessions', () => {
  let db;
  let app;
  let passwordHash;
  let mandatoryMfa;
  let sequence = 0;

  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    app = createApp();
    passwordHash = await bcrypt.hash('AuthorityTest123!', 10);
    mandatoryMfa = process.env.SOVEREIGN_MFA_MANDATORY;
    process.env.SOVEREIGN_MFA_MANDATORY = 'off';
    await db.pool.query(`
      INSERT INTO organizations (id, name, slug) VALUES
        ('org-authority-a', 'Authority A', 'authority-a'),
        ('org-authority-b', 'Authority B', 'authority-b')
    `);
  });

  after(async () => {
    if (mandatoryMfa === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = mandatoryMfa;
    if (db) await db.cleanup();
  });

  async function login(role = 'user') {
    const id = `usr-authority-${++sequence}`;
    await db.pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, status, organization_id)
       VALUES ($1, $1, $2, $3, $4, 'active', 'org-authority-a')`,
      [id, `${id}@test.local`, passwordHash, role]
    );
    const response = await request(app).post('/api/auth/login').send({ username: id, password: 'AuthorityTest123!' });
    assert.equal(response.status, 200);
    assert.ok(response.body.token);
    return { id, token: response.body.token };
  }

  function get(path, token) {
    return request(app).get(path).set('Authorization', `Bearer ${token}`);
  }

  for (const status of ['suspended', 'revoked']) {
    it(`rejects an existing session after its account becomes ${status}`, async () => {
      const user = await login();
      assert.equal((await get('/api/auth/me', user.token)).status, 200);
      await db.pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, user.id]);
      assert.equal((await get('/api/auth/me', user.token)).status, 403);
    });
  }

  it('rejects an existing administrator session after account deletion', async () => {
    const user = await login('super-admin');
    assert.equal((await get('/api/users', user.token)).status, 200);
    await db.pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    assert.equal((await get('/api/users', user.token)).status, 401);
  });

  it('uses the current platform role before granting an administrator read', async () => {
    const user = await login('super-admin');
    assert.equal((await get('/api/users', user.token)).status, 200);
    await db.pool.query("UPDATE users SET role = 'user' WHERE id = $1", [user.id]);
    assert.equal((await get('/api/users', user.token)).status, 403);
  });

  it('uses the current home organization after an account transfer', async () => {
    const user = await login();
    assert.equal((await get('/api/organizations/org-authority-a', user.token)).status, 200);
    await db.pool.query("UPDATE users SET organization_id = 'org-authority-b' WHERE id = $1", [user.id]);
    assert.equal((await get('/api/organizations/org-authority-a', user.token)).status, 404);
    assert.equal((await get('/api/organizations/org-authority-b', user.token)).status, 200);
  });

  it('checks module policy in the current organization after an account transfer', async () => {
    const user = await login();
    assert.equal((await get('/api/nuke/state', user.token)).status, 200);
    await db.pool.query("UPDATE organizations SET profile = 'regulated' WHERE id = 'org-authority-b'");
    await db.pool.query("UPDATE users SET organization_id = 'org-authority-b' WHERE id = $1", [user.id]);
    assert.equal((await get('/api/nuke/state', user.token)).status, 404);
  });

  it('requires a new tenant-context login before enrolling after an organization transfer', async () => {
    const user = await login();
    await db.pool.query("UPDATE users SET organization_id='org-authority-b' WHERE id=$1", [user.id]);
    const refreshed = await request(app)
      .post('/api/auth/login')
      .send({ username: user.id, password: 'AuthorityTest123!' });
    assert.equal(refreshed.status, 200);
    for (const [path, success] of [
      ['/api/nodes', 201],
      ['/api/configs/generate', 200]
    ]) {
      const name = `${user.id}-${success}`;
      const stale = await request(app).post(path).set('Authorization', `Bearer ${user.token}`).send({ name });
      assert.equal(stale.status, 403);
      assert.equal((await db.pool.query('SELECT id FROM nodes WHERE name=$1', [name])).rowCount, 0);
      const fresh = await request(app).post(path).set('Authorization', `Bearer ${refreshed.body.token}`).send({ name });
      assert.equal(fresh.status, success);
      assert.equal(
        (await db.pool.query('SELECT organization_id FROM nodes WHERE name=$1', [name])).rows[0].organization_id,
        'org-authority-b'
      );
    }
  });

  it('does not carry a root-password compartment grant into another organization', async () => {
    const user = await login();
    await db.pool.query('UPDATE users SET password_hash_root=$1 WHERE id=$2', [
      await bcrypt.hash('RootAuthority123!', 4),
      user.id
    ]);
    const rootLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: user.id, password: 'RootAuthority123!' });
    assert.equal(rootLogin.status, 200);
    assert.equal(verifyToken(rootLogin.body.token).compartment_access, 'root');
    await db.pool.query(`INSERT INTO compartments (id,organization_id,name,slug,subnet_cidr,is_hidden) VALUES
      ('cmp-authority-visible','org-authority-b','Visible B','authority-visible','10.93.0.0/24',FALSE),
      ('cmp-authority-hidden','org-authority-b','Hidden B','authority-hidden','10.94.0.0/24',TRUE)`);
    await db.pool.query("UPDATE users SET organization_id='org-authority-b' WHERE id=$1", [user.id]);
    const response = await get('/api/compartments', rootLogin.body.token);
    assert.equal(response.status, 200);
    assert.ok(response.body.compartments.some((c) => c.id === 'cmp-authority-visible'));
    assert.equal(
      response.body.compartments.some((c) => c.id === 'cmp-authority-hidden'),
      false
    );
  });

  it('fails closed when current account authority is unavailable', async () => {
    const user = await login('super-admin');
    const path = '/api/peering/agreements';
    assert.equal((await get(path, user.token)).status, 200);
    await db.pool.query('ALTER TABLE users RENAME TO users_authority_unavailable');
    try {
      assert.equal((await get(path, 'invalid-token')).status, 401);
      assert.equal((await get(path, user.token)).status, 503);
    } finally {
      await db.pool.query('ALTER TABLE users_authority_unavailable RENAME TO users');
    }
    assert.equal((await get(path, user.token)).status, 200);
  });
});
