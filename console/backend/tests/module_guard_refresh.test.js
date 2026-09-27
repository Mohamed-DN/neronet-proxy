const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { refreshCookie } = require('./helpers/refreshCookie');
const bcrypt = require('bcryptjs');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

// A regulated organisation has the high-risk modules (nuke, deniability, onion)
// switched off. The module guard read the organisation from the access token, and
// the tokens issued by /api/auth/refresh carried none, so after the first refresh
// the guard skipped the check and the modules came back.

describe('Feature module guard across token refresh', () => {
  let dbHelper;
  let pool;
  let app;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy, profile)
       VALUES ('org-guard-reg', 'Guard Regulated', 'guard-reg', 'deny', 'regulated')`
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-guard-reg', 'guardreg', 'guardreg@guard.test', $1, 'user', 'org-guard-reg')`,
      [await bcrypt.hash('Guard-Pass-1!', 4)]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ('mem-guard-reg', 'usr-guard-reg', 'org-guard-reg', 'owner')`
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  async function signIn() {
    const res = await request(app).post('/api/auth/login').send({ username: 'guardreg', password: 'Guard-Pass-1!' });
    assert.strictEqual(res.status, 200);
    return { ...res.body, refreshToken: refreshCookie(res) };
  }

  it('keeps a disabled module hidden after the access token is refreshed', async () => {
    const session = await signIn();

    const before = await request(app).get('/api/nuke/state').set('Authorization', `Bearer ${session.token}`);
    assert.strictEqual(before.status, 404, 'disabled for a regulated organisation');

    const refreshed = await request(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken });
    assert.strictEqual(refreshed.status, 200);

    const after = await request(app).get('/api/nuke/state').set('Authorization', `Bearer ${refreshed.body.token}`);
    assert.strictEqual(after.status, 404, 'still disabled with the refreshed token');
  });

  it('lets only one of two concurrent refreshes with the same token succeed', async () => {
    const session = await signIn();

    const [a, b] = await Promise.all([
      request(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken }),
      request(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken })
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [200, 401], 'a refresh token is single use');
  });
});
