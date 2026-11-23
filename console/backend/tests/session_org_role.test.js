// The sign-in response carries the role in the organisation, like GET /api/auth/me. Without it
// the console shows an organisation administrator the member pages until the page is reloaded.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { settleAuditWrites } = require('../utils/audit');

const ORG = 'org-role-a';
const OTHER = 'org-role-b';
const PASSWORD = 'correct horse battery staple';

describe('Organisation role in the sign-in response', () => {
  let dbHelper;
  let pool;
  let app;
  const savedMfa = process.env.SOVEREIGN_MFA_MANDATORY;

  async function addUser(id, memberships) {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, status, organization_id)
       VALUES ($1, $1, $2, $3, 'user', 'active', $4)`,
      [id, `${id}@role.test`, await bcrypt.hash(PASSWORD, 4), ORG]
    );
    for (const [org, role] of memberships) {
      await pool.query('INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)', [
        `mem-${id}-${org}`,
        id,
        org,
        role
      ]);
    }
  }

  const signIn = (username) => request(app).post('/api/auth/login').send({ username, password: PASSWORD });

  before(async () => {
    process.env.SOVEREIGN_MFA_MANDATORY = 'off';
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    for (const id of [ORG, OTHER]) {
      await pool.query(`INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, $1, $1, 'deny')`, [id]);
    }
    await addUser('role-admin', [[ORG, 'admin']]);
    await addUser('role-member', [[ORG, 'member']]);
    await addUser('role-elsewhere', [[OTHER, 'owner']]);
  });

  after(async () => {
    if (savedMfa === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = savedMfa;
    await settleAuditWrites();
    await dbHelper.cleanup();
  });

  for (const [username, expected] of [
    ['role-admin', 'admin'],
    ['role-member', 'member'],
    ['role-elsewhere', null]
  ]) {
    it(`gives ${username} the role ${expected} at sign-in, as /auth/me does`, async () => {
      const res = await signIn(username);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.user.org_role, expected);
      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
      assert.strictEqual(me.body.user.org_role, expected);
    });
  }

  it('does not put the role in the token: the server reads it fresh on every request', async () => {
    const res = await signIn('role-admin');
    assert.ok(!('org_role' in jwt.decode(res.body.token)));
    // The refresh token travels only as a cookie; the CSRF value beside it is not a JWT.
    const cookies = (res.headers['set-cookie'] || []).map((c) => jwt.decode(decodeURIComponent(c.split(/[=;]/)[1])));
    const decoded = cookies.filter((c) => c && typeof c === 'object');
    assert.ok(decoded.length > 0, 'a refresh token cookie was set');
    for (const claims of decoded) assert.ok(!('org_role' in claims));
  });
});
