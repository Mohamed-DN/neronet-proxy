const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const config = require('../config/env');
const TotpService = require('../services/TotpService');

describe('Durable MFA password steps and recovery consumption', () => {
  let db, app, replica, replicaUrl, passwordHash, oldPolicy;
  let sequence = 0;
  const password = 'DurableMfaPassword123!';

  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    oldPolicy = process.env.SOVEREIGN_MFA_MANDATORY;
    process.env.SOVEREIGN_MFA_MANDATORY = 'all';
    passwordHash = await bcrypt.hash(password, 4);
    app = createApp();
    replica = fork(path.join(__dirname, 'helpers/sessionReplica.cjs'), [], {
      env: { ...process.env, SOVEREIGN_VALKEY_NAMESPACE: `mfa-replica-${process.pid}` },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    replicaUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MFA replica did not start')), 10000);
      replica.once('error', reject);
      replica.once('exit', () => reject(new Error('MFA replica exited before listening')));
      replica.once('message', ({ port }) => {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  });
  after(async () => {
    if (replica?.connected)
      await new Promise((resolve) => {
        const timer = setTimeout(() => replica.kill('SIGKILL'), 5000);
        replica.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        replica.send('shutdown');
      });
    if (oldPolicy === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = oldPolicy;
    if (db) await db.cleanup();
  });
  async function account({ enrolled = true } = {}) {
    const id = `usr-mfa-durable-${++sequence}`;
    const secret = TotpService.generateSecret();
    const codes = TotpService.generateRecoveryCodes(2);
    await db.pool.query(
      `INSERT INTO users(id,username,email,password_hash,role,status,organization_id,totp_enabled,totp_secret,totp_recovery_codes)
      VALUES($1,$1,$2,$3,'user','active','org-default',$4,$5,$6::jsonb)`,
      [
        id,
        `${id}@test.local`,
        passwordHash,
        enrolled,
        enrolled ? secret : null,
        JSON.stringify(enrolled ? codes.map((c) => TotpService.hashRecoveryCode(c)) : [])
      ]
    );
    return { id, secret, codes };
  }
  async function pending(user) {
    const r = await request(app).post('/api/auth/login').send({ username: user.id, password });
    assert.equal(r.status, 200);
    assert.equal(r.body.mfa_required, true);
    assert.equal(r.body.token, undefined);
    return r.body.mfa_token;
  }
  const verify = (target, token, body) =>
    request(target)
      .post('/api/auth/mfa/verify')
      .send({ mfa_token: token, ...body });
  async function familyCount(id) {
    return (await db.pool.query('SELECT count(*)::int AS n FROM console_sessions WHERE user_id=$1', [id])).rows[0].n;
  }
  async function waitForUserWaiters(count) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%users%'`);
      if (rows.rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('MFA requests did not reach the real account SQL lock');
  }
  async function racing(user, tokenA, tokenB, bodyA, bodyB) {
    const client = await db.pool.connect();
    let running = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      running = [verify(app, tokenA, bodyA).then((r) => r), verify(replicaUrl, tokenB, bodyB).then((r) => r)];
      await waitForUserWaiters(2);
      await client.query('COMMIT');
      return await Promise.all(running);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await Promise.allSettled(running);
    }
  }

  it('rejects a consumed password step on a second process with no matching cache entry', async () => {
    const user = await account();
    const token = await pending(user);
    assert.equal((await verify(app, token, { code: TotpService.generateTotp(user.secret) })).status, 200);
    assert.equal((await verify(replicaUrl, token, { code: TotpService.generateTotp(user.secret) })).status, 401);
    assert.equal(await familyCount(user.id), 1);
  });

  it('admits the same password step only once across concurrent processes', async () => {
    const user = await account();
    const token = await pending(user);
    const code = TotpService.generateTotp(user.secret);
    // A pre-held account lock queues consumption after both requests have arrived.
    const result = await racing(user, token, token, { code }, { code });
    assert.deepEqual(result.map((r) => r.status).sort(), [200, 401]);
    assert.equal(await familyCount(user.id), 1);
  });

  it('consumes one recovery code once even with independent password steps', async () => {
    const user = await account();
    const a = await pending(user);
    const b = await pending(user);
    const result = await racing(user, a, b, { recovery_code: user.codes[0] }, { recovery_code: user.codes[0] });
    assert.deepEqual(result.map((r) => r.status).sort(), [200, 401]);
    assert.equal(await familyCount(user.id), 1);
  });

  it('does not resurrect either recovery code when distinct codes are consumed concurrently', async () => {
    const user = await account();
    const a = await pending(user);
    const b = await pending(user);
    const result = await racing(user, a, b, { recovery_code: user.codes[0] }, { recovery_code: user.codes[1] });
    assert.deepEqual(
      result.map((r) => r.status),
      [200, 200]
    );
    const rows = await db.pool.query('SELECT jsonb_array_length(totp_recovery_codes) AS n FROM users WHERE id=$1', [
      user.id
    ]);
    assert.equal(rows.rows[0].n, 0);
    assert.equal(await familyCount(user.id), 2);
  });

  it('requires a registered password step rather than an arbitrary valid MFA signature', async () => {
    const user = await account();
    const token = jwt.sign({ sub: user.id, type: 'mfa_pending' }, config.JWT_SECRET, {
      expiresIn: '5m',
      jwtid: require('node:crypto').randomUUID()
    });
    assert.equal((await verify(replicaUrl, token, { code: TotpService.generateTotp(user.secret) })).status, 401);
    assert.equal(await familyCount(user.id), 0);
  });

  it('binds the registered challenge to the exact issued token bytes', async () => {
    const user = await account();
    const issued = await pending(user);
    const decoded = jwt.decode(issued);
    const unissued = jwt.sign(
      { sub: user.id, type: 'mfa_pending', marker: 'not-the-issued-proof' },
      config.JWT_SECRET,
      { expiresIn: '5m', jwtid: decoded.jti }
    );
    assert.notEqual(issued, unissued);
    assert.equal((await verify(replicaUrl, unissued, { code: TotpService.generateTotp(user.secret) })).status, 401);
    assert.equal(await familyCount(user.id), 0);
    assert.equal((await verify(app, issued, { code: TotpService.generateTotp(user.secret) })).status, 200);
  });

  it('does not carry a password proof across a tenant transfer and return', async () => {
    const user = await account();
    const token = await pending(user);
    const org = `org-mfa-away-${sequence}`;
    await db.pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$1,$1)', [org]);
    await db.pool.query('UPDATE users SET organization_id=$1 WHERE id=$2', [org, user.id]);
    await db.pool.query("UPDATE users SET organization_id='org-default' WHERE id=$1", [user.id]);
    assert.equal((await verify(replicaUrl, token, { code: TotpService.generateTotp(user.secret) })).status, 401);
    assert.equal(await familyCount(user.id), 0);
  });

  it('keeps an invalid OTP from spending the valid password step', async () => {
    const user = await account();
    const token = await pending(user);
    assert.equal((await verify(app, token, { code: 'not-an-otp' })).status, 401);
    assert.equal((await verify(replicaUrl, token, { code: TotpService.generateTotp(user.secret) })).status, 200);
    assert.equal(await familyCount(user.id), 1);
  });

  it('keeps independently issued password steps usable after one is completed', async () => {
    const user = await account();
    const a = await pending(user);
    const b = await pending(user);
    assert.notEqual(a, b);
    assert.equal((await verify(app, a, { code: TotpService.generateTotp(user.secret) })).status, 200);
    assert.equal((await verify(replicaUrl, b, { code: TotpService.generateTotp(user.secret) })).status, 200);
    assert.equal(await familyCount(user.id), 2);
  });

  async function changeCredentialsWhileLoginWaits(directOtp) {
    const user = await account();
    const client = await db.pool.connect();
    let running;
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      running = request(app)
        .post('/api/auth/login')
        .send({
          username: user.id,
          password,
          ...(directOtp ? { totp_code: TotpService.generateTotp(user.secret) } : {})
        })
        .then((r) => r);
      await waitForUserWaiters(1);
      const replacement = await bcrypt.hash('ChangedWhilePasswordWasChecked123!', 4);
      await client.query('UPDATE users SET password_hash=$2 WHERE id=$1', [user.id, replacement]);
      await client.query('UPDATE users SET password_hash=$2 WHERE id=$1', [user.id, passwordHash]);
      await client.query('COMMIT');
      const result = await running;
      assert.equal(result.status, 401);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.equal(await familyCount(user.id), 0);
      assert.equal(
        (await db.pool.query('SELECT count(*)::int AS n FROM console_mfa_challenges WHERE user_id=$1', [user.id]))
          .rows[0].n,
        0
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
      if (running) await Promise.allSettled([running]);
    }
  }

  it('does not register a new password step from a proof changed while waiting for admission', async () => {
    await changeCredentialsWhileLoginWaits(false);
  });

  it('does not issue a direct OTP session from a password proof changed during admission', async () => {
    await changeCredentialsWhileLoginWaits(true);
  });

  it('uses the database enrollment deadline even when the API clock runs behind', async () => {
    const user = await account({ enrolled: false });
    const token = await pending(user);
    const setup = await request(app).post('/api/auth/mfa/setup').send({ mfa_token: token });
    assert.equal(setup.status, 200);
    await db.pool.query("UPDATE users SET totp_pending_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
      user.id
    ]);
    const originalNow = Date.now;
    Date.now = () => originalNow() - 60000;
    try {
      const body = { code: TotpService.generateTotp(setup.body.secret) };
      assert.equal((await verify(app, token, body)).status, 401);
      // Positive control: the same process, proof and clock can confirm a fresh
      // SQL lease. Rejection above must come from the deadline, not a bad OTP.
      await db.pool.query(
        "UPDATE users SET totp_pending_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",
        [user.id]
      );
      assert.equal((await verify(app, token, body)).status, 200);
    } finally {
      Date.now = originalNow;
    }
  });

  it('fails unavailable challenge authority closed and can retry after SQL reads recover', async () => {
    const user = await account();
    const token = await pending(user);
    await db.pool.query('ALTER TABLE console_mfa_challenges RENAME TO fixture_unavailable_mfa_challenges');
    try {
      const result = await verify(app, token, { code: TotpService.generateTotp(user.secret) });
      assert.equal(result.status, 503);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.equal(await familyCount(user.id), 0);
    } finally {
      await db.pool.query('ALTER TABLE fixture_unavailable_mfa_challenges RENAME TO console_mfa_challenges');
    }
    assert.equal((await verify(replicaUrl, token, { code: TotpService.generateTotp(user.secret) })).status, 200);
  });

  for (const confirmationFirst of [true, false]) {
    it(`serializes full-session confirmation ${confirmationFirst ? 'before' : 'after'} a competing logout`, async () => {
      const user = await account();
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: user.id, password, totp_code: TotpService.generateTotp(user.secret) });
      assert.equal(login.status, 200);
      const token = login.body.token;
      const sid = jwt.decode(token).sid;
      const setup = await request(app)
        .post('/api/auth/mfa/setup')
        .auth(token, { type: 'bearer' })
        .send({ current_code: TotpService.generateTotp(user.secret) });
      assert.equal(setup.status, 200);
      const confirm = () =>
        request(app)
          .post('/api/auth/mfa/verify')
          .auth(token, { type: 'bearer' })
          .send({ code: TotpService.generateTotp(setup.body.secret) })
          .then((r) => r);
      const logout = () =>
        request(replicaUrl)
          .post('/api/auth/logout')
          .auth(token, { type: 'bearer' })
          .send({})
          .then((r) => r);
      const client = await db.pool.connect();
      let running = [];
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
        running.push(confirmationFirst ? confirm() : logout());
        await waitForUserWaiters(1);
        running.push(confirmationFirst ? logout() : confirm());
        await waitForUserWaiters(2);
        await client.query('COMMIT');
        const results = await Promise.all(running);
        const confirmation = results[confirmationFirst ? 0 : 1];
        const signedOut = results[confirmationFirst ? 1 : 0];
        assert.equal(signedOut.status, 200);
        assert.equal(confirmation.status, confirmationFirst ? 200 : 401);
        if (confirmationFirst) {
          assert.equal(jwt.decode(confirmation.body.token).sid, sid);
          assert.equal(
            (await request(replicaUrl).get('/api/auth/me').auth(confirmation.body.token, { type: 'bearer' })).status,
            401
          );
        } else {
          assert.equal(confirmation.headers['set-cookie'], undefined);
          const state = (
            await db.pool.query(
              'SELECT totp_secret=$2 AS original,totp_pending_secret IS NOT NULL AS pending FROM users WHERE id=$1',
              [user.id, user.secret]
            )
          ).rows[0];
          assert.deepEqual(state, { original: true, pending: true });
        }
        assert.equal(await familyCount(user.id), 1);
        assert.equal(
          (await db.pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM console_sessions WHERE id=$1', [sid]))
            .rows[0].revoked,
          true
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
        await Promise.allSettled(running);
      }
    });
  }

  async function rejectSessionInsertion() {
    await db.pool.query(`CREATE FUNCTION reject_mfa_session_insert() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'fixture session insert rejected'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fixture_mfa_session_insert BEFORE INSERT ON refresh_tokens
      FOR EACH ROW EXECUTE FUNCTION reject_mfa_session_insert()`);
  }
  async function allowSessionInsertion() {
    await db.pool.query(
      'DROP TRIGGER fixture_mfa_session_insert ON refresh_tokens; DROP FUNCTION reject_mfa_session_insert()'
    );
  }

  it('rolls password-step consumption back when session persistence fails', async () => {
    const user = await account();
    const token = await pending(user);
    await rejectSessionInsertion();
    try {
      const failed = await verify(app, token, { code: TotpService.generateTotp(user.secret) });
      assert.equal(failed.status, 503);
      assert.equal(failed.headers['set-cookie'], undefined);
      assert.equal(await familyCount(user.id), 0);
    } finally {
      await allowSessionInsertion();
    }
    assert.equal((await verify(app, token, { code: TotpService.generateTotp(user.secret) })).status, 200);
  });

  it('rolls recovery consumption back together with a failed session write', async () => {
    const user = await account();
    const token = await pending(user);
    await rejectSessionInsertion();
    try {
      const failed = await verify(app, token, { recovery_code: user.codes[0] });
      assert.equal(failed.status, 503);
      assert.equal(failed.headers['set-cookie'], undefined);
      const row = (
        await db.pool.query('SELECT jsonb_array_length(totp_recovery_codes) AS n FROM users WHERE id=$1', [user.id])
      ).rows[0];
      assert.equal(row.n, 2);
      assert.equal(await familyCount(user.id), 0);
    } finally {
      await allowSessionInsertion();
    }
    assert.equal((await verify(app, token, { recovery_code: user.codes[0] })).status, 200);
  });

  it('rolls first authenticator enrollment back with a failed session write', async () => {
    const user = await account({ enrolled: false });
    const token = await pending(user);
    const setup = await request(app).post('/api/auth/mfa/setup').send({ mfa_token: token });
    assert.equal(setup.status, 200);
    await rejectSessionInsertion();
    try {
      const failed = await verify(app, token, { code: TotpService.generateTotp(setup.body.secret) });
      assert.equal(failed.status, 503);
      assert.equal(failed.headers['set-cookie'], undefined);
      const row = (
        await db.pool.query('SELECT totp_enabled,totp_pending_secret IS NOT NULL AS pending FROM users WHERE id=$1', [
          user.id
        ])
      ).rows[0];
      assert.equal(row.totp_enabled, false);
      assert.equal(row.pending, true);
      assert.equal(await familyCount(user.id), 0);
    } finally {
      await allowSessionInsertion();
    }
    assert.equal((await verify(app, token, { code: TotpService.generateTotp(setup.body.secret) })).status, 200);
  });
});
