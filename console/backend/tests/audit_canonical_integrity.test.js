const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { createApp } = require('../server');
const { AuditChainService } = require('../services/AuditChainService');
const { settleAuditWrites } = require('../utils/audit');

describe('Audit canonical content integrity through the real verification API', () => {
  let db, app, token;
  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    app = createApp();
    const admin = (await db.pool.query("SELECT * FROM users WHERE id='usr-admin'")).rows[0];
    assert.equal(admin.role, 'super-admin');
    token = await issueConsoleTestToken(admin, { expiresIn: '1h' });
  });
  beforeEach(async () => {
    const databaseName = (await db.pool.query('SELECT current_database() AS name')).rows[0].name;
    assert.match(databaseName, /^neronet_t_/);
    assert.equal(databaseName, db.dbName);
    await settleAuditWrites();
    await db.pool.query('DELETE FROM audit_checkpoints');
    await db.pool.query('DELETE FROM audit_events');
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  async function append(overrides = {}) {
    return AuditChainService.appendEvent({
      eventType: 'AUDIT_CANONICAL_PROBE',
      severity: 'info',
      actorUsername: 'operator',
      targetId: 'node-real',
      targetType: 'node',
      message: 'A measured audit event',
      userAgent: 'NeroNet-test-client/1',
      metadata: { source: { role: 'member', nested: ['a', 'b'] } },
      ...overrides
    });
  }
  async function verify() {
    const response = await request(app).get('/api/audit/verify').auth(token, { type: 'bearer' });
    assert.equal(response.status, 200);
    return response.body.verification;
  }
  async function assertTampered(sequence) {
    const result = await verify();
    assert.equal(result.valid, false);
    assert.equal(Number(result.broken_at_sequence), Number(sequence));
    assert.equal(result.reason, 'HASH_TAMPERED');
  }

  it('detects a user-agent change without any hash or checkpoint rewrite', async () => {
    const event = await append();
    assert.equal((await verify()).valid, true);
    await AuditChainService.createCheckpoint();
    await db.pool.query('UPDATE audit_events SET user_agent=$2 WHERE id=$1', [event.id, 'forged-client/99']);
    await assertTampered(event.sequence_num);
  });

  it('detects shifting a delimiter between actor and target fields', async () => {
    const event = await append({ actorUsername: 'operator|boundary', targetId: 'node-real' });
    assert.equal((await verify()).valid, true);
    await AuditChainService.createCheckpoint();
    await db.pool.query('UPDATE audit_events SET actor_username=$2,target_id=$3 WHERE id=$1', [
      event.id,
      'operator',
      'boundary|node-real'
    ]);
    await assertTampered(event.sequence_num);
  });

  it('detects replacing a null target with an empty string', async () => {
    const event = await append({ targetId: null });
    assert.equal((await verify()).valid, true);
    await db.pool.query("UPDATE audit_events SET target_id='' WHERE id=$1", [event.id]);
    await assertTampered(event.sequence_num);
  });

  it('detects changing the stored event identifier', async () => {
    const event = await append();
    assert.equal((await verify()).valid, true);
    await db.pool.query('UPDATE audit_events SET id=id+100000 WHERE id=$1', [event.id]);
    await assertTampered(event.sequence_num);
  });

  it('keeps nested metadata changes detectable', async () => {
    const event = await append();
    await db.pool.query(
      "UPDATE audit_events SET metadata_json=jsonb_set(metadata_json,'{source,role}','\"owner\"') WHERE id=$1",
      [event.id]
    );
    await assertTampered(event.sequence_num);
  });

  it('detects a signed metadata text rewrite even when JSON semantics remain identical', async () => {
    const metadata = { a: ['x', 1], z: { a: 1, b: 2 } };
    const event = await append({ metadata });
    assert.equal((await verify()).valid, true);
    const equivalentText = '{  "z" : { "b" : 2, "a" : 1 }, "a" : [ "x", 1 ] }';
    assert.ok(equivalentText !== event.canonical_metadata_json);
    await db.pool.query('UPDATE audit_events SET canonical_metadata_json=$2 WHERE id=$1', [event.id, equivalentText]);
    const control = (
      await db.pool.query(
        `SELECT metadata_json=$2::jsonb AS metadata_preserved,
                canonical_metadata_json::jsonb=metadata_json AS semantically_equivalent,
                entry_hash=$3 AS hash_preserved
           FROM audit_events WHERE id=$1`,
        [event.id, JSON.stringify(metadata), event.entry_hash]
      )
    ).rows[0];
    assert.deepEqual(control, {
      metadata_preserved: true,
      semantically_equivalent: true,
      hash_preserved: true
    });
    await assertTampered(event.sequence_num);
  });

  it('reports malformed signed metadata text as tampering through an HTTP 200 response', async () => {
    const event = await append();
    assert.equal((await verify()).valid, true);
    await db.pool.query('UPDATE audit_events SET canonical_metadata_json=$2 WHERE id=$1', [event.id, '{"source":']);
    const control = (
      await db.pool.query(
        `SELECT metadata_json=$2::jsonb AS metadata_preserved,
                entry_hash=$3 AS hash_preserved
           FROM audit_events WHERE id=$1`,
        [event.id, JSON.stringify(event.metadata_json), event.entry_hash]
      )
    ).rows[0];
    assert.deepEqual(control, { metadata_preserved: true, hash_preserved: true });
    // assertTampered uses the real endpoint and requires HTTP 200 before reading
    // the report, so an eager SQL JSON cast returning HTTP 500 cannot pass.
    await assertTampered(event.sequence_num);
  });

  it('detects metadata tampering in the second verification batch after 1001 real appends', async () => {
    let secondBatchEvent;
    for (let sequence = 1; sequence <= 1001; sequence++) {
      const event = await append({ message: `Canonical batch probe ${sequence}` });
      assert.equal(Number(event.sequence_num), sequence);
      if (sequence === 1001) secondBatchEvent = event;
    }
    const control = await verify();
    assert.equal(control.valid, true);
    assert.equal(control.events_count, 1001);
    assert.equal(Number(control.last_sequence), 1001);
    await db.pool.query(
      "UPDATE audit_events SET metadata_json=jsonb_set(metadata_json,'{source,role}','\"owner\"') WHERE id=$1",
      [secondBatchEvent.id]
    );
    await assertTampered(1001);
  });

  it('detects a timestamp change smaller than a JavaScript millisecond', async () => {
    const event = await append();
    assert.equal((await verify()).valid, true);
    await db.pool.query("UPDATE audit_events SET created_at=created_at+interval '1 microsecond' WHERE id=$1", [
      event.id
    ]);
    await assertTampered(event.sequence_num);
  });

  it('does not let a signed checkpoint vouch for a renamed event identifier', async () => {
    const event = await append();
    await AuditChainService.createCheckpoint();
    assert.equal((await verify()).valid, true);
    await db.pool.query('UPDATE audit_events SET id=id+100000 WHERE id=$1', [event.id]);
    const result = await verify();
    assert.equal(result.valid, false);
    assert.equal(Number(result.broken_at_sequence), Number(event.sequence_num));
  });

  for (const [text, json] of [
    ['1', '1'],
    ['{}', '{}']
  ]) {
    it(`distinguishes a stored JSON string ${text} from its parsed value`, async () => {
      const event = await append({ metadata: JSON.stringify(text) });
      const type = (
        await db.pool.query('SELECT jsonb_typeof(metadata_json) AS kind FROM audit_events WHERE id=$1', [event.id])
      ).rows[0].kind;
      assert.equal(type, 'string');
      assert.equal((await verify()).valid, true);
      await db.pool.query('UPDATE audit_events SET metadata_json=$2::jsonb WHERE id=$1', [event.id, json]);
      await assertTampered(event.sequence_num);
    });
  }

  it('detects a JSONB numeric change hidden by JavaScript floating-point decoding', async () => {
    const event = await append({ metadata: { n: 0.1 } });
    assert.equal((await verify()).valid, true);
    await db.pool.query(
      "UPDATE audit_events SET metadata_json=jsonb_set(metadata_json,'{n}','0.100000000000000005'::jsonb) WHERE id=$1",
      [event.id]
    );
    const changed = (
      await db.pool.query(
        "SELECT (metadata_json->>'n')::numeric<>0.1::numeric AS changed FROM audit_events WHERE id=$1",
        [event.id]
      )
    ).rows[0].changed;
    assert.equal(changed, true);
    await assertTampered(event.sequence_num);
  });

  it('distinguishes JSON null metadata from SQL NULL', async () => {
    const event = await append({ metadata: 'null' });
    assert.equal((await verify()).valid, true);
    // A data-only writer is already stopped by NOT NULL. Also measure the MAC
    // boundary if a database attacker removes that schema guard first.
    await assert.rejects(db.pool.query('UPDATE audit_events SET metadata_json=NULL WHERE id=$1', [event.id]), {
      code: '23502'
    });
    await db.pool.query('ALTER TABLE audit_events ALTER COLUMN metadata_json DROP NOT NULL');
    try {
      await db.pool.query('UPDATE audit_events SET metadata_json=NULL WHERE id=$1', [event.id]);
      await assertTampered(event.sequence_num);
    } finally {
      await db.pool.query("UPDATE audit_events SET metadata_json='null'::jsonb WHERE id=$1", [event.id]);
      await db.pool.query('ALTER TABLE audit_events ALTER COLUMN metadata_json SET NOT NULL');
    }
  });

  it('verifies a coherent snapshot while another connection appends and checkpoints', async () => {
    await append();
    let signal, release;
    const observed = new Promise((resolve) => {
      signal = resolve;
    });
    const resume = new Promise((resolve) => {
      release = resolve;
    });
    let paused = false;
    async function barrierQuery(query, args, run) {
      const result = await run(query, args);
      const sql = typeof query === 'string' ? query : query.text;
      if (!paused && /FROM audit_events WHERE sequence_num >=/.test(sql)) {
        paused = true;
        signal();
        await resume;
      }
      return result;
    }
    // The adapter executes all SQL against PostgreSQL without changing results.
    // Only scheduling is controlled, after the event SELECT really completes.
    const measured = {
      query: (q, a) => barrierQuery(q, a, db.pool.query.bind(db.pool)),
      connect: async () => {
        const client = await db.pool.connect();
        return new Proxy(client, {
          get(target, key) {
            if (key === 'query') return (q, a) => barrierQuery(q, a, target.query.bind(target));
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
    };
    const pending = AuditChainService.verifyChain({ pool: measured });
    let timer;
    try {
      await Promise.race([
        observed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Verifier never completed its real event SELECT')), 5000);
        })
      ]);
      await append({ message: 'Concurrent append on a separate connection' });
      await AuditChainService.createCheckpoint();
    } finally {
      clearTimeout(timer);
      release();
    }
    const report = await pending;
    assert.equal(report.valid, true);
    assert.equal(report.events_count, 1);
    assert.equal((await verify()).valid, true);
  });
});
