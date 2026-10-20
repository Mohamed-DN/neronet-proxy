const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const TotpService = require('../services/TotpService');
const ConsoleSessionService = require('../services/ConsoleSessionService');

describe('MFA password and enrollment proof boundaries', () => {
  let db, app, passwordHash, rootHash, replacementHash, oldPolicy;
  let sequence = 0;
  const password = 'MfaBoundaryPassword123!';
  const rootPassword = 'MfaBoundaryVaultPassword123!';

  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    oldPolicy = process.env.SOVEREIGN_MFA_MANDATORY;
    process.env.SOVEREIGN_MFA_MANDATORY = 'all';
    [passwordHash, rootHash, replacementHash] = await Promise.all([
      bcrypt.hash(password, 4),
      bcrypt.hash(rootPassword, 4),
      bcrypt.hash('ChangedBoundaryPassword123!', 4)
    ]);
    app = createApp();
  });

  after(async () => {
    if (oldPolicy === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = oldPolicy;
    if (db) await db.cleanup();
  });

  async function account({ enrolled = true } = {}) {
    const id = `usr-mfa-boundary-${++sequence}`;
    const secret = TotpService.generateSecret();
    await db.pool.query(
      `INSERT INTO users(id,username,email,password_hash,password_hash_root,role,status,organization_id,
                         totp_enabled,totp_secret,totp_recovery_codes)
       VALUES($1,$1,$2,$3,$4,'user','active','org-default',$5,$6,'[]'::jsonb)`,
      [id, `${id}@test.local`, passwordHash, rootHash, enrolled, enrolled ? secret : null]
    );
    return { id, secret };
  }

  async function pending(user, suppliedPassword = password) {
    const response = await request(app).post('/api/auth/login').send({ username: user.id, password: suppliedPassword });
    assert.equal(response.status, 200);
    assert.equal(response.body.mfa_required, true);
    assert.equal(response.body.token, undefined);
    assert.equal(typeof response.body.mfa_token, 'string');
    return response.body.mfa_token;
  }

  const verifyPending = (token, secret) =>
    request(app)
      .post('/api/auth/mfa/verify')
      .send({ mfa_token: token, code: TotpService.generateTotp(secret) });
  const setupPending = (token) => request(app).post('/api/auth/mfa/setup').send({ mfa_token: token });
  const setupSession = (token, secret) =>
    request(app)
      .post('/api/auth/mfa/setup')
      .auth(token, { type: 'bearer' })
      .send({ current_code: TotpService.generateTotp(secret) });
  const verifySession = (token, secret) =>
    request(app)
      .post('/api/auth/mfa/verify')
      .auth(token, { type: 'bearer' })
      .send({ code: TotpService.generateTotp(secret) });
  async function familyCount(user) {
    return (await db.pool.query('SELECT count(*)::int AS n FROM console_sessions WHERE user_id=$1', [user.id])).rows[0]
      .n;
  }
  async function directSession(user, suppliedPassword = password) {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        username: user.id,
        password: suppliedPassword,
        totp_code: TotpService.generateTotp(user.secret)
      });
    assert.equal(response.status, 200);
    assert.equal(typeof response.body.token, 'string');
    return response.body.token;
  }

  it('invalidates a password step after changing and restoring the password', async () => {
    const user = await account();
    const stale = await pending(user);
    await db.pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [replacementHash, user.id]);
    await db.pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, user.id]);
    const rejected = await verifyPending(stale, user.secret);
    const fresh = await verifyPending(await pending(user), user.secret);
    assert.deepEqual([rejected.status, fresh.status], [401, 200]);
    assert.equal(await familyCount(user), 1);
  });

  it('does not revive a password step when a suspended account becomes active again', async () => {
    const user = await account();
    const stale = await pending(user);
    await db.pool.query("UPDATE users SET status='suspended' WHERE id=$1", [user.id]);
    await db.pool.query("UPDATE users SET status='active' WHERE id=$1", [user.id]);
    const rejected = await verifyPending(stale, user.secret);
    const fresh = await verifyPending(await pending(user), user.secret);
    assert.deepEqual([rejected.status, fresh.status], [401, 200]);
    assert.equal(await familyCount(user), 1);
  });

  it('cuts outstanding password steps at account-wide session revocation', async () => {
    const user = await account();
    const stale = await pending(user);
    await ConsoleSessionService.revokeUserSessions(user.id);
    const rejected = await verifyPending(stale, user.secret);
    const fresh = await verifyPending(await pending(user), user.secret);
    assert.deepEqual([rejected.status, fresh.status], [401, 200]);
    assert.equal(await familyCount(user), 1);
  });

  it('binds first enrollment to the password step that started it', async () => {
    const user = await account({ enrolled: false });
    const first = await pending(user);
    const second = await pending(user);
    assert.notEqual(first, second);
    const setup = await setupPending(first);
    assert.equal(setup.status, 200);
    const foreign = await verifyPending(second, setup.body.secret);
    const original = await verifyPending(first, setup.body.secret);
    assert.deepEqual([foreign.status, original.status], [401, 200]);
    assert.equal(await familyCount(user), 1);
  });

  it('binds replacement enrollment to its initiating full session family', async () => {
    const user = await account();
    const first = await directSession(user);
    const second = await directSession(user);
    assert.notEqual(jwt.decode(first).sid, jwt.decode(second).sid);
    const setup = await setupSession(first, user.secret);
    assert.equal(setup.status, 200);
    const foreign = await verifySession(second, setup.body.secret);
    const original = await verifySession(first, setup.body.secret);
    assert.deepEqual([foreign.status, original.status], [401, 200]);
    assert.equal(jwt.decode(original.body.token).sid, jwt.decode(first).sid);
    assert.equal(await familyCount(user), 2);
  });

  it('rejects server-expired enrollment while its password-step JWT remains valid', async () => {
    const user = await account({ enrolled: false });
    const token = await pending(user);
    const setup = await setupPending(token);
    assert.equal(setup.status, 200);
    // Additive baseline fixture: old servers have no deadline column and ignore it.
    // Updated servers use the same persisted deadline without changing JWT time.
    await db.pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_expires_at TIMESTAMPTZ');
    await db.pool.query("UPDATE users SET totp_pending_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
      user.id
    ]);
    assert.ok(jwt.decode(token).exp > Math.floor(Date.now() / 1000));
    const response = await verifyPending(token, setup.body.secret);
    assert.equal(response.status, 401);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(
      (await db.pool.query('SELECT totp_enabled FROM users WHERE id=$1', [user.id])).rows[0].totp_enabled,
      false
    );
    assert.equal(await familyCount(user), 0);
  });

  it('preserves root only for a current verified vault-password proof', async () => {
    const standardUser = await account();
    const rootUser = await account();
    const staleUser = await account();
    const standard = await verifyPending(await pending(standardUser), standardUser.secret);
    const root = await verifyPending(await pending(rootUser, rootPassword), rootUser.secret);
    const staleToken = await pending(staleUser, rootPassword);
    await db.pool.query('UPDATE users SET password_hash_root=$1 WHERE id=$2', [replacementHash, staleUser.id]);
    await db.pool.query('UPDATE users SET password_hash_root=$1 WHERE id=$2', [rootHash, staleUser.id]);
    const stale = await verifyPending(staleToken, staleUser.secret);
    assert.deepEqual(
      {
        standardStatus: standard.status,
        standardTier: standard.body.user?.compartment_access,
        rootStatus: root.status,
        rootTier: root.body.user?.compartment_access,
        staleStatus: stale.status
      },
      {
        standardStatus: 200,
        standardTier: 'standard',
        rootStatus: 200,
        rootTier: 'root',
        staleStatus: 401
      }
    );
    assert.equal(jwt.decode(root.body.token).compartment_access, 'root');
    assert.equal(await familyCount(staleUser), 0);
  });

  it('rolls full-session factor replacement and family changes back when replacement persistence fails', async () => {
    const user = await account();
    const token = await directSession(user, rootPassword);
    const sid = jwt.decode(token).sid;
    assert.equal(jwt.decode(token).compartment_access, 'root');
    const setup = await setupSession(token, user.secret);
    assert.equal(setup.status, 200);
    await db.pool.query(`CREATE FUNCTION reject_boundary_refresh_insert() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.user_id = TG_ARGV[0] THEN RAISE EXCEPTION 'fixture replacement insert rejected'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    // user.id is generated by this fixture and contains only ASCII letters, digits and hyphens.
    await db.pool.query(`CREATE TRIGGER fixture_boundary_refresh_insert BEFORE INSERT ON refresh_tokens
      FOR EACH ROW EXECUTE FUNCTION reject_boundary_refresh_insert('${user.id}')`);
    try {
      const failed = await verifySession(token, setup.body.secret);
      assert.equal(failed.status, 503);
      assert.equal(failed.headers['set-cookie'], undefined);
      const factor = (
        await db.pool.query(
          'SELECT totp_enabled,totp_secret=$2 AS original_factor,totp_pending_secret IS NOT NULL AS pending FROM users WHERE id=$1',
          [user.id, user.secret]
        )
      ).rows[0];
      const family = (
        await db.pool.query(
          `SELECT root_grant_id IS NOT NULL AS root,revoked_at IS NULL AS active FROM console_sessions WHERE id=$1`,
          [sid]
        )
      ).rows[0];
      const refresh = (
        await db.pool.query(
          `SELECT count(*)::int AS total,count(*) FILTER(WHERE revoked=FALSE AND revoked_at IS NULL)::int AS active
         FROM refresh_tokens WHERE session_id=$1`,
          [sid]
        )
      ).rows[0];
      assert.deepEqual(
        { factor, family, refresh },
        {
          factor: { totp_enabled: true, original_factor: true, pending: true },
          family: { root: true, active: true },
          refresh: { total: 1, active: 1 }
        }
      );
      assert.equal((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).status, 200);
    } finally {
      await db.pool.query(
        'DROP TRIGGER fixture_boundary_refresh_insert ON refresh_tokens; DROP FUNCTION reject_boundary_refresh_insert()'
      );
    }
    const retried = await verifySession(token, setup.body.secret);
    assert.equal(retried.status, 200);
    assert.equal(jwt.decode(retried.body.token).sid, sid);
    assert.equal(jwt.decode(retried.body.token).compartment_access, 'standard');
    assert.equal(await familyCount(user), 1);
  });

  it('requires first enrollment before public registration opens a session under mandatory MFA', async () => {
    const username = `mfa-boundary-register-${process.pid}-${++sequence}`;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({
        username,
        password,
        email: `${username}@test.local`
      });
    assert.equal(registered.status, 201);
    // Assert only the public decision: never print a session or setup secret on failure.
    assert.deepEqual(
      {
        required: registered.body.mfa_required,
        setupRequired: registered.body.mfa_setup_required,
        hasFullToken: registered.body.token !== undefined,
        hasCookies: registered.headers['set-cookie'] !== undefined
      },
      { required: true, setupRequired: true, hasFullToken: false, hasCookies: false }
    );
    const user = (await db.pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
    assert.equal(await familyCount(user), 0);
    const challenge = registered.body.mfa_token;
    assert.equal(typeof challenge, 'string');
    const setup = await setupPending(challenge);
    assert.equal(setup.status, 200);
    const confirmed = await verifyPending(challenge, setup.body.secret);
    assert.equal(confirmed.status, 200);
    assert.equal((await request(app).get('/api/auth/me').auth(confirmed.body.token, { type: 'bearer' })).status, 200);
    assert.equal(await familyCount(user), 1);
  });
});
