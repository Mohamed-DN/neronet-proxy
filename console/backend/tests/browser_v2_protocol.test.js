const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');

// Positive browser-v2 contract on real HTTP and PostgreSQL. A browser keeps every
// Set-Cookie it receives, including a late one; authority must therefore come from
// the server-selected issuance, never from whichever credential cookie is present.
const origin = 'http://localhost:8081';
const protocol = { 'X-NeroNet-Browser-Protocol': '2', Origin: origin };
const password = 'BrowserProtocol123!';

describe('Browser-v2 login, selection, refresh and logout use the selected issuance only', () => {
  let db;
  let app;
  let passwordHash;
  let previousMfa;
  before(async () => {
    db = await setupTestDatabase();
    app = createApp();
    passwordHash = await bcrypt.hash(password, 4);
    previousMfa = process.env.SOVEREIGN_MFA_MANDATORY;
    process.env.SOVEREIGN_MFA_MANDATORY = 'off';
  });
  after(async () => {
    if (previousMfa === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = previousMfa;
    if (db) await db.cleanup();
  });

  // Minimal cookie jar with browser semantics: later Set-Cookie wins per name,
  // Max-Age=0/expired removes. Path scoping is checked separately below.
  class Jar {
    constructor() {
      this.values = new Map();
    }
    take(response) {
      for (const line of response.headers['set-cookie'] || []) {
        const [pair, ...attributes] = line.split(';').map((part) => part.trim());
        const index = pair.indexOf('=');
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);
        const expired = attributes.some(
          (attribute) => /^max-age=0$/i.test(attribute) || /^expires=thu, 01 jan 1970/i.test(attribute)
        );
        if (expired || value === '') this.values.delete(name);
        else this.values.set(name, value);
      }
      return response;
    }
    header() {
      return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    names() {
      return [...this.values.keys()];
    }
  }

  async function user() {
    const id = `usr-browser-v2-${crypto.randomUUID().slice(0, 8)}`;
    await db.pool.query(
      `INSERT INTO users(id,username,email,password_hash,role,status,organization_id)
       VALUES($1,$1,$2,$3,'user','active','org-default')`,
      [id, `${id}@test.local`, passwordHash]
    );
    return id;
  }

  async function bootstrap(jar) {
    const id = crypto.randomUUID();
    const response = jar.take(
      await request(app).post('/api/auth/browser/context').set(protocol).send({ context_id: id })
    );
    assert.equal(response.status, 200);
    return { id, jar, intent: 0n, selected: null };
  }

  const bound = (context, call) =>
    call.set(protocol).set('X-NeroNet-Browser-Context', context.id).set('Cookie', context.jar.header());

  async function admit(context, kind) {
    context.intent += 1n;
    const body = {
      operation_id: crypto.randomUUID(),
      intent: String(context.intent),
      kind,
      expected_issuance_id: context.selected,
      successor_issuance_id: kind === 'logout' ? null : crypto.randomUUID()
    };
    const response = await bound(context, request(app).post('/api/auth/browser/intent')).send(body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return body;
  }

  function login(context, operation, username, secret = password) {
    return bound(context, request(app).post('/api/auth/login')).send({
      username,
      password: secret,
      operation_id: operation.operation_id
    });
  }

  function select(context, operation) {
    return bound(context, request(app).post('/api/auth/browser/select')).send({
      operation_id: operation.operation_id,
      intent: operation.intent,
      issuance_id: operation.successor_issuance_id
    });
  }

  function me(context, issuance = context.selected) {
    const call = bound(context, request(app).get('/api/auth/me'));
    return issuance ? call.set('X-NeroNet-Browser-Issuance', issuance) : call;
  }

  async function signIn(context, username) {
    const operation = await admit(context, 'login');
    const response = context.jar.take(await login(context, operation, username));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const selected = await select(context, operation);
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    context.selected = operation.successor_issuance_id;
    return operation;
  }

  it('signs in, selects the candidate and stays the same account after a reload', async () => {
    const account = await user();
    const context = await bootstrap(new Jar());
    const operation = await admit(context, 'login');
    const response = context.jar.take(await login(context, operation, account));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.token, undefined, 'v2 never hands an access token to JavaScript');
    assert.equal(response.body.candidate.issuance_id, operation.successor_issuance_id);
    assert.equal(response.body.user.id, account);
    const cookies = response.headers['set-cookie'].join('\n');
    const issuance = operation.successor_issuance_id;
    assert.match(cookies, new RegExp(`nn_at_${issuance}=[^;]+; .*Path=/;.*HttpOnly.*SameSite=Strict`));
    assert.match(cookies, new RegExp(`nn_rt_${issuance}=[^;]+; .*Path=/api/auth/refresh;.*HttpOnly`));
    assert.doesNotMatch(cookies, /(^|\n)(token|refreshToken)=/, 'v2 never writes ambient legacy cookies');

    const beforeSelection = await me(context, issuance);
    assert.equal(beforeSelection.status, 401, 'a candidate is not an adopted session');

    const selected = await select(context, operation);
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.deepEqual(selected.body.selected, { sid: response.body.candidate.sid, issuance_id: issuance });
    context.selected = issuance;
    const current = await me(context);
    assert.equal(current.status, 200, JSON.stringify(current.body));
    assert.equal(current.body.user.id, account);

    // Reload: JavaScript memory is gone; the context snapshot names the selection again.
    const snapshot = await bound(context, request(app).post('/api/auth/browser/context')).send({
      context_id: context.id
    });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.selected.issuance_id, issuance);
    assert.equal((await me(context, snapshot.body.selected.issuance_id)).body.user.id, account);
  });

  it('keeps a reordered late login inert: A200 held, B401, then A arrives (no prior session)', async () => {
    const accountA = await user();
    const context = await bootstrap(new Jar());
    const operationA = await admit(context, 'login');
    const lateA = await login(context, operationA, accountA); // response held back
    assert.equal(lateA.status, 200);
    const operationB = await admit(context, 'login');
    const failedB = context.jar.take(await login(context, operationB, accountA, 'wrong-password'));
    assert.equal(failedB.status, 401);
    context.jar.take(lateA); // the browser stores A's cookies regardless

    assert.equal((await me(context, operationA.successor_issuance_id)).status, 401);
    assert.equal((await me(context, null)).status, 401);
    const adopt = await select(context, operationA);
    assert.equal(adopt.status, 409, 'a superseded candidate can never be selected');
    const snapshot = await bound(context, request(app).post('/api/auth/browser/context')).send({
      context_id: context.id
    });
    assert.equal(snapshot.body.selected, null, 'the context stays anonymous after a reload');
  });

  it('keeps C when B fails and a late A arrives after C was already selected', async () => {
    const accountA = await user();
    const accountC = await user();
    const context = await bootstrap(new Jar());
    await signIn(context, accountC);
    const operationA = await admit(context, 'login');
    const lateA = await login(context, operationA, accountA);
    assert.equal(lateA.status, 200);
    const operationB = await admit(context, 'login');
    assert.equal(context.jar.take(await login(context, operationB, accountA, 'wrong-password')).status, 401);
    context.jar.take(lateA);

    assert.equal((await select(context, operationA)).status, 409);
    const current = await me(context);
    assert.equal(current.status, 200);
    assert.equal(current.body.user.id, accountC, 'the selected session survives the failed and late logins');
    assert.equal((await me(context, operationA.successor_issuance_id)).status, 409, 'stale document is told to resync');
  });

  it('rotates on refresh into one selected successor without any replay of the consumed credential', async () => {
    const account = await user();
    const context = await bootstrap(new Jar());
    await signIn(context, account);
    const first = context.selected;
    const operation = await admit(context, 'refresh');
    const refreshed = context.jar.take(
      await bound(context, request(app).post('/api/auth/refresh'))
        .set('X-NeroNet-Browser-Issuance', first)
        .send({ operation_id: operation.operation_id })
    );
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.token, undefined);
    assert.equal(refreshed.body.selected.issuance_id, operation.successor_issuance_id);
    context.selected = operation.successor_issuance_id;
    assert.equal((await me(context)).body.user.id, account);
    assert.ok(!context.jar.names().includes(`nn_at_${first}`), 'the predecessor credential is retired and cleared');

    // A lost response must not lead to a replay: the stale expectation is refused
    // at admission, before any credential is touched, and the family survives.
    const stale = { ...operation, operation_id: crypto.randomUUID(), intent: String((context.intent += 1n)) };
    stale.expected_issuance_id = first;
    stale.successor_issuance_id = crypto.randomUUID();
    const refused = await bound(context, request(app).post('/api/auth/browser/intent')).send(stale);
    assert.equal(refused.status, 409);
    assert.equal((await me(context)).status, 200, 'the selected family was not revoked');
  });

  async function mfaUser() {
    const Totp = require('../services/TotpService');
    const secret = Totp.generateSecret();
    const id = `usr-browser-v2-mfa-${crypto.randomUUID().slice(0, 8)}`;
    await db.pool.query(
      `INSERT INTO users(id,username,email,password_hash,role,status,organization_id,totp_enabled,totp_secret)
       VALUES($1,$1,$2,$3,'user','active','org-default',TRUE,$4)`,
      [id, `${id}@test.local`, passwordHash, secret]
    );
    return { id, code: () => Totp.generateTotp(secret) };
  }

  it('completes a password-step MFA sign-in as a candidate with the challenge held only in memory', async () => {
    const account = await mfaUser();
    const context = await bootstrap(new Jar());
    const operation = await admit(context, 'login');
    const pending = context.jar.take(await login(context, operation, account.id));
    assert.equal(pending.status, 200);
    assert.equal(pending.body.mfa_required, true);
    assert.equal(pending.headers['set-cookie'], undefined, 'no credential before the second factor');
    const verified = context.jar.take(
      await bound(context, request(app).post('/api/auth/mfa/verify')).send({
        mfa_token: pending.body.mfa_token,
        code: account.code(),
        operation_id: operation.operation_id
      })
    );
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.token, undefined);
    assert.equal(verified.body.candidate.issuance_id, operation.successor_issuance_id);
    assert.equal((await select(context, operation)).status, 200);
    context.selected = operation.successor_issuance_id;
    assert.equal((await me(context)).body.user.id, account.id);
  });

  it('refuses a late MFA completion once a newer intent superseded its sign-in', async () => {
    const account = await mfaUser();
    const context = await bootstrap(new Jar());
    const operation = await admit(context, 'login');
    const pending = await login(context, operation, account.id);
    assert.equal(pending.body.mfa_required, true);
    await admit(context, 'login');
    const late = await bound(context, request(app).post('/api/auth/mfa/verify')).send({
      mfa_token: pending.body.mfa_token,
      code: account.code(),
      operation_id: operation.operation_id
    });
    assert.equal(late.status, 409);
    assert.equal(late.headers['set-cookie'], undefined);
  });

  it('replaces an authenticator from a v2 session and selects the rotated issuance atomically', async () => {
    const account = await user();
    const context = await bootstrap(new Jar());
    await signIn(context, account);
    const before = context.selected;
    const setup = await bound(context, request(app).post('/api/auth/mfa/setup'))
      .set('X-NeroNet-Browser-Issuance', before)
      .send({});
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    const operation = await admit(context, 'mfa');
    const verified = context.jar.take(
      await bound(context, request(app).post('/api/auth/mfa/verify'))
        .set('X-NeroNet-Browser-Issuance', before)
        .send({
          code: require('../services/TotpService').generateTotp(setup.body.secret),
          operation_id: operation.operation_id
        })
    );
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.selected.issuance_id, operation.successor_issuance_id);
    assert.ok(!context.jar.names().includes(`nn_at_${before}`));
    context.selected = operation.successor_issuance_id;
    assert.equal((await me(context)).body.user.id, account);
    assert.equal((await me(context, before)).status, 409);
  });

  it('rotates the selected issuance for vault unlock and lock without legacy tokens', async () => {
    const account = await user();
    await db.pool.query('UPDATE users SET password_hash_root=$2 WHERE id=$1', [
      account,
      await bcrypt.hash('VaultRoot123!', 4)
    ]);
    const context = await bootstrap(new Jar());
    await signIn(context, account);
    for (const [kind, path, body, tier] of [
      ['unlock', '/api/compartments/unlock', { password: 'VaultRoot123!' }, 'root'],
      ['lock', '/api/compartments/lock', {}, 'standard']
    ]) {
      const before = context.selected;
      const operation = await admit(context, kind);
      const response = context.jar.take(
        await bound(context, request(app).post(path))
          .set('X-NeroNet-Browser-Issuance', before)
          .send({ ...body, operation_id: operation.operation_id })
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.token, undefined);
      assert.equal(response.body.compartment_access, tier);
      assert.equal(response.body.selected.issuance_id, operation.successor_issuance_id);
      assert.doesNotMatch((response.headers['set-cookie'] || []).join('\n'), /(^|\n)(token|refreshToken)=/);
      context.selected = operation.successor_issuance_id;
      assert.equal((await me(context)).body.user.id, account);
      assert.equal((await me(context, before)).status, 409);
    }
    const { settleAuditWrites } = require('../utils/audit');
    await settleAuditWrites();
    const events = await db.pool.query(
      `SELECT event_type, organization_id FROM audit_events
        WHERE actor_user_id=$1 AND event_type IN ('VAULT_UNLOCKED','VAULT_LOCKED') ORDER BY id`,
      [account]
    );
    assert.deepEqual(
      events.rows.map((row) => [row.event_type, row.organization_id]),
      [
        ['VAULT_UNLOCKED', 'org-default'],
        ['VAULT_LOCKED', 'org-default']
      ]
    );
  });

  it('admits the topology WebSocket only for the selected issuance cookie of a bound context', async () => {
    const { WebSocket } = require('ws');
    const { initTopologyWebSocket, closeTopologyWebSocket } = require('../ws/topologyServer');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    initTopologyWebSocket(server);
    const endpoint = `ws://127.0.0.1:${server.address().port}/ws/topology`;
    const open = (context, issuance, headers = { Origin: origin }) =>
      new Promise((resolve) => {
        const query = new URLSearchParams({ protocol: '2', context: context.id, issuance });
        const socket = new WebSocket(`${endpoint}?${query}`, { headers: { ...headers, Cookie: context.jar.header() } });
        socket.once('message', (data) => {
          socket.terminate();
          resolve({ status: 101, frame: JSON.parse(String(data)) });
        });
        socket.once('unexpected-response', (_request, response) => {
          socket.terminate();
          resolve({ status: response.statusCode });
        });
        socket.once('error', () => resolve({ status: 0 }));
      });
    try {
      const account = await user();
      const accountA = await user();
      const context = await bootstrap(new Jar());
      await signIn(context, account);
      const connected = await open(context, context.selected);
      assert.equal(connected.status, 101);
      assert.equal(connected.frame.type, 'CONNECTED');
      assert.equal(connected.frame.user.id, account);

      const operationA = await admit(context, 'login');
      const lateA = await login(context, operationA, accountA);
      assert.equal(lateA.status, 200);
      await admit(context, 'login');
      context.jar.take(lateA);
      assert.equal((await open(context, operationA.successor_issuance_id)).status, 409, 'late issuance refused');
      assert.equal((await open(context, context.selected, {})).status, 403, 'a browser upgrade always has Origin');
      const still = await open(context, context.selected);
      assert.equal(still.frame?.user?.id, account, 'the selected principal is unchanged');
    } finally {
      closeTopologyWebSocket();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // --- Review findings, reproduced before their fixes ------------------------------

  it('keeps a context usable after many rotations instead of exhausting its operation capacity', async () => {
    const account = await user();
    const context = await bootstrap(new Jar());
    await signIn(context, account);
    for (let rotation = 0; rotation < 70; rotation++) {
      const operation = await admit(context, 'refresh');
      const refreshed = context.jar.take(
        await bound(context, request(app).post('/api/auth/refresh'))
          .set('X-NeroNet-Browser-Issuance', context.selected)
          .send({ operation_id: operation.operation_id })
      );
      assert.equal(refreshed.status, 200, `rotation ${rotation}: ${JSON.stringify(refreshed.body)}`);
      context.selected = operation.successor_issuance_id;
    }
    assert.equal((await me(context)).body.user.id, account);
    const rows = await db.pool.query('SELECT count(*)::int AS n FROM console_browser_operations WHERE context_id=$1', [
      context.id
    ]);
    assert.ok(rows.rows[0].n <= 8, `retired rotations are reclaimed, ${rows.rows[0].n} operations remain`);
  });

  it('adopts a browser-v2 registration candidate', async () => {
    const context = await bootstrap(new Jar());
    const operation = await admit(context, 'register');
    const username = `usr-browser-v2-reg-${crypto.randomUUID().slice(0, 8)}`;
    const registered = context.jar.take(
      await bound(context, request(app).post('/api/auth/register')).send({
        username,
        password,
        operation_id: operation.operation_id
      })
    );
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    assert.equal(registered.body.token, undefined);
    const selected = await select(context, operation);
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    context.selected = operation.successor_issuance_id;
    assert.equal((await me(context)).body.user.username, username);
  });

  it('does not create an account when the v2 registration intent was already superseded', async () => {
    const context = await bootstrap(new Jar());
    const operation = await admit(context, 'register');
    await admit(context, 'login');
    const username = `usr-browser-v2-late-reg-${crypto.randomUUID().slice(0, 8)}`;
    const refused = await bound(context, request(app).post('/api/auth/register')).send({
      username,
      password,
      operation_id: operation.operation_id
    });
    assert.equal(refused.status, 409);
    const rows = await db.pool.query('SELECT 1 FROM users WHERE username=$1', [username]);
    assert.equal(rows.rowCount, 0, 'a refused admission leaves no account behind');
  });

  it('marks a selection change with a machine-readable code distinct from ordinary conflicts', async () => {
    const account = await user();
    const context = await bootstrap(new Jar());
    await signIn(context, account);
    const stale = await me(context, crypto.randomUUID());
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'browser_selection_changed');
  });

  it('refuses a refresh whose declared issuance is not the selection', async () => {
    const account = await user();
    const context = await bootstrap(new Jar());
    await signIn(context, account);
    const operation = await admit(context, 'refresh');
    const refused = await bound(context, request(app).post('/api/auth/refresh'))
      .set('X-NeroNet-Browser-Issuance', crypto.randomUUID())
      .send({ operation_id: operation.operation_id });
    assert.equal(refused.status, 409);
    assert.equal(refused.headers['set-cookie'], undefined);
  });

  it('revokes the families of retired and superseded issuances of another principal', async () => {
    const accountA = await user();
    const accountC = await user();
    const context = await bootstrap(new Jar());
    await signIn(context, accountC);
    const familyC = (
      await db.pool.query('SELECT session_id FROM console_browser_issuances WHERE id=$1', [context.selected])
    ).rows[0].session_id;
    const operationA = await admit(context, 'login');
    assert.equal((await login(context, operationA, accountA)).status, 200);
    const familyA = (
      await db.pool.query('SELECT session_id FROM console_browser_issuances WHERE id=$1', [
        operationA.successor_issuance_id
      ])
    ).rows[0].session_id;
    await admit(context, 'login'); // supersedes A's candidate
    await signIn(context, accountC); // switches from C's first family to a new one
    const closed = await db.pool.query(
      'SELECT id, revoked_at IS NOT NULL AS revoked FROM console_sessions WHERE id = ANY($1)',
      [[familyA, familyC]]
    );
    assert.deepEqual(Object.fromEntries(closed.rows.map((row) => [row.id === familyA ? 'A' : 'C', row.revoked])), {
      A: true,
      C: true
    });
  });

  it('closes a v2 topology socket once its issuance is no longer selected', async () => {
    const { WebSocket } = require('ws');
    const { initTopologyWebSocket, closeTopologyWebSocket, broadcastTopologyMessage } = require('../ws/topologyServer');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    initTopologyWebSocket(server);
    try {
      const account = await user();
      const context = await bootstrap(new Jar());
      await signIn(context, account);
      const query = new URLSearchParams({ protocol: '2', context: context.id, issuance: context.selected });
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/topology?${query}`, {
        headers: { Origin: origin, Cookie: context.jar.header() }
      });
      await new Promise((resolve) => socket.once('message', resolve));
      const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
      const operation = await admit(context, 'refresh');
      const refreshed = context.jar.take(
        await bound(context, request(app).post('/api/auth/refresh'))
          .set('X-NeroNet-Browser-Issuance', context.selected)
          .send({ operation_id: operation.operation_id })
      );
      assert.equal(refreshed.status, 200);
      await broadcastTopologyMessage({ event: 'NODE_UPDATE', organization_id: 'org-default' });
      assert.equal(
        await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('still open'), 3000))]),
        1008
      );
    } finally {
      closeTopologyWebSocket();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('refuses the OIDC callback for browser-v2 instead of writing legacy credentials', async () => {
    const context = await bootstrap(new Jar());
    const response = await bound(context, request(app).post('/api/auth/oidc/callback')).send({ code: 'x', state: 'y' });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /browser-v2/, 'refused by the protocol gate, not by a missing IdP');
    assert.equal(response.body.token, undefined);
    assert.equal(response.headers['set-cookie'], undefined);
  });

  it('meters MFA completion per challenge, whatever username the body claims', () => {
    // Limits are disabled in this process; the probe enables them in its own.
    const { spawnSync } = require('node:child_process');
    const path = require('node:path');
    const child = spawnSync(process.execPath, [path.join(__dirname, 'helpers/mfaChallengeLimitProbe.js')], {
      env: { ...process.env, SOVEREIGN_RATE_LIMIT_DISABLED: 'false' },
      encoding: 'utf8',
      timeout: 60000
    });
    assert.equal(child.status, 0, child.stderr);
    const { statuses } = JSON.parse(/^PROBE_RESULT (.+)$/m.exec(child.stdout)[1]);
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401], 'wrong codes are refused, not yet limited');
    assert.equal(statuses.at(-1), 429, `statuses ${statuses.join(',')}`);
  });

  it('slides the context lease on use and sweeps expired contexts', async () => {
    const account = await user();
    const context = await bootstrap(new Jar());
    await signIn(context, account);
    await db.pool.query(
      `UPDATE console_browser_contexts SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1`,
      [context.id]
    );
    await admit(context, 'refresh');
    const lease = await db.pool.query(
      `SELECT expires_at > clock_timestamp()+interval '29 days' AS renewed FROM console_browser_contexts WHERE id=$1`,
      [context.id]
    );
    assert.equal(lease.rows[0].renewed, true);
    const stale = await bootstrap(new Jar());
    await db.pool.query(
      `UPDATE console_browser_contexts SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
      [stale.id]
    );
    await bootstrap(new Jar());
    const swept = await db.pool.query('SELECT 1 FROM console_browser_contexts WHERE id=$1', [stale.id]);
    assert.equal(swept.rowCount, 0);
  });

  it('logs out only the selected issuance and clears only its own cookies', async () => {
    const account = await user();
    const context = await bootstrap(new Jar());
    await signIn(context, account);
    const issuance = context.selected;
    const operation = await admit(context, 'logout');
    const response = await bound(context, request(app).post('/api/auth/logout'))
      .set('X-NeroNet-Browser-Issuance', issuance)
      .send({ operation_id: operation.operation_id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const cleared = (response.headers['set-cookie'] || []).map((line) => line.split('=')[0]).sort();
    assert.deepEqual(cleared, [`nn_at_${issuance}`, `nn_rt_${issuance}`].sort());
    context.jar.take(response);
    context.selected = null;
    assert.equal((await me(context, issuance)).status, 401, 'nothing is selected after logout');
    assert.equal((await me(context, null)).status, 401);
    assert.ok(context.jar.names().includes(`nn_ctx_${context.id}`), 'logout never deletes the coordination cookie');
  });
});
