const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { WebSocket } = require('ws');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');
const { refreshCookie } = require('./helpers/refreshCookie');
const { signToken, verifyToken } = require('../middleware/auth');
const config = require('../config/env');

describe('Durable logout across real API processes with independent caches', () => {
  let db;
  let app;
  let replica;
  let replicaUrl;
  let passwordHash;
  let previousMfa;
  let sequence = 0;
  const sockets = new Set();

  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    app = createApp();
    passwordHash = await bcrypt.hash('LogoutDurability123!', 4);
    previousMfa = process.env.SOVEREIGN_MFA_MANDATORY;
    process.env.SOVEREIGN_MFA_MANDATORY = 'off';
    replica = fork(path.join(__dirname, 'helpers/sessionReplica.cjs'), [], {
      env: { ...process.env, SOVEREIGN_VALKEY_NAMESPACE: `logout-replica-${process.pid}` },
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
    for (const socket of sockets) socket.terminate();
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

  async function login() {
    const id = `usr-logout-durability-${++sequence}`;
    await db.pool.query(
      `INSERT INTO users (id,username,email,password_hash,role,status,organization_id)
       VALUES ($1,$1,$2,$3,'user','active','org-default')`,
      [id, `${id}@test.local`, passwordHash]
    );
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: id, password: 'LogoutDurability123!' });
    assert.equal(response.status, 200);
    return { id, token: response.body.token, refreshToken: refreshCookie(response) };
  }

  const me = (token) => request(replicaUrl).get('/api/auth/me').auth(token, { type: 'bearer' });
  const logout = (user, refreshToken = user.refreshToken) =>
    request(app).post('/api/auth/logout').auth(user.token, { type: 'bearer' }).send({ refreshToken });

  async function connect(token) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(replicaUrl.replace('http:', 'ws:') + '/ws/topology', {
        headers: { Authorization: `Bearer ${token}` }
      });
      sockets.add(socket);
      const timer = setTimeout(() => reject(new Error('Socket authentication did not settle')), 3000);
      socket.on('error', () => {});
      socket.once('unexpected-response', (_req, response) => {
        clearTimeout(timer);
        response.resume();
        socket.terminate();
        resolve({ status: response.statusCode });
      });
      socket.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'CONNECTED') {
          clearTimeout(timer);
          resolve({ status: 101, socket });
        }
      });
    });
  }

  it('rejects the logged-out access token on a replica that never received its cache entry', async () => {
    const user = await login();
    assert.equal((await me(user.token)).status, 200);
    assert.equal((await logout(user)).status, 200);
    assert.equal((await me(user.token)).status, 401);
    const row = (await db.pool.query('SELECT * FROM access_token_revocations WHERE user_id=$1', [user.id])).rows[0];
    assert.equal(row.token_hash, crypto.createHash('sha256').update(user.token).digest('hex'));
    assert.equal(new Date(row.expires_at).getTime(), verifyToken(user.token).exp * 1000);
  });

  it('rejects the logged-out full session at the MFA setup endpoint on another process', async () => {
    const user = await login();
    assert.equal((await logout(user)).status, 200);
    const response = await request(replicaUrl)
      .post('/api/auth/mfa/setup')
      .auth(user.token, { type: 'bearer' })
      .send({});
    assert.equal(response.status, 401);
    const row = (await db.pool.query('SELECT totp_pending_secret FROM users WHERE id=$1', [user.id])).rows[0];
    assert.equal(row.totp_pending_secret, null);
  });

  it('rejects a new WebSocket using the logged-out token on another process', async () => {
    const user = await login();
    assert.equal((await logout(user)).status, 200);
    const connection = await connect(user.token);
    connection.socket?.terminate();
    assert.equal(connection.status, 401);
  });

  it('closes an existing socket on its next authenticated message after logout elsewhere', async () => {
    const user = await login();
    const connection = await connect(user.token);
    assert.equal(connection.status, 101);
    assert.equal((await logout(user)).status, 200);
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket revalidation did not settle')), 3000);
      connection.socket.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      connection.socket.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'PONG') {
          clearTimeout(timer);
          resolve('PONG');
        }
      });
      connection.socket.send(JSON.stringify({ type: 'PING' }));
    });
    connection.socket.terminate();
    assert.equal(result, 1008);
  });

  it('retains revocation for a token with more than the former fifteen-minute cache lifetime', async () => {
    const user = await login();
    user.token = signToken({ id: user.id, role: 'user', organization_id: 'org-default' }, '30d');
    assert.equal((await me(user.token)).status, 200);
    assert.equal((await logout(user)).status, 200);
    assert.equal((await me(user.token)).status, 401);
    const row = (await db.pool.query('SELECT expires_at FROM access_token_revocations WHERE user_id=$1', [user.id]))
      .rows[0];
    assert.equal(new Date(row.expires_at).getTime(), verifyToken(user.token).exp * 1000);
  });

  it('does not revoke another account refresh token supplied in the logout body', async () => {
    const user = await login();
    const other = await login();
    assert.equal((await logout(user, other.refreshToken)).status, 200);
    const refreshed = await request(replicaUrl).post('/api/auth/refresh').send({ refreshToken: other.refreshToken });
    assert.equal(refreshed.status, 200);
  });

  it('does not report successful logout when a real PostgreSQL write fails', async () => {
    const user = await login();
    await db.pool.query(`CREATE FUNCTION reject_fixture_refresh_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.user_id = '${user.id}' THEN RAISE EXCEPTION 'fixture revocation write unavailable'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_reject_refresh_revocation BEFORE UPDATE ON refresh_tokens
        FOR EACH ROW EXECUTE FUNCTION reject_fixture_refresh_revocation()`);
    try {
      const response = await logout(user);
      assert.equal(response.status, 503);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal((await me(user.token)).status, 200);
      assert.equal(
        (await db.pool.query('SELECT token_hash FROM access_token_revocations WHERE user_id=$1', [user.id])).rowCount,
        0
      );
      assert.equal(
        (await db.pool.query('SELECT revoked FROM refresh_tokens WHERE user_id=$1', [user.id])).rows[0].revoked,
        false
      );
    } finally {
      await db.pool.query(
        'DROP TRIGGER fixture_reject_refresh_revocation ON refresh_tokens; DROP FUNCTION reject_fixture_refresh_revocation()'
      );
    }
    assert.equal((await logout(user)).status, 200);
    assert.equal((await me(user.token)).status, 401);
  });

  it('keeps an unrelated signed-in account usable after logout on another replica', async () => {
    const user = await login();
    const other = await login();
    assert.equal((await logout(user)).status, 200);
    assert.equal((await me(other.token)).status, 200);
  });

  it('revokes refresh credentials as well when logout receives no refresh cookie or body', async () => {
    const user = await login();
    assert.equal((await logout(user, null)).status, 200);
    const response = await request(replicaUrl).post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    assert.equal(response.status, 401);
  });

  it('keeps legacy signed tokens without expiry revoked without inventing a fifteen-minute expiry', async () => {
    const user = await login();
    user.token = jwt.sign({ sub: user.id, organization_id: 'org-default' }, config.JWT_SECRET);
    assert.equal((await me(user.token)).status, 200);
    assert.equal((await logout(user)).status, 200);
    assert.equal((await me(user.token)).status, 401);
    const row = (await db.pool.query('SELECT expires_at FROM access_token_revocations WHERE user_id=$1', [user.id]))
      .rows[0];
    assert.equal(row.expires_at, null);
  });

  it('fails closed for HTTP, MFA and WebSocket admission while durable revocations cannot be read', async () => {
    const user = await login();
    await db.pool.query('ALTER TABLE access_token_revocations RENAME TO fixture_revocations_unavailable');
    try {
      assert.equal((await me(user.token)).status, 503);
      const mfa = await request(replicaUrl).post('/api/auth/mfa/setup').auth(user.token, { type: 'bearer' }).send({});
      assert.equal(mfa.status, 503);
      const connection = await connect(user.token);
      connection.socket?.terminate();
      assert.equal(connection.status, 503);
    } finally {
      await db.pool.query('ALTER TABLE fixture_revocations_unavailable RENAME TO access_token_revocations');
    }
    assert.equal((await me(user.token)).status, 200);
  });
});
