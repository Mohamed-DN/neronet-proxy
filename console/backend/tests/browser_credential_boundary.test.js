const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');

describe('Versioned browser credentials never inherit ambient legacy authority', () => {
  let db;
  let app;
  let passwordHash;
  let previousMfa;
  let sequence = 0;

  before(async () => {
    db = await setupTestDatabase();
    app = createApp();
    passwordHash = await bcrypt.hash('BrowserBoundary123!', 4);
    previousMfa = process.env.SOVEREIGN_MFA_MANDATORY;
    process.env.SOVEREIGN_MFA_MANDATORY = 'off';
  });
  after(async () => {
    if (previousMfa === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = previousMfa;
    if (db) await db.cleanup();
  });

  async function login() {
    const id = `usr-browser-boundary-${++sequence}`;
    await db.pool.query(
      `INSERT INTO users(id,username,email,password_hash,role,status,organization_id)
       VALUES($1,$1,$2,$3,'user','active','org-default')`,
      [id, `${id}@test.local`, passwordHash]
    );
    const response = await request(app).post('/api/auth/login').send({ username: id, password: 'BrowserBoundary123!' });
    assert.equal(response.status, 200);
    assert.ok(response.body.token);
    const cookies = response.headers['set-cookie'].map((value) => value.split(';')[0]);
    return { id, token: response.body.token, cookies };
  }

  it('retains the explicit Bearer API-client contract', async () => {
    const session = await login();
    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${session.token}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.user.id, session.id);
  });

  it('keeps legacy-cookie compatibility explicit until its migration is selected', async () => {
    const session = await login();
    const response = await request(app).get('/api/auth/me').set('Cookie', session.cookies);
    assert.equal(response.status, 200);
    assert.equal(response.body.user.id, session.id);
  });

  it('refuses browser-v2 cookie-only admission instead of selecting a stale account', async () => {
    const session = await login();
    const response = await request(app)
      .get('/api/auth/me')
      .set('X-NeroNet-Browser-Protocol', '2')
      .set('Cookie', session.cookies);
    assert.equal(response.status, 401);
    assert.equal(response.body.user, undefined);
    assert.equal(response.headers['set-cookie'], undefined, 'Refusal must not delete another issuance cookie');
  });

  it('does not turn malformed browser-v2 authorization into legacy-cookie admission', async () => {
    const session = await login();
    const response = await request(app)
      .get('/api/auth/me')
      .set('X-NeroNet-Browser-Protocol', '2')
      .set('Authorization', 'Basic invalid')
      .set('Cookie', session.cookies);
    assert.equal(response.status, 401);
    assert.equal(response.body.user, undefined);
  });

  it('does not use a legacy cookie as the browser-v2 MFA caller', async () => {
    const session = await login();
    const response = await request(app)
      .post('/api/auth/mfa/setup')
      .set('X-NeroNet-Browser-Protocol', '2')
      .set('Cookie', session.cookies)
      .send({});
    assert.equal(response.status, 401);
    assert.equal(response.body.secret, undefined);
  });

  it('does not rotate a legacy refresh cookie without browser-v2 issuance binding', async () => {
    const session = await login();
    const response = await request(app)
      .post('/api/auth/refresh')
      .set('X-NeroNet-Browser-Protocol', '2')
      .set('Cookie', session.cookies)
      .send({});
    assert.equal(response.status, 401);
    assert.equal(response.body.token, undefined);
    assert.equal(response.headers['set-cookie'], undefined);
  });

  it('refuses an unknown browser protocol instead of downgrading to ambient cookies', async () => {
    const session = await login();
    const response = await request(app)
      .get('/api/auth/me')
      .set('X-NeroNet-Browser-Protocol', '999')
      .set('Cookie', session.cookies);
    assert.equal(response.status, 400);
    assert.equal(response.body.user, undefined);
  });
});
