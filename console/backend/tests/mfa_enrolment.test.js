const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const TotpService = require('../services/TotpService');

// /api/auth/mfa/setup accepted the "mfa_pending" token that sign-in hands to anyone
// who knows the password, generated a new TOTP secret, returned it, and switched
// MFA off until verified. With the password alone, a caller replaced the victim's
// authenticator with their own and completed /mfa/verify with it.

describe('MFA enrolment cannot be taken over with the password alone', () => {
  let dbHelper;
  let pool;
  let app;
  let secret;

  const PASSWORD = 'Victim-Password-1!';

  async function passwordStep(username) {
    const res = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.mfa_required, true);
    assert.strictEqual(res.body.token, undefined);
    return res.body.mfa_token;
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    secret = TotpService.generateSecret(20);
    const hash = await bcrypt.hash(PASSWORD, 10);
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, status, totp_enabled, totp_secret)
       VALUES ('usr-mfa-victim', 'mfa_victim', 'victim@mfa.test', $1, 'user', 'active', TRUE, $2),
              ('usr-mfa-new', 'mfa_new', 'new@mfa.test', $1, 'super-admin', 'active', FALSE, NULL)`,
      [hash, secret]
    );
  });

  after(async () => {
    delete process.env.SOVEREIGN_MFA_MANDATORY;
    if (dbHelper) await dbHelper.cleanup();
  });

  it('refuses to re-enrol an account that has MFA, from the password step', async () => {
    const mfaToken = await passwordStep('mfa_victim');

    const setup = await request(app).post('/api/auth/mfa/setup').send({ mfa_token: mfaToken });
    assert.strictEqual(setup.status, 409);
    assert.strictEqual(setup.body.secret, undefined, 'a new secret was handed to someone who only has the password');

    const row = (await pool.query("SELECT totp_enabled, totp_secret FROM users WHERE id = 'usr-mfa-victim'")).rows[0];
    assert.strictEqual(row.totp_enabled, true);
    assert.strictEqual(row.totp_secret, secret);
  });

  it('does not issue a session for a code from an authenticator the caller set up', async () => {
    const mfaToken = await passwordStep('mfa_victim');
    const setup = await request(app).post('/api/auth/mfa/setup').send({ mfa_token: mfaToken });
    const attackerSecret = setup.body.secret || TotpService.generateSecret(20);

    const verify = await request(app)
      .post('/api/auth/mfa/verify')
      .send({ mfa_token: mfaToken, code: TotpService.generateTotp(attackerSecret) });
    assert.strictEqual(verify.status, 401);
    assert.strictEqual(verify.body.token, undefined);
  });

  it('completes sign-in with the enrolled authenticator, once per password step', async () => {
    const mfaToken = await passwordStep('mfa_victim');
    const code = TotpService.generateTotp(secret);

    const first = await request(app).post('/api/auth/mfa/verify').send({ mfa_token: mfaToken, code });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.token);

    const replay = await request(app).post('/api/auth/mfa/verify').send({ mfa_token: mfaToken, code });
    assert.strictEqual(replay.status, 401, 'the password step must be spent by the sign-in it completed');
  });

  it('replaces an enrolled authenticator only from a session and with a current code', async () => {
    const mfaToken = await passwordStep('mfa_victim');
    const session = await request(app)
      .post('/api/auth/mfa/verify')
      .send({ mfa_token: mfaToken, code: TotpService.generateTotp(secret) });
    const auth = { Authorization: `Bearer ${session.body.token}` };

    const withoutCode = await request(app).post('/api/auth/mfa/setup').set(auth).send({});
    assert.strictEqual(withoutCode.status, 401);

    const rotated = await request(app)
      .post('/api/auth/mfa/setup')
      .set(auth)
      .send({ current_code: TotpService.generateTotp(secret) });
    assert.strictEqual(rotated.status, 200);
    assert.ok(rotated.body.secret);

    // Until the new authenticator is confirmed, the old one is the one that counts.
    const row = (await pool.query("SELECT totp_enabled, totp_secret FROM users WHERE id = 'usr-mfa-victim'")).rows[0];
    assert.strictEqual(row.totp_enabled, true);
    assert.strictEqual(row.totp_secret, secret);

    const confirm = await request(app)
      .post('/api/auth/mfa/verify')
      .set(auth)
      .send({ code: TotpService.generateTotp(rotated.body.secret) });
    assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
    const after = (await pool.query("SELECT totp_secret FROM users WHERE id = 'usr-mfa-victim'")).rows[0];
    assert.strictEqual(after.totp_secret, rotated.body.secret);
    secret = rotated.body.secret;
  });

  it('makes an administrator without MFA enrol before any session, when MFA is mandatory', async () => {
    process.env.SOVEREIGN_MFA_MANDATORY = 'admins';
    try {
      const mfaToken = await passwordStep('mfa_new');

      const setup = await request(app).post('/api/auth/mfa/setup').send({ mfa_token: mfaToken });
      assert.strictEqual(setup.status, 200, JSON.stringify(setup.body));

      const verify = await request(app)
        .post('/api/auth/mfa/verify')
        .send({ mfa_token: mfaToken, code: TotpService.generateTotp(setup.body.secret) });
      assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));
      assert.ok(verify.body.token);

      const row = (await pool.query("SELECT totp_enabled FROM users WHERE id = 'usr-mfa-new'")).rows[0];
      assert.strictEqual(row.totp_enabled, true);
    } finally {
      delete process.env.SOVEREIGN_MFA_MANDATORY;
    }
  });

  it('ignores a client header asking for MFA enforcement', async () => {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, status, totp_enabled)
       VALUES ('usr-mfa-hdr', 'mfa_hdr', 'hdr@mfa.test', $1, 'super-admin', 'active', FALSE)`,
      [await bcrypt.hash(PASSWORD, 10)]
    );
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Enforce-MFA', 'true')
      .send({ username: 'mfa_hdr', password: PASSWORD });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mfa_required, undefined, 'policy is the server configuration, not a request header');
    assert.ok(res.body.token);
  });
});
