const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');
const Sessions = require('../services/ConsoleSessionService');

const origin = 'http://localhost:8081';
const protocol = { 'X-NeroNet-Browser-Protocol': '2', Origin: origin };

describe('Durable browser context and intent authority on real HTTP/PostgreSQL', () => {
  let db;
  let app;
  before(async () => {
    db = await setupTestDatabase();
    app = createApp();
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  async function bootstrap(id = crypto.randomUUID()) {
    const response = await request(app).post('/api/auth/browser/context').set(protocol).send({ context_id: id });
    assert.equal(response.status, 200);
    assert.equal(response.body.context_id, id);
    assert.equal(response.body.latest_intent, '0');
    assert.equal(response.body.selected, null);
    assert.equal(response.body.binding, undefined);
    const cookies = response.headers['set-cookie'] || [];
    assert.equal(cookies.length, 1);
    assert.ok(cookies[0].startsWith(`nn_ctx_${id}=`));
    assert.ok(cookies[0].includes('HttpOnly'));
    assert.ok(cookies[0].includes('SameSite=Strict'));
    return { id, cookie: cookies[0].split(';')[0] };
  }

  function intent(context, body) {
    return request(app)
      .post('/api/auth/browser/intent')
      .set(protocol)
      .set('Cookie', context.cookie)
      .set('X-NeroNet-Browser-Context', context.id)
      .send(body);
  }

  function operation(sequence = '1') {
    return {
      operation_id: crypto.randomUUID(),
      intent: sequence,
      kind: 'login',
      expected_issuance_id: null,
      successor_issuance_id: crypto.randomUUID()
    };
  }

  async function family() {
    const id = `usr-context-state-${crypto.randomUUID()}`;
    // These are database-constraint fixtures, not password-admission evidence.
    await db.pool.query(
      `INSERT INTO users(id,username,email,password_hash,role,status,organization_id)
       VALUES($1,$1,$2,'constraint-fixture','user','active','org-default')`,
      [id, `${id}@test.local`]
    );
    const pair = await Sessions.issueSession({ user: { id }, ipAddress: '127.0.0.1' });
    const access = jwt.decode(pair.token);
    const refresh = jwt.decode(pair.refreshToken);
    const credential = await db.pool.query('SELECT id FROM refresh_tokens WHERE session_id=$1 AND token_hash=$2', [
      access.sid,
      crypto.createHash('sha256').update(pair.refreshToken).digest('hex')
    ]);
    return {
      userId: id,
      sid: access.sid,
      refreshId: credential.rows[0].id,
      accessJti: access.jti,
      refreshJti: refresh.jti
    };
  }

  function insertIssuance(context, op, credential, override = {}) {
    const value = {
      id: op.successor_issuance_id,
      contextId: context.id,
      operationId: op.operation_id,
      ...credential,
      ...override
    };
    return db.pool.query(
      `INSERT INTO console_browser_issuances(id,context_id,operation_id,session_id,refresh_token_id,access_jti,refresh_jti,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+INTERVAL '1 hour')`,
      [value.id, value.contextId, value.operationId, value.sid, value.refreshId, value.accessJti, value.refreshJti]
    );
  }

  it('bootstraps a context and reads it again without rewriting the coordination cookie', async () => {
    const context = await bootstrap();
    const response = await request(app)
      .post('/api/auth/browser/context')
      .set(protocol)
      .set('Cookie', context.cookie)
      .send({ context_id: context.id });
    assert.equal(response.status, 200);
    assert.equal(response.headers['set-cookie'], undefined);
    const stored = (await db.pool.query('SELECT binding_hash FROM console_browser_contexts WHERE id=$1', [context.id]))
      .rows[0];
    assert.equal(stored.binding_hash.length, 64);
    assert.equal(stored.binding_hash === context.cookie.split('=')[1], false);
  });

  it('knowing an existing public context ID does not disclose or replace its binding', async () => {
    const context = await bootstrap();
    const response = await request(app)
      .post('/api/auth/browser/context')
      .set(protocol)
      .send({ context_id: context.id });
    assert.equal(response.status, 409);
    assert.equal(response.headers['set-cookie'], undefined);
    const legitimate = await intent(context, operation());
    assert.equal(legitimate.status, 200);
  });

  it('admits one of two concurrent unbound bootstraps without producing competing cookies', async () => {
    const id = crypto.randomUUID();
    const responses = await Promise.all(
      [1, 2].map(() => request(app).post('/api/auth/browser/context').set(protocol).send({ context_id: id }))
    );
    assert.deepEqual(responses.map((x) => x.status).sort(), [200, 409]);
    assert.equal(responses.filter((x) => x.headers['set-cookie']).length, 1);
    assert.equal((await db.pool.query('SELECT id FROM console_browser_contexts WHERE id=$1', [id])).rowCount, 1);
  });

  it('admits an intent idempotently and refuses changing its captured successor', async () => {
    const context = await bootstrap();
    const body = operation();
    const first = await intent(context, body);
    assert.equal(first.status, 200);
    assert.equal(first.body.intent, '1');
    assert.equal((await intent(context, body)).status, 200);
    assert.equal((await intent(context, { ...body, successor_issuance_id: crypto.randomUUID() })).status, 409);
    assert.equal(
      (await db.pool.query('SELECT id FROM console_browser_operations WHERE context_id=$1', [context.id])).rowCount,
      1
    );
  });

  it('supersedes a pending older intent and cannot revive it by retrying the old operation', async () => {
    const context = await bootstrap();
    const old = operation('1');
    const newer = operation('2');
    assert.equal((await intent(context, old)).status, 200);
    assert.equal((await intent(context, newer)).status, 200);
    assert.equal((await intent(context, old)).status, 409);
    const rows = await db.pool.query('SELECT id,state FROM console_browser_operations WHERE context_id=$1', [
      context.id
    ]);
    assert.equal(rows.rows.find((x) => x.id === old.operation_id).state, 'superseded');
    assert.equal(rows.rows.find((x) => x.id === newer.operation_id).state, 'registered');
  });

  it('preserves intent counters above 2^53 exactly in PostgreSQL and the response', async () => {
    const context = await bootstrap();
    const value = '9007199254740993';
    const response = await intent(context, operation(value));
    assert.equal(response.status, 200);
    assert.equal(response.body.intent, value);
    const row = await db.pool.query('SELECT latest_intent::text AS value FROM console_browser_contexts WHERE id=$1', [
      context.id
    ]);
    assert.equal(row.rows[0].value, value);
  });

  for (const value of ['01', '-1', '1e3', '1.5', '18446744073709551616', 1]) {
    it(`rejects a noncanonical or out-of-range intent ${JSON.stringify(value)} before changing authority`, async () => {
      const context = await bootstrap();
      assert.equal((await intent(context, operation(value))).status, 400);
      const row = await db.pool.query('SELECT latest_intent::text AS value FROM console_browser_contexts WHERE id=$1', [
        context.id
      ]);
      assert.equal(row.rows[0].value, '0');
    });
  }

  it('refuses an invented predecessor without advancing the context', async () => {
    const context = await bootstrap();
    assert.equal((await intent(context, { ...operation(), expected_issuance_id: crypto.randomUUID() })).status, 409);
    const row = await db.pool.query('SELECT latest_intent::text AS value FROM console_browser_contexts WHERE id=$1', [
      context.id
    ]);
    assert.equal(row.rows[0].value, '0');
  });

  it('refuses another context cookie and never clears its credential', async () => {
    const a = await bootstrap();
    const b = await bootstrap();
    const response = await intent({ id: a.id, cookie: b.cookie }, operation());
    assert.equal(response.status, 401);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal((await intent(b, operation())).status, 200);
  });

  for (const suppliedOrigin of [undefined, 'https://untrusted.example']) {
    it(`refuses bootstrap from ${suppliedOrigin || 'missing Origin'}`, async () => {
      const call = request(app).post('/api/auth/browser/context').set('X-NeroNet-Browser-Protocol', '2');
      if (suppliedOrigin) call.set('Origin', suppliedOrigin);
      const response = await call.send({ context_id: crypto.randomUUID() });
      assert.equal(response.status, 403);
      assert.equal(response.headers['set-cookie'], undefined);
    });
  }

  it('expires independently of the caller and rejects a proof used from another allowed origin', async () => {
    const context = await bootstrap();
    const foreign = await intent(context, operation()).set('Origin', 'http://127.0.0.1:8081');
    assert.equal(foreign.status, 403);
    await db.pool.query(
      "UPDATE console_browser_contexts SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
      [context.id]
    );
    const expired = await intent(context, operation());
    assert.equal(expired.status, 401);
    assert.equal(expired.headers['set-cookie'], undefined);
  });

  it('does not treat the coordination cookie alone as a user session', async () => {
    const context = await bootstrap();
    const response = await request(app).get('/api/auth/me').set('Cookie', context.cookie);
    assert.equal(response.status, 401);
    assert.equal(response.body.user, undefined);
  });

  it('cannot reassign an operation ID to another context', async () => {
    const a = await bootstrap();
    const b = await bootstrap();
    const body = operation();
    assert.equal((await intent(a, body)).status, 200);
    assert.equal((await intent(b, body)).status, 409);
    const row = await db.pool.query('SELECT latest_intent::text AS value FROM console_browser_contexts WHERE id=$1', [
      b.id
    ]);
    assert.equal(row.rows[0].value, '0');
  });

  it('concurrent intent admission converges to the highest intent regardless of arrival order', async () => {
    const context = await bootstrap();
    const low = operation('1');
    const high = operation('2');
    const responses = await Promise.all([intent(context, high), intent(context, low)]);
    assert.equal(responses[0].status, 200);
    assert.ok([200, 409].includes(responses[1].status));
    const rows = await db.pool.query('SELECT id,state FROM console_browser_operations WHERE context_id=$1', [
      context.id
    ]);
    assert.equal(rows.rows.filter((x) => x.state === 'registered').length, 1);
    assert.equal(rows.rows.find((x) => x.state === 'registered').id, high.operation_id);
    const row = await db.pool.query('SELECT latest_intent::text AS value FROM console_browser_contexts WHERE id=$1', [
      context.id
    ]);
    assert.equal(row.rows[0].value, '2');
  });

  it('does not acknowledge an expired pending operation as a usable idempotent retry', async () => {
    const context = await bootstrap();
    const body = operation();
    assert.equal((await intent(context, body)).status, 200);
    await db.pool.query(
      "UPDATE console_browser_operations SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
      [body.operation_id]
    );
    assert.equal((await intent(context, body)).status, 409);
  });

  it('normalizes UUIDs before choosing cookie names and comparing idempotent input', async () => {
    const id = crypto.randomUUID();
    const response = await request(app)
      .post('/api/auth/browser/context')
      .set(protocol)
      .send({ context_id: id.toUpperCase() });
    assert.equal(response.status, 200);
    assert.equal(response.body.context_id, id);
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    assert.ok(cookie.startsWith(`nn_ctx_${id}=`));
    const context = { id, cookie };
    const body = operation();
    assert.equal((await intent(context, body)).status, 200);
    assert.equal(
      (
        await intent(context, {
          ...body,
          operation_id: body.operation_id.toUpperCase(),
          successor_issuance_id: body.successor_issuance_id.toUpperCase()
        })
      ).status,
      200
    );
  });

  it('accepts the uint64 boundary exactly and rejects exhaustion without changing authority', async () => {
    const context = await bootstrap();
    const maximum = operation('18446744073709551615');
    assert.equal((await intent(context, maximum)).status, 200);
    assert.equal((await intent(context, maximum)).status, 200);
    assert.equal((await intent(context, operation('18446744073709551616'))).status, 400);
    const row = await db.pool.query('SELECT latest_intent::text AS value FROM console_browser_contexts WHERE id=$1', [
      context.id
    ]);
    assert.equal(row.rows[0].value, maximum.intent);
  });

  it('refuses a fresh operation with a lower counter instead of rolling authority backwards', async () => {
    const context = await bootstrap();
    assert.equal((await intent(context, operation('2'))).status, 200);
    assert.equal((await intent(context, operation('1'))).status, 409);
    const row = await db.pool.query('SELECT latest_intent::text AS value FROM console_browser_contexts WHERE id=$1', [
      context.id
    ]);
    assert.equal(row.rows[0].value, '2');
  });

  it('bounds durable intent history by reclaiming superseded intents', async () => {
    // Superseded intents can never be admitted again, so they are reclaimed rather
    // than counted against a cap that a normal session would eventually exhaust.
    const context = await bootstrap();
    let last;
    for (let sequence = 1; sequence <= 70; sequence += 1) {
      last = operation(String(sequence));
      assert.equal((await intent(context, last)).status, 200);
    }
    assert.equal((await intent(context, last)).status, 200, 'the latest intent stays idempotent');
    const stored = await db.pool.query(
      `SELECT latest_intent::text AS intent,
       (SELECT COUNT(*)::integer FROM console_browser_operations WHERE context_id=$1) AS count
       FROM console_browser_contexts WHERE id=$1`,
      [context.id]
    );
    assert.equal(stored.rows[0].intent, '70');
    assert.ok(stored.rows[0].count <= 2, `history stays bounded, ${stored.rows[0].count} rows`);
  });

  it('refuses a context that expires while admission waits on its row lock', async () => {
    const context = await bootstrap();
    const blocker = await db.pool.connect();
    let pending;
    try {
      await db.pool.query(
        `UPDATE console_browser_contexts
        SET expires_at=clock_timestamp()+INTERVAL '3 seconds' WHERE id=$1`,
        [context.id]
      );
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM console_browser_contexts WHERE id=$1 FOR UPDATE', [context.id]);
      pending = intent(context, operation()).then((response) => response);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await db.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%c.expires_at<=clock_timestamp()%') AS waiting`);
        if (activity.rows[0].waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.equal(waiting, true, 'admission must be waiting on the actual context row lock');
      await db.pool.query(
        `SELECT pg_sleep(GREATEST(0,
        EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))+0.05)
        FROM console_browser_contexts WHERE id=$1`,
        [context.id]
      );
      await blocker.query('COMMIT');
      assert.equal((await pending).status, 401);
      assert.equal(
        (await db.pool.query('SELECT id FROM console_browser_operations WHERE context_id=$1', [context.id])).rowCount,
        0
      );
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      if (pending) await pending;
    }
  });

  it('reclaims expired unused intent rows while preserving the parent of a selected issuance', async () => {
    const context = await bootstrap();
    const first = operation('1');
    assert.equal((await intent(context, first)).status, 200);
    const credential = await family();
    await insertIssuance(context, first, credential);
    // Select it as selectCandidate does: issuance, operation and context together.
    await db.pool.query(`UPDATE console_browser_issuances SET state='selected' WHERE id=$1`, [
      first.successor_issuance_id
    ]);
    await db.pool.query(`UPDATE console_browser_operations SET state='selected' WHERE id=$1`, [first.operation_id]);
    await db.pool.query('UPDATE console_browser_contexts SET selected_issuance_id=$2 WHERE id=$1', [
      context.id,
      first.successor_issuance_id
    ]);
    for (let sequence = 2; sequence <= 64; sequence += 1) {
      const later = { ...operation(String(sequence)), expected_issuance_id: first.successor_issuance_id };
      assert.equal((await intent(context, later)).status, 200);
    }
    await db.pool.query(
      `UPDATE console_browser_operations SET expires_at=clock_timestamp()-INTERVAL '1 second'
      WHERE context_id=$1`,
      [context.id]
    );
    const next = { ...operation('65'), expected_issuance_id: first.successor_issuance_id };
    assert.equal((await intent(context, next)).status, 200);
    const rows = await db.pool.query('SELECT id FROM console_browser_operations WHERE context_id=$1 ORDER BY intent', [
      context.id
    ]);
    assert.deepEqual(
      rows.rows.map((row) => row.id),
      [first.operation_id, next.operation_id]
    );
    assert.equal(
      (await db.pool.query('SELECT id FROM console_browser_issuances WHERE id=$1', [first.successor_issuance_id]))
        .rowCount,
      1
    );
    const selected = await db.pool.query('SELECT selected_issuance_id FROM console_browser_contexts WHERE id=$1', [
      context.id
    ]);
    assert.equal(selected.rows[0].selected_issuance_id, first.successor_issuance_id);
  });

  it('cannot attach an issuance to an operation owned by another context', async () => {
    const a = await bootstrap();
    const b = await bootstrap();
    const op = operation();
    assert.equal((await intent(b, op)).status, 200);
    const credential = await family();
    await assert.rejects(insertIssuance(a, op, credential), (error) => error.code === '23503');
    assert.equal((await insertIssuance(b, op, credential)).rowCount, 1);
  });

  it('binds an issuance to the exact successor captured by its operation', async () => {
    const context = await bootstrap();
    const op = operation();
    assert.equal((await intent(context, op)).status, 200);
    const credential = await family();
    await assert.rejects(
      insertIssuance(context, op, credential, { id: crypto.randomUUID() }),
      (error) => error.code === '23503'
    );
    assert.equal((await insertIssuance(context, op, credential)).rowCount, 1);
  });

  it('cannot attach a refresh credential from another session family', async () => {
    const context = await bootstrap();
    const op = operation();
    assert.equal((await intent(context, op)).status, 200);
    const a = await family();
    const b = await family();
    await assert.rejects(
      insertIssuance(context, op, a, { refreshId: b.refreshId, refreshJti: b.refreshJti }),
      (error) => error.code === '23503'
    );
    assert.equal((await insertIssuance(context, op, a)).rowCount, 1);
  });

  it('cannot select an issuance from another context', async () => {
    const a = await bootstrap();
    const b = await bootstrap();
    const op = operation();
    assert.equal((await intent(b, op)).status, 200);
    await insertIssuance(b, op, await family());
    await assert.rejects(
      db.pool.query('UPDATE console_browser_contexts SET selected_issuance_id=$2 WHERE id=$1', [
        a.id,
        op.successor_issuance_id
      ]),
      (error) => error.code === '23503'
    );
  });

  it('clears only the selected issuance when its account is deleted and preserves the context identity', async () => {
    const context = await bootstrap();
    const op = operation();
    assert.equal((await intent(context, op)).status, 200);
    const credential = await family();
    await insertIssuance(context, op, credential);
    await db.pool.query('UPDATE console_browser_contexts SET selected_issuance_id=$2 WHERE id=$1', [
      context.id,
      op.successor_issuance_id
    ]);
    await db.pool.query('DELETE FROM users WHERE id=$1', [credential.userId]);
    const result = await db.pool.query(
      'SELECT id,latest_intent::text AS intent,selected_issuance_id FROM console_browser_contexts WHERE id=$1',
      [context.id]
    );
    assert.equal(result.rows[0].id, context.id);
    assert.equal(result.rows[0].intent, '1');
    assert.equal(result.rows[0].selected_issuance_id, null);
  });
});
