const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const TotpService = require('../services/TotpService');
const request = require('supertest');
const { createApp } = require('../server');
const config = require('../config/env');
const { signToken } = require('../middleware/auth');
const { setupTestDatabase } = require('./helpers/db');
const { refreshCookie } = require('./helpers/refreshCookie');

describe('Durable console session families', () => {
  let db;
  let app;
  let replica;
  let replicaUrl;
  let previousMfa;
  let passwordHash;
  let sequence = 0;

  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    app = createApp();
    previousMfa = process.env.SOVEREIGN_MFA_MANDATORY;
    process.env.SOVEREIGN_MFA_MANDATORY = 'off';
    passwordHash = await bcrypt.hash('SessionFamily123!', 4);
    replica = fork(path.join(__dirname, 'helpers/sessionReplica.cjs'), [], {
      env: { ...process.env, SOVEREIGN_VALKEY_NAMESPACE: `family-replica-${process.pid}` },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    replicaUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Replica did not start')), 10000);
      replica.once('error', reject);
      replica.once('exit', () => reject(new Error('Replica exited before listening')));
      replica.once('message', ({ port }) => {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  });

  after(async () => {
    if (replica?.connected) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => replica.kill('SIGKILL'), 5000);
        replica.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        replica.send('shutdown');
      });
    }
    if (previousMfa === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = previousMfa;
    if (db) await db.cleanup();
  });

  async function account() {
    const id = `usr-family-${++sequence}`;
    await db.pool.query(
      `INSERT INTO users(id,username,email,password_hash,role,status,organization_id)
       VALUES($1,$1,$2,$3,'user','active','org-default')`,
      [id, `${id}@test.local`, passwordHash]
    );
    return id;
  }
  async function login(id) {
    const response = await request(app).post('/api/auth/login').send({ username: id, password: 'SessionFamily123!' });
    assert.equal(response.status, 200);
    return { id, token: response.body.token, refreshToken: refreshCookie(response) };
  }
  async function refresh(session, target = app) {
    const response = await request(target).post('/api/auth/refresh').send({ refreshToken: session.refreshToken });
    return {
      status: response.status,
      id: session.id,
      token: response.body.token,
      refreshToken: refreshCookie(response)
    };
  }
  const me = (token) => request(replicaUrl).get('/api/auth/me').auth(token, { type: 'bearer' });
  const logout = (session, body = { refreshToken: session.refreshToken }) =>
    request(app).post('/api/auth/logout').auth(session.token, { type: 'bearer' }).send(body);

  it('revokes access tokens issued before refresh when the current family logs out', async () => {
    const initial = await login(await account());
    const rotated = await refresh(initial);
    assert.equal(rotated.status, 200);
    assert.equal((await me(initial.token)).status, 200);
    assert.equal((await logout(rotated)).status, 200);
    assert.equal((await me(initial.token)).status, 401);
    assert.equal((await me(rotated.token)).status, 401);
  });

  it('revokes access and refresh credentials from the replayed family', async () => {
    const initial = await login(await account());
    const rotated = await refresh(initial);
    assert.equal(rotated.status, 200);
    assert.equal((await refresh(initial, replicaUrl)).status, 401);
    assert.equal((await me(rotated.token)).status, 401);
    assert.equal((await me(initial.token)).status, 401);
    assert.equal((await refresh(rotated)).status, 401);
  });

  it('does not terminate an independent login of the same account after another family is replayed', async () => {
    const id = await account();
    const initial = await login(id);
    const independent = await login(id);
    assert.equal((await refresh(initial)).status, 200);
    assert.equal((await refresh(initial, replicaUrl)).status, 401);
    assert.equal((await me(independent.token)).status, 200);
    assert.equal((await refresh(independent, replicaUrl)).status, 200);
  });

  it('does not leave the winning access token usable after concurrent refresh replay has settled', async () => {
    const initial = await login(await account());
    const results = await Promise.all([refresh(initial), refresh(initial, replicaUrl)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
    const winner = results.find((r) => r.status === 200);
    assert.equal((await me(winner.token)).status, 401);
    assert.equal((await refresh(winner)).status, 401);
  });

  it('logs out only the current family when no refresh credential is supplied', async () => {
    const id = await account();
    const current = await login(id);
    const independent = await login(id);
    assert.equal((await logout(current, {})).status, 200);
    assert.equal((await refresh(current)).status, 401);
    assert.equal((await refresh(independent, replicaUrl)).status, 200);
  });

  it('requires fresh login for a validly signed legacy access token with no registered family', async () => {
    const id = await account();
    const real = await login(id);
    assert.equal((await me(real.token)).status, 200);
    const legacy = signToken({ id, role: 'user', organization_id: 'org-default' });
    assert.equal((await me(legacy)).status, 401);
  });

  it('rejects a correctly signed token naming an unknown session', async () => {
    const real = await login(await account());
    const token = jwt.sign(
      { ...jwt.decode(real.token), sid: '00000000-0000-4000-8000-000000000000' },
      config.JWT_SECRET
    );
    assert.equal((await me(token)).status, 401);
  });

  it('rejects a session identifier belonging to another account', async () => {
    const first = await login(await account());
    const second = await login(await account());
    const claims = jwt.decode(second.token);
    const token = jwt.sign(
      { ...jwt.decode(first.token), sid: claims.sid || '00000000-0000-4000-8000-000000000001' },
      config.JWT_SECRET
    );
    assert.equal((await me(token)).status, 401);
    assert.equal((await me(second.token)).status, 200);
  });

  it('retains current account-role authority on a renewed session', async () => {
    const initial = await login(await account());
    await db.pool.query("UPDATE users SET role='super-admin' WHERE id=$1", [initial.id]);
    const rotated = await refresh(initial);
    assert.equal(rotated.status, 200);
    assert.equal((await me(rotated.token)).body.user.role, 'super-admin');
  });

  async function rootSession() {
    const id = await account();
    await db.pool.query('UPDATE users SET password_hash_root=$1 WHERE id=$2', [
      await bcrypt.hash('FamilyRoot123!', 4),
      id
    ]);
    const response = await request(app).post('/api/auth/login').send({ username: id, password: 'FamilyRoot123!' });
    assert.equal(response.status, 200);
    const compartment = `cmp-family-hidden-${sequence}`;
    await db.pool.query(
      `INSERT INTO compartments(id,organization_id,name,slug,subnet_cidr,is_hidden)
       VALUES($1,'org-default',$1,$1,$2,TRUE)`,
      [compartment, `10.211.${sequence}.0/24`]
    );
    return { id, token: response.body.token, refreshToken: refreshCookie(response), compartment };
  }
  async function seesHidden(session) {
    const response = await request(replicaUrl).get('/api/compartments').auth(session.token, { type: 'bearer' });
    if (response.status === 401) return false;
    assert.equal(response.status, 200);
    return response.body.compartments.some((c) => c.id === session.compartment);
  }

  it('removes the old root grant when the vault is locked from the same session', async () => {
    const root = await rootSession();
    assert.equal(await seesHidden(root), true);
    const locked = await request(app).post('/api/compartments/lock').auth(root.token, { type: 'bearer' }).send({});
    assert.equal(locked.status, 200);
    assert.equal(await seesHidden(root), false);
  });

  it('does not restore an old root token grant after the vault is unlocked again', async () => {
    const root = await rootSession();
    const locked = await request(app).post('/api/compartments/lock').auth(root.token, { type: 'bearer' }).send({});
    assert.equal(locked.status, 200);
    const unlocked = await request(app)
      .post('/api/compartments/unlock')
      .auth(locked.body.token, { type: 'bearer' })
      .send({ password: 'FamilyRoot123!' });
    assert.equal(unlocked.status, 200);
    assert.equal(await seesHidden({ ...root, token: unlocked.body.token }), true);
    assert.equal(await seesHidden(root), false);
  });

  it('keeps vault-issued refresh credentials out of JSON and in Strict HttpOnly cookies', async () => {
    const root = await rootSession();
    const locked = await request(app).post('/api/compartments/lock').auth(root.token, { type: 'bearer' }).send({});
    assert.equal(locked.status, 200);
    assert.equal(locked.body.refreshToken, undefined);
    const cookie = locked.headers['set-cookie'].find((c) => c.startsWith('refreshToken='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api\/auth\/refresh/);
  });

  it('does not resurrect a root grant after moving an account away and back', async () => {
    const root = await rootSession();
    const org = `org-family-away-${sequence}`;
    await db.pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$1,$1)', [org]);
    assert.equal(await seesHidden(root), true);
    await db.pool.query('UPDATE users SET organization_id=$1 WHERE id=$2', [org, root.id]);
    assert.equal(await seesHidden(root), false);
    await db.pool.query("UPDATE users SET organization_id='org-default' WHERE id=$1", [root.id]);
    assert.equal(await seesHidden(root), false);
  });

  it('revokes all access and refresh families through the account revoke-sessions endpoint', async () => {
    const id = await account();
    const first = await login(id);
    const second = await login(id);
    const other = await login(await account());
    const result = await request(app)
      .post(`/api/users/${id}/revoke-sessions`)
      .auth(first.token, { type: 'bearer' })
      .send({});
    assert.equal(result.status, 200);
    assert.equal((await me(first.token)).status, 401);
    assert.equal((await me(second.token)).status, 401);
    assert.equal((await refresh(first)).status, 401);
    assert.equal((await refresh(second)).status, 401);
    assert.equal((await me(other.token)).status, 200);
    assert.equal((await refresh(other)).status, 200);
  });

  it('keeps full-session MFA confirmation inside its original family', async () => {
    const initial = await login(await account());
    const setup = await request(app).post('/api/auth/mfa/setup').auth(initial.token, { type: 'bearer' }).send({});
    assert.equal(setup.status, 200);
    const confirmed = await request(app)
      .post('/api/auth/mfa/verify')
      .auth(initial.token, { type: 'bearer' })
      .send({ code: TotpService.generateTotp(setup.body.secret) });
    assert.equal(confirmed.status, 200);
    assert.equal(jwt.decode(confirmed.body.token).sid, jwt.decode(initial.token).sid);
    const current = { id: initial.id, token: confirmed.body.token, refreshToken: refreshCookie(confirmed) };
    assert.equal((await logout(current)).status, 200);
    assert.equal((await me(initial.token)).status, 401);
  });

  it('rolls refresh consumption and the root grant back when insertion of its replacement fails', async () => {
    const initial = await rootSession();
    assert.equal(await seesHidden(initial), true);
    await db.pool.query(`CREATE FUNCTION reject_family_refresh_insert() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'fixture replacement insert rejected'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fixture_family_refresh_insert BEFORE INSERT ON refresh_tokens
      FOR EACH ROW EXECUTE FUNCTION reject_family_refresh_insert()`);
    try {
      const response = await request(app).post('/api/auth/refresh').send({ refreshToken: initial.refreshToken });
      assert.equal(response.status, 503);
      assert.equal(response.headers['set-cookie'], undefined);
      const row = (await db.pool.query('SELECT revoked,revoked_at FROM refresh_tokens WHERE user_id=$1', [initial.id]))
        .rows[0];
      assert.equal(row.revoked, false);
      assert.equal(row.revoked_at, null);
      assert.equal((await me(initial.token)).status, 200);
      assert.equal(await seesHidden(initial), true);
    } finally {
      await db.pool.query(
        'DROP TRIGGER fixture_family_refresh_insert ON refresh_tokens; DROP FUNCTION reject_family_refresh_insert()'
      );
    }
    assert.equal((await refresh(initial)).status, 200);
  });

  it('keeps the original absolute family expiry through refresh and vault changes', async () => {
    const initial = await rootSession();
    const sid = jwt.decode(initial.token).sid;
    const expiry = new Date(
      (await db.pool.query('SELECT expires_at FROM console_sessions WHERE id=$1', [sid])).rows[0].expires_at
    ).getTime();
    const rotated = await refresh(initial);
    assert.equal(rotated.status, 200);
    assert.equal(jwt.decode(rotated.refreshToken).exp * 1000, expiry);
    assert.equal(await seesHidden(initial), false);
    const unlocked = await request(app)
      .post('/api/compartments/unlock')
      .auth(rotated.token, { type: 'bearer' })
      .send({ password: 'FamilyRoot123!' });
    assert.equal(unlocked.status, 200);
    assert.equal(jwt.decode(refreshCookie(unlocked)).exp * 1000, expiry);
    assert.equal(
      new Date(
        (await db.pool.query('SELECT expires_at FROM console_sessions WHERE id=$1', [sid])).rows[0].expires_at
      ).getTime(),
      expiry
    );
  });

  it('never restores the previous root proof after the root password changes and is changed back', async () => {
    const root = await rootSession();
    const old = (await db.pool.query('SELECT password_hash_root FROM users WHERE id=$1', [root.id])).rows[0]
      .password_hash_root;
    await db.pool.query('UPDATE users SET password_hash_root=$1 WHERE id=$2', [
      await bcrypt.hash('DifferentRoot123!', 4),
      root.id
    ]);
    assert.equal(await seesHidden(root), false);
    await db.pool.query('UPDATE users SET password_hash_root=$1 WHERE id=$2', [old, root.id]);
    assert.equal(await seesHidden(root), false);
  });

  async function waitForFamilyWaiters(count) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const result = await db.pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%console_sessions%'`);
      if (result.rows[0].count >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('The real family SQL lock did not have the required waiters');
  }

  for (const firstOperation of ['refresh', 'logout']) {
    it(`serializes a waiting ${firstOperation} before the other refresh/logout transition`, async () => {
      const initial = await login(await account());
      const client = await db.pool.connect();
      let pending = [];
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM console_sessions WHERE id=$1 FOR UPDATE', [jwt.decode(initial.token).sid]);
        const operations = {
          refresh: () => refresh(initial, replicaUrl),
          logout: () => logout(initial).then((r) => ({ status: r.status }))
        };
        pending.push(operations[firstOperation]());
        await waitForFamilyWaiters(1);
        pending.push(operations[firstOperation === 'refresh' ? 'logout' : 'refresh']());
        await waitForFamilyWaiters(2);
        await client.query('COMMIT');
        const results = await Promise.all(pending);
        const refreshed = results[firstOperation === 'refresh' ? 0 : 1];
        const closed = results[firstOperation === 'logout' ? 0 : 1];
        assert.equal(closed.status, 200);
        assert.equal(refreshed.status, firstOperation === 'refresh' ? 200 : 401);
        assert.equal((await me(initial.token)).status, 401);
        if (refreshed.status === 200) {
          assert.equal((await me(refreshed.token)).status, 401);
          assert.equal((await refresh(refreshed)).status, 401);
        }
      } finally {
        await client.query('ROLLBACK');
        client.release();
        await Promise.allSettled(pending);
      }
    });
  }

  it('checks actual expiry after waiting for a family lock', async () => {
    const initial = await login(await account());
    const client = await db.pool.connect();
    let pending;
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE console_sessions SET expires_at=clock_timestamp()+interval '0.3 seconds' WHERE id=$1",
        [jwt.decode(initial.token).sid]
      );
      pending = refresh(initial, replicaUrl);
      await waitForFamilyWaiters(1);
      await client.query(
        'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp()))+0.02)) FROM console_sessions WHERE id=$1',
        [jwt.decode(initial.token).sid]
      );
      await client.query('COMMIT');
      assert.equal((await pending).status, 401);
      assert.equal((await me(initial.token)).status, 401);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      if (pending) await pending;
    }
  });

  it('closes a socket authenticated with an earlier access token after family logout', async () => {
    const initial = await login(await account());
    const socket = new WebSocket(replicaUrl.replace('http:', 'ws:') + '/ws/topology', {
      headers: { Authorization: `Bearer ${initial.token}` }
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Socket did not authenticate')), 3000);
        socket.once('error', reject);
        socket.on('message', (data) => {
          if (JSON.parse(data.toString()).type === 'CONNECTED') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const rotated = await refresh(initial);
      assert.equal(rotated.status, 200);
      assert.equal((await logout(rotated)).status, 200);
      const close = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Family socket did not close')), 3000);
        socket.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        socket.on('message', (data) => {
          if (JSON.parse(data.toString()).type === 'PONG') {
            clearTimeout(timer);
            resolve('PONG');
          }
        });
        socket.send(JSON.stringify({ type: 'PING' }));
      });
      assert.equal(close, 1008);
    } finally {
      socket.terminate();
    }
  });

  it('upgrades duplicate legacy refresh rows without deleting data or accepting old sessions', async () => {
    const client = await db.pool.connect();
    const schema = `family_upgrade_${process.pid}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(`CREATE TABLE users(id TEXT PRIMARY KEY,organization_id TEXT,password_hash_root TEXT);
        CREATE TABLE refresh_tokens(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),token_hash TEXT,expires_at TIMESTAMPTZ,revoked BOOLEAN,revoked_at TIMESTAMPTZ);
        INSERT INTO users(id) VALUES('fixture-legacy');
        INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at,revoked) VALUES
          ('one','fixture-legacy','same-hash',NOW()+interval '1 day',FALSE),
          ('two','fixture-legacy','same-hash',NOW()+interval '1 day',FALSE)`);
      await client.query(
        fs.readFileSync(path.join(__dirname, '../db/migrations/039_console_session_families.sql'), 'utf8')
      );
      const rows = (await client.query('SELECT * FROM refresh_tokens ORDER BY id')).rows;
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((r) => r.id),
        ['one', 'two']
      );
      assert.ok(rows.every((r) => r.revoked && r.revoked_at && r.session_id === null && r.token_hash === 'same-hash'));
      assert.equal((await client.query('SELECT count(*)::int AS n FROM console_sessions')).rows[0].n, 0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rolls account-wide family revocation back if a refresh write fails', async () => {
    const first = await login(await account());
    const second = await login(first.id);
    await db.pool.query(`CREATE FUNCTION reject_family_account_revocation() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'fixture account revocation rejected'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fixture_family_account_revocation BEFORE UPDATE ON refresh_tokens
      FOR EACH ROW EXECUTE FUNCTION reject_family_account_revocation()`);
    try {
      const result = await request(app)
        .post(`/api/users/${first.id}/revoke-sessions`)
        .auth(first.token, { type: 'bearer' })
        .send({});
      assert.equal(result.status, 503);
      assert.equal((await me(first.token)).status, 200);
      assert.equal((await me(second.token)).status, 200);
      assert.equal(
        (
          await db.pool.query(
            'SELECT count(*)::int AS n FROM console_sessions WHERE user_id=$1 AND revoked_at IS NOT NULL',
            [first.id]
          )
        ).rows[0].n,
        0
      );
    } finally {
      await db.pool.query(
        'DROP TRIGGER fixture_family_account_revocation ON refresh_tokens; DROP FUNCTION reject_family_account_revocation()'
      );
    }
    assert.equal((await refresh(first)).status, 200);
    assert.equal((await refresh(second)).status, 200);
  });

  it('rejects a vault password proof superseded while the transition waits for its account lock', async () => {
    const root = await rootSession();
    const client = await db.pool.connect();
    let pending;
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET password_hash_root=$1 WHERE id=$2', [
        await bcrypt.hash('ConcurrentRoot123!', 4),
        root.id
      ]);
      pending = request(app)
        .post('/api/compartments/unlock')
        .auth(root.token, { type: 'bearer' })
        .send({ password: 'FamilyRoot123!' })
        .then((r) => r);
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (Date.now() < deadline) {
        const result = await db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM users%FOR SHARE%'`);
        if (result.rows[0].n) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(waiting, 'Vault transition did not reach its real account lock');
      await client.query('COMMIT');
      const response = await pending;
      assert.equal(response.status, 401);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(await seesHidden(root), false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      if (pending) await pending;
    }
    const valid = await request(app)
      .post('/api/compartments/unlock')
      .auth(root.token, { type: 'bearer' })
      .send({ password: 'ConcurrentRoot123!' });
    assert.equal(valid.status, 200);
    assert.equal(await seesHidden({ ...root, token: valid.body.token }), true);
  });

  it('rejects a stored legacy refresh credential without a registered family', async () => {
    const initial = await login(await account());
    const claims = jwt.decode(initial.refreshToken);
    delete claims.sid;
    const legacy = jwt.sign(claims, config.REFRESH_SECRET);
    const crypto = require('node:crypto');
    await db.pool.query(
      `INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at,revoked,session_id)
      VALUES($1,$2,$3,to_timestamp($4),FALSE,NULL)`,
      [`tok-legacy-${sequence}`, initial.id, crypto.createHash('sha256').update(legacy).digest('hex'), claims.exp]
    );
    assert.equal((await request(replicaUrl).post('/api/auth/refresh').send({ refreshToken: legacy })).status, 401);
    assert.equal((await me(initial.token)).status, 200);
    assert.equal((await refresh(initial)).status, 200);
  });
});
