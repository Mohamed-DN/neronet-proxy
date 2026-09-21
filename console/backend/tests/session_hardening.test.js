const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');
const TotpService = require('../services/TotpService');

describe('WP-105: Console Session Hardening and Mandatory TOTP MFA', () => {
  let dbHelper;
  let app;
  let pool;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('sets HttpOnly SameSite=Strict cookies on user registration and login', async () => {
    const regRes = await request(app).post('/api/auth/register').send({
      username: 'cookie_user',
      password: 'SecurePassword123!',
      email: 'cookie_user@test.local'
    });

    assert.strictEqual(regRes.status, 201);
    const cookies = regRes.headers['set-cookie'] || [];
    assert.strictEqual(cookies.length >= 2, true, 'Must set at least 2 cookies (token & refreshToken)');

    const tokenCookie = cookies.find((c) => c.startsWith('token='));
    const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));

    assert.ok(tokenCookie, 'token cookie must be present');
    assert.ok(tokenCookie.includes('HttpOnly'), 'token cookie must be HttpOnly');
    assert.ok(tokenCookie.includes('SameSite=Strict'), 'token cookie must be SameSite=Strict');
    assert.ok(tokenCookie.includes('Path=/api'), 'token cookie must have Path=/api');

    assert.ok(refreshCookie, 'refreshToken cookie must be present');
    assert.ok(refreshCookie.includes('HttpOnly'), 'refreshToken cookie must be HttpOnly');
    assert.ok(refreshCookie.includes('SameSite=Strict'), 'refreshToken cookie must be SameSite=Strict');
    assert.ok(refreshCookie.includes('Path=/api/auth/refresh'), 'refreshToken cookie must have Path=/api/auth/refresh');
  });

  it('authenticates successfully via HttpOnly cookie without Authorization header', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({
      username: 'cookie_user',
      password: 'SecurePassword123!'
    });

    assert.strictEqual(loginRes.status, 200);
    const token = loginRes.body.token;

    // Call /api/auth/me passing only Cookie header
    const meRes = await request(app).get('/api/auth/me').set('Cookie', `token=${token}`);

    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.body.user.username, 'cookie_user');
  });

  it('enforces current_password on self-service password changes', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({
      username: 'cookie_user',
      password: 'SecurePassword123!'
    });

    const token = loginRes.body.token;
    const userId = loginRes.body.user.id;

    // 1. Password change without current_password should fail with 400
    const failMissing = await request(app)
      .put(`/api/users/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'NewPassword123!' });

    assert.strictEqual(failMissing.status, 400);
    assert.ok(failMissing.body.error.includes('Current password is required'));

    // 2. Password change with wrong current_password should fail with 400
    const failWrong = await request(app)
      .put(`/api/users/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'NewPassword123!', current_password: 'WrongCurrentPassword!' });

    assert.strictEqual(failWrong.status, 400);
    assert.ok(failWrong.body.error.includes('Incorrect current password'));

    // 3. Password change with correct current_password should succeed
    const successChange = await request(app)
      .put(`/api/users/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'NewPassword123!', current_password: 'SecurePassword123!' });

    assert.strictEqual(successChange.status, 200);

    // Verify login with new password works
    const newLogin = await request(app).post('/api/auth/login').send({
      username: 'cookie_user',
      password: 'NewPassword123!'
    });
    assert.strictEqual(newLogin.status, 200);
  });

  it('rotates refresh token on single-use and revokes session family upon replay', async () => {
    // Register separate test user
    const regRes = await request(app).post('/api/auth/register').send({
      username: 'rotation_user',
      password: 'Password123!',
      email: 'rotation_user@test.local'
    });

    const initialRefreshToken = regRes.body.refreshToken;
    assert.ok(initialRefreshToken);

    // 1. First refresh exchange succeeds (single use)
    const refresh1 = await request(app).post('/api/auth/refresh').send({ refreshToken: initialRefreshToken });

    assert.strictEqual(refresh1.status, 200);
    const rotatedRefreshToken = refresh1.body.refreshToken;
    assert.ok(rotatedRefreshToken);
    assert.notStrictEqual(rotatedRefreshToken, initialRefreshToken, 'Refresh token must rotate to a new value');

    // 2. Replay attack: Re-using initialRefreshToken MUST be detected and rejected with 401
    const replayRes = await request(app).post('/api/auth/refresh').send({ refreshToken: initialRefreshToken });

    assert.strictEqual(replayRes.status, 401);
    assert.ok(replayRes.body.error.toLowerCase().includes('revoked'));

    // 3. Replay detection must revoke ALL tokens in that user chain, so rotatedRefreshToken is now also dead!
    const deadChainRes = await request(app).post('/api/auth/refresh').send({ refreshToken: rotatedRefreshToken });

    assert.strictEqual(deadChainRes.status, 401);
  });

  it('re-reads user role dynamically from PostgreSQL on token refresh', async () => {
    const regRes = await request(app).post('/api/auth/register').send({
      username: 'role_change_user',
      password: 'Password123!',
      email: 'role_change@test.local'
    });

    const userId = regRes.body.user.id;
    let refreshToken = regRes.body.refreshToken;
    assert.strictEqual(regRes.body.user.role, 'user');

    // Directly demote/promote in database to super-admin
    await pool.query("UPDATE users SET role = 'super-admin' WHERE id = $1", [userId]);

    // Refresh token
    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });

    assert.strictEqual(refreshRes.status, 200);
    assert.strictEqual(refreshRes.body.user.role, 'super-admin', 'Role must be updated from PostgreSQL');

    // New access token should carry super-admin role
    const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${refreshRes.body.token}`);
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.body.user.role, 'super-admin');
  });

  it('enforces mandatory TOTP MFA setup, challenge, verification, and recovery codes', async () => {
    // 1. Create a user who sets up MFA
    const regRes = await request(app).post('/api/auth/register').send({
      username: 'mfa_admin_user',
      password: 'Password123!',
      email: 'mfa_admin@test.local'
    });

    const userToken = regRes.body.token;

    // 2. Setup MFA
    const setupRes = await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${userToken}`);

    assert.strictEqual(setupRes.status, 200);
    assert.ok(setupRes.body.secret, 'secret must be generated');
    assert.ok(setupRes.body.qrDataUrl, 'qrDataUrl must be generated');
    assert.strictEqual(setupRes.body.recoveryCodes.length, 8, '8 recovery codes must be generated');

    const { secret, recoveryCodes } = setupRes.body;

    // 3. Verify MFA with invalid code -> 401
    const badVerify = await request(app)
      .post('/api/auth/mfa/verify')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code: '000000' });
    assert.strictEqual(badVerify.status, 401);

    // 4. Verify MFA with valid TOTP code
    const validCode = TotpService.generateTotp(secret);
    const goodVerify = await request(app)
      .post('/api/auth/mfa/verify')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code: validCode });

    assert.strictEqual(goodVerify.status, 200);
    assert.ok(goodVerify.body.token);

    // 5. Subsequent login with password only must require MFA
    const loginChallenge = await request(app).post('/api/auth/login').send({
      username: 'mfa_admin_user',
      password: 'Password123!'
    });

    assert.strictEqual(loginChallenge.status, 200);
    assert.strictEqual(loginChallenge.body.mfa_required, true);
    assert.ok(loginChallenge.body.mfa_token);
    assert.strictEqual(
      loginChallenge.body.token,
      undefined,
      'Access token must NOT be returned before MFA verification'
    );

    const mfaToken = loginChallenge.body.mfa_token;

    // Calling protected endpoints with mfa_token must return 401
    const rejectedMe = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${mfaToken}`);
    assert.strictEqual(rejectedMe.status, 401);

    // 6. Complete login using recovery code
    const recoveryToUse = recoveryCodes[0];
    const recoverLogin = await request(app).post('/api/auth/mfa/verify').send({
      mfa_token: mfaToken,
      recovery_code: recoveryToUse
    });

    assert.strictEqual(recoverLogin.status, 200);
    assert.ok(recoverLogin.body.token);

    // 7. Using the SAME recovery code a second time must fail (single-use)
    const secondLoginChallenge = await request(app).post('/api/auth/login').send({
      username: 'mfa_admin_user',
      password: 'Password123!'
    });
    const secondMfaToken = secondLoginChallenge.body.mfa_token;

    const reuseRecovery = await request(app).post('/api/auth/mfa/verify').send({
      mfa_token: secondMfaToken,
      recovery_code: recoveryToUse
    });
    assert.strictEqual(reuseRecovery.status, 401);
  });

  it('blocks super-admin without TOTP from logging in when strict MFA is enforced', async () => {
    // Create admin user without MFA configured
    await pool.query(`
      INSERT INTO users (id, username, email, password_hash, role, status, totp_enabled)
      VALUES ('usr-unconfigured-admin', 'unconfigured_admin', 'unconfigured@darknero.com',
              '${require('bcryptjs').hashSync('AdminPass123!', 10)}', 'super-admin', 'active', FALSE)
      ON CONFLICT DO NOTHING
    `);

    // Attempt login with strict MFA header
    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('X-Enforce-MFA', 'true')
      .send({ username: 'unconfigured_admin', password: 'AdminPass123!' });

    assert.strictEqual(loginRes.status, 200);
    assert.strictEqual(loginRes.body.mfa_required, true);
    assert.strictEqual(loginRes.body.mfa_setup_required, true);
    assert.strictEqual(loginRes.body.token, undefined, 'Access token must not be granted without MFA');
  });

  it('revokes refresh token and clears cookies on logout', async () => {
    const regRes = await request(app).post('/api/auth/register').send({
      username: 'logout_user',
      password: 'Password123!',
      email: 'logout_user@test.local'
    });

    const token = regRes.body.token;
    const refreshToken = regRes.body.refreshToken;

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({ refreshToken });

    assert.strictEqual(logoutRes.status, 200);

    // Attempting to refresh with the logged out token must fail
    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });

    assert.strictEqual(refreshRes.status, 401);
  });
});
