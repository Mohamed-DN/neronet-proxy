const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { WebSocket } = require('ws');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');
const { signToken } = require('../middleware/auth');
const { blacklistToken } = require('../db/valkey');
const { initTopologyWebSocket, closeTopologyWebSocket, broadcastTopologyMessage } = require('../ws/topologyServer');

describe('Current authority on real topology WebSocket connections', () => {
  let db;
  let app;
  let server;
  let endpoint;
  let passwordHash;
  let sequence = 0;
  let mfaPolicy;
  const sockets = new Set();

  before(async () => {
    db = await setupTestDatabase();
    app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    initTopologyWebSocket(server);
    endpoint = `ws://127.0.0.1:${server.address().port}/ws/topology`;
    passwordHash = await bcrypt.hash('SocketAuthority123!', 4);
    mfaPolicy = process.env.SOVEREIGN_MFA_MANDATORY;
    process.env.SOVEREIGN_MFA_MANDATORY = 'off';
    await db.pool.query(`INSERT INTO organizations (id,name,slug) VALUES
      ('org-ws-authority-a','Socket A','ws-authority-a'),
      ('org-ws-authority-b','Socket B','ws-authority-b')`);
  });

  after(async () => {
    for (const socket of sockets) socket.terminate();
    closeTopologyWebSocket();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mfaPolicy === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = mfaPolicy;
    if (db) await db.cleanup();
  });

  async function login(role = 'user', organizationRole = 'admin') {
    const id = `usr-ws-authority-${++sequence}`;
    await db.pool.query(
      `INSERT INTO users (id,username,email,password_hash,role,status,organization_id)
       VALUES ($1,$1,$2,$3,$4,'active','org-ws-authority-a')`,
      [id, `${id}@test.local`, passwordHash, role]
    );
    await db.pool.query(
      `INSERT INTO memberships (id,user_id,organization_id,role)
       VALUES ($1,$2,'org-ws-authority-a',$3)`,
      [`mem-${id}`, id, organizationRole]
    );
    const response = await request(app).post('/api/auth/login').send({ username: id, password: 'SocketAuthority123!' });
    assert.equal(response.status, 200);
    assert.ok(response.body.token);
    return { id, token: response.body.token };
  }

  async function connect(token) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` } });
      sockets.add(socket);
      const timer = setTimeout(() => reject(new Error('Socket authentication did not settle')), 3000);
      socket.on('error', () => {});
      socket.on('unexpected-response', (_req, response) => {
        response.resume();
        clearTimeout(timer);
        resolve({ status: response.statusCode });
        socket.terminate();
      });
      const messages = [];
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        messages.push(message);
        if (message.type === 'CONNECTED') {
          clearTimeout(timer);
          resolve({ status: 101, socket, messages, user: message.user });
        }
      });
    });
  }

  async function flush(connection) {
    if (connection.socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket delivery barrier timed out')), 2000);
      const done = () => {
        clearTimeout(timer);
        connection.socket.off('message', onMessage);
        connection.socket.off('close', done);
        resolve();
      };
      const onMessage = (data) => {
        if (JSON.parse(data.toString()).type === 'PONG') done();
      };
      connection.socket.on('message', onMessage);
      connection.socket.once('close', done);
      if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.send(JSON.stringify({ type: 'PING' }));
      }
    });
  }

  const event = (marker, org, userId = 'someone-else') => ({
    event: marker,
    organization_id: org,
    user_id: userId
  });
  const delivered = (connection, marker) => connection.messages.some((m) => m.event === marker);

  for (const status of ['suspended', 'revoked']) {
    it(`rejects a new socket for a previously authenticated ${status} account`, async () => {
      const user = await login();
      await db.pool.query('UPDATE users SET status=$1 WHERE id=$2', [status, user.id]);
      assert.equal((await connect(user.token)).status, 403);
    });
  }

  it('rejects a socket for a deleted account', async () => {
    const user = await login('super-admin');
    await db.pool.query('DELETE FROM users WHERE id=$1', [user.id]);
    assert.equal((await connect(user.token)).status, 401);
  });

  it('greets a demoted administrator with its current platform role', async () => {
    const user = await login('super-admin');
    await db.pool.query("UPDATE users SET role='user' WHERE id=$1", [user.id]);
    const connection = await connect(user.token);
    assert.equal(connection.status, 101);
    assert.equal(connection.user.role, 'user');
    connection.socket.terminate();
  });

  it('does not deliver foreign events after a connected administrator is demoted', async () => {
    const user = await login('super-admin');
    const connection = await connect(user.token);
    assert.equal(connection.status, 101);
    await broadcastTopologyMessage(event('BEFORE_DEMOTION', 'org-ws-authority-b'));
    await flush(connection);
    assert.ok(delivered(connection, 'BEFORE_DEMOTION'));
    await db.pool.query("UPDATE users SET role='user' WHERE id=$1", [user.id]);
    await broadcastTopologyMessage(event('AFTER_DEMOTION', 'org-ws-authority-b'));
    await flush(connection);
    assert.equal(delivered(connection, 'AFTER_DEMOTION'), false);
    connection.socket.terminate();
  });

  it('uses the new organization on an already connected socket', async () => {
    const user = await login();
    const connection = await connect(user.token);
    await db.pool.query("UPDATE users SET organization_id='org-ws-authority-b' WHERE id=$1", [user.id]);
    await db.pool.query(
      "INSERT INTO memberships (id,user_id,organization_id,role) VALUES ($1,$2,'org-ws-authority-b','admin')",
      [`mem-new-${user.id}`, user.id]
    );
    await broadcastTopologyMessage(event('OLD_ORGANIZATION', 'org-ws-authority-a'));
    await broadcastTopologyMessage(event('NEW_ORGANIZATION', 'org-ws-authority-b'));
    await flush(connection);
    assert.equal(delivered(connection, 'OLD_ORGANIZATION'), false);
    assert.equal(delivered(connection, 'NEW_ORGANIZATION'), true);
    connection.socket.terminate();
  });

  it('uses current membership permissions on an already connected socket', async () => {
    const user = await login();
    const connection = await connect(user.token);
    await db.pool.query("UPDATE memberships SET role='member' WHERE user_id=$1", [user.id]);
    await broadcastTopologyMessage(event('OTHER_ACCOUNT', 'org-ws-authority-a'));
    await broadcastTopologyMessage(event('OWN_ACCOUNT', 'org-ws-authority-a', user.id));
    await flush(connection);
    assert.equal(delivered(connection, 'OTHER_ACCOUNT'), false);
    assert.equal(delivered(connection, 'OWN_ACCOUNT'), true);
    connection.socket.terminate();
  });

  it('does not deliver events after the connected account is suspended', async () => {
    const user = await login();
    const connection = await connect(user.token);
    await db.pool.query("UPDATE users SET status='suspended' WHERE id=$1", [user.id]);
    await broadcastTopologyMessage(event('AFTER_SUSPENSION', 'org-ws-authority-a', user.id));
    await flush(connection);
    assert.equal(delivered(connection, 'AFTER_SUSPENSION'), false);
    connection.socket.terminate();
  });

  it('does not deliver events after a connected token is blacklisted', async () => {
    const user = await login();
    const connection = await connect(user.token);
    await blacklistToken(user.token, 60);
    await broadcastTopologyMessage(event('AFTER_BLACKLIST', 'org-ws-authority-a', user.id));
    await flush(connection);
    assert.equal(delivered(connection, 'AFTER_BLACKLIST'), false);
    connection.socket.terminate();
  });

  it('closes an otherwise idle socket when its access token expires', async () => {
    const user = await login();
    const token = signToken({ id: user.id, role: 'user', organization_id: 'org-ws-authority-a' }, '2s');
    const connection = await connect(token);
    assert.equal(connection.status, 101);
    const closed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 2600);
      connection.socket.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    connection.socket.terminate();
    assert.equal(closed, true);
  });

  it('does not prematurely expire a valid token beyond the timer duration limit', async () => {
    const user = await login();
    const token = signToken({ id: user.id, role: 'user', organization_id: 'org-ws-authority-a' }, '30d');
    const connection = await connect(token);
    assert.equal(connection.status, 101);
    const closedEarly = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 100);
      connection.socket.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
      if (connection.socket.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    connection.socket.terminate();
    assert.equal(closedEarly, false);
  });

  it('does not deliver to an existing socket while authority cannot be read', async () => {
    const user = await login('super-admin');
    const connection = await connect(user.token);
    await db.pool.query('ALTER TABLE users RENAME TO users_ws_authority_unavailable');
    try {
      await broadcastTopologyMessage(event('EXISTING_WITHOUT_AUTHORITY', 'org-ws-authority-b'));
      await flush(connection);
      assert.equal(delivered(connection, 'EXISTING_WITHOUT_AUTHORITY'), false);
    } finally {
      await db.pool.query('ALTER TABLE users_ws_authority_unavailable RENAME TO users');
      connection.socket.terminate();
    }
  });

  it('rejects new sockets and delivery when current account authority cannot be read', async () => {
    const user = await login('super-admin');
    const connection = await connect(user.token);
    await db.pool.query('ALTER TABLE users RENAME TO users_ws_authority_unavailable');
    try {
      assert.equal((await connect(user.token)).status, 503);
      await broadcastTopologyMessage(event('WITHOUT_AUTHORITY', 'org-ws-authority-b'));
      await flush(connection);
      assert.equal(delivered(connection, 'WITHOUT_AUTHORITY'), false);
    } finally {
      await db.pool.query('ALTER TABLE users_ws_authority_unavailable RENAME TO users');
      connection.socket.terminate();
    }
  });
});
