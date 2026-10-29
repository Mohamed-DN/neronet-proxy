const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { createApp } = require('../server');
const config = require('../config/env');
const { AuditChainService } = require('../services/AuditChainService');
const { settleAuditWrites } = require('../utils/audit');

const GENESIS = '0'.repeat(64);
const canonicalFlag = 'SOVEREIGN_AUDIT_ACCEPT_LEGACY_CANONICAL';
const retiredKeyFlag = 'SOVEREIGN_AUDIT_ACCEPT_LEGACY';

// Frozen historical writer, intentionally independent of the production hashing
// exports. These fixtures must remain valid even when the new canonicalizer changes.
function historicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(historicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${historicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function historicalHash(row, secret) {
  let metadata;
  if (row.hmac_key_id) {
    let value = row.metadata_json;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch (_) {
        /* Historical strings stayed strings. */
      }
    } else {
      value = JSON.parse(JSON.stringify(value || {}));
    }
    metadata = historicalJson(value);
  } else {
    metadata =
      typeof row.metadata_json === 'string'
        ? row.metadata_json
        : JSON.stringify(row.metadata_json || {}, Object.keys(row.metadata_json || {}).sort());
  }
  const fields = [
    String(row.sequence_num),
    String(row.prev_hash),
    String(row.event_type),
    String(row.severity),
    String(row.actor_user_id || ''),
    String(row.actor_username || ''),
    String(row.target_id || ''),
    String(row.target_type || ''),
    String(row.message || ''),
    String(row.ip_address || ''),
    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    metadata
  ];
  if (row.hmac_key_id) fields.push(String(row.hmac_key_id));
  return crypto.createHmac('sha256', secret).update(fields.join('|'), 'utf8').digest('hex');
}

function historicalCurrentKeyId() {
  return crypto
    .createHmac('sha256', config.AUDIT_HMAC_SECRET)
    .update('neronet-audit-hmac-key-id-v1')
    .digest('hex')
    .slice(0, 16);
}

function restoreFlag(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('Audit canonical format upgrade with historical PostgreSQL rows and HTTP verification', () => {
  let db, app, token, migrationSql;
  const originalFlags = new Map([canonicalFlag, retiredKeyFlag].map((name) => [name, process.env[name]]));

  async function assertIsolatedDatabase() {
    assert.match(db.dbName, /^neronet_t_/);
    const actual = (await db.pool.query('SELECT current_database() AS name')).rows[0].name;
    assert.equal(actual, db.dbName);
    assert.match(actual, /^neronet_t_/);
  }

  before(async () => {
    migrationSql = fs.readFileSync(path.join(__dirname, '../db/migrations/041_audit_canonical_version.sql'), 'utf8');
    db = await setupTestDatabase();
    await assertIsolatedDatabase();
    app = createApp();
    const admin = (await db.pool.query("SELECT * FROM users WHERE id='usr-admin'")).rows[0];
    assert.equal(admin.role, 'super-admin');
    token = await issueConsoleTestToken(admin, { expiresIn: '1h' });
  });

  beforeEach(async () => {
    await assertIsolatedDatabase();
    process.env[canonicalFlag] = 'true';
    process.env[retiredKeyFlag] = 'true';
    await settleAuditWrites();
    await db.pool.query('DELETE FROM audit_checkpoints');
    await db.pool.query('DELETE FROM audit_events');
  });

  after(async () => {
    for (const [name, value] of originalFlags) restoreFlag(name, value);
    if (db) await db.cleanup();
  });

  async function verify(query = {}) {
    const response = await request(app).get('/api/audit/verify').query(query).auth(token, { type: 'bearer' });
    assert.equal(response.status, 200);
    return response.body.verification;
  }

  async function append(overrides = {}) {
    return AuditChainService.appendEvent({
      eventType: 'CANONICAL_V2_UPGRADE',
      severity: 'info',
      actorUsername: 'operator',
      message: 'New event after canonical upgrade',
      userAgent: 'NeroNet-upgrade-test/2',
      metadata: { nested: { z: [1, '1', { enabled: true }], a: { value: 'preserved' } } },
      ...overrides
    });
  }

  async function insertHistorical({ sequence = 1, previous = GENESIS, retiredKey = false, schema040 = false } = {}) {
    const row = {
      sequence_num: sequence,
      prev_hash: previous,
      event_type: 'HISTORICAL_CANONICAL_V1',
      severity: 'info',
      actor_user_id: null,
      actor_username: 'historical-operator',
      target_id: 'node-before-upgrade',
      target_type: 'node',
      message: `Historical audit event ${sequence}`,
      ip_address: '127.0.0.1',
      user_agent: 'NeroNet-historical-client/1',
      metadata_json: { source: { nested: ['first', { value: sequence, active: true }] }, count: sequence },
      created_at: new Date(`2026-10-19T12:00:0${sequence}.123Z`),
      hmac_key_id: retiredKey ? null : historicalCurrentKeyId()
    };
    const secret = retiredKey ? config.JWT_SECRET : config.AUDIT_HMAC_SECRET;
    assert.ok(secret, 'The isolated test runtime must configure both historical and dedicated audit keys');
    row.entry_hash = historicalHash(row, secret);
    const values = [
      row.sequence_num,
      row.prev_hash,
      row.entry_hash,
      row.event_type,
      row.severity,
      row.actor_user_id,
      row.actor_username,
      row.target_id,
      row.target_type,
      row.message,
      row.ip_address,
      row.user_agent,
      JSON.stringify(row.metadata_json),
      row.created_at,
      row.hmac_key_id
    ];
    const versionColumn = schema040 ? '' : ', canonical_version';
    const versionValue = schema040 ? '' : ', 1';
    return (
      await db.pool.query(
        `INSERT INTO audit_events (
         sequence_num, prev_hash, entry_hash, event_type, severity, actor_user_id,
         actor_username, target_id, target_type, message, ip_address, user_agent,
         metadata_json, created_at, hmac_key_id${versionColumn}
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15${versionValue}) RETURNING *`,
        values
      )
    ).rows[0];
  }

  function assertRejected(report, reason, sequence) {
    assert.equal(report.valid, false);
    assert.equal(report.reason, reason);
    assert.equal(Number(report.broken_at_sequence), Number(sequence));
  }

  it('migrates schema 040 without rewriting historical rows or signed checkpoints, then appends v2', async () => {
    await assertIsolatedDatabase();
    const client = await db.pool.connect();
    try {
      // setupTestDatabase supplies the complete migrated schema; removing only
      // migration 041's two columns reconstructs the real schema at migration 040.
      await client.query('ALTER TABLE audit_events DROP COLUMN canonical_version, DROP COLUMN canonical_metadata_json');
      const absent = (
        await client.query(`SELECT NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='audit_events'
          AND column_name IN ('canonical_version', 'canonical_metadata_json')
      ) AS absent`)
      ).rows[0].absent;
      assert.equal(absent, true);
      const first = await insertHistorical({ retiredKey: true, schema040: true });
      await insertHistorical({ sequence: 2, previous: first.entry_hash, schema040: true });
      const checkpoint = await AuditChainService.createCheckpoint();
      assert.equal(AuditChainService.verifyCheckpoint(checkpoint), true);
      await client.query('CREATE TEMP TABLE audit_upgrade_events_before AS TABLE audit_events');
      await client.query('CREATE TEMP TABLE audit_upgrade_checkpoints_before AS TABLE audit_checkpoints');

      await client.query(migrationSql);
      const preservation = (
        await client.query(`SELECT
        (SELECT count(*) FROM audit_events) = (SELECT count(*) FROM audit_upgrade_events_before)
          AND NOT EXISTS (
            SELECT to_jsonb(e) - 'canonical_version' - 'canonical_metadata_json' FROM audit_events e
            EXCEPT SELECT to_jsonb(b) FROM audit_upgrade_events_before b
          ) AS events_preserved,
        (SELECT count(*) FROM audit_checkpoints) = (SELECT count(*) FROM audit_upgrade_checkpoints_before)
          AND NOT EXISTS (
            SELECT to_jsonb(c) FROM audit_checkpoints c
            EXCEPT SELECT to_jsonb(b) FROM audit_upgrade_checkpoints_before b
          ) AS checkpoints_preserved,
        (SELECT bool_and(canonical_version = 1) FROM audit_events) AS historical_version_preserved,
        (SELECT bool_and(canonical_metadata_json IS NULL) FROM audit_events) AS historical_metadata_unsigned`)
      ).rows[0];
      // SQL booleans verify every stored field without printing hashes or keys.
      assert.deepEqual(preservation, {
        events_preserved: true,
        checkpoints_preserved: true,
        historical_version_preserved: true,
        historical_metadata_unsigned: true
      });
      const added = await append();
      assert.equal(Number(added.canonical_version), 2);
      assert.equal(typeof added.canonical_metadata_json, 'string');
      assert.ok(added.canonical_metadata_json.length > 0);
      const report = await verify();
      assert.equal(report.valid, true);
      assert.equal(report.events_count, 3);
      assert.equal(report.legacy_events, 1);
      assert.equal(report.legacy_canonical_events, 2);
      assert.equal(report.canonical_v2_events, 1);
      assert.equal(report.integrity_profile, 'legacy-partial');
      assert.equal(report.checkpoints_verified, 1);
      assert.equal((await verify({ to: 2 })).valid, true);
      assert.equal((await verify({ from: 2 })).valid, true);
      assert.equal((await verify({ from: 3, to: 3 })).valid, true);
    } finally {
      // Even a failed assertion must leave the shared test helper's clone usable.
      try {
        const needsMigration = (
          await client.query(`SELECT count(*) < 2 AS missing FROM information_schema.columns
            WHERE table_schema='public' AND table_name='audit_events'
              AND column_name IN ('canonical_version', 'canonical_metadata_json')`)
        ).rows[0].missing;
        if (needsMigration) await client.query(migrationSql);
        await client.query('DROP TABLE IF EXISTS audit_upgrade_events_before, audit_upgrade_checkpoints_before');
      } finally {
        client.release();
      }
    }
  });

  it('keeps two nested JSON documents unchanged and verifies a pure v2 chain and ranges', async () => {
    const documents = [
      { z: [{ active: true, number: 1, text: '1' }, ['{}', {}]], a: { nested: { value: null } } },
      { a: { nested: [false, { unicode: 'caffè', value: 'one|two' }] }, z: [2, '2'] }
    ];
    for (const metadata of documents) {
      const row = await append({ metadata });
      assert.equal(Number(row.canonical_version), 2);
      const stored = (await db.pool.query('SELECT metadata_json FROM audit_events WHERE id=$1', [row.id])).rows[0];
      assert.deepEqual(stored.metadata_json, metadata);
    }
    await AuditChainService.createCheckpoint();
    const report = await verify();
    assert.equal(report.valid, true);
    assert.equal(report.legacy_canonical_events, 0);
    assert.equal(report.canonical_v2_events, 2);
    assert.equal(report.integrity_profile, 'canonical-v2');
    assert.equal((await verify({ from: 2, to: 2 })).valid, true);
    assert.equal((await verify({ to: 1 })).valid, true);
  });

  it('reports an empty integrity profile for an empty ledger', async () => {
    const report = await verify();
    assert.equal(report.valid, true);
    assert.equal(report.events_count, 0);
    assert.equal(report.legacy_canonical_events, 0);
    assert.equal(report.canonical_v2_events, 0);
    assert.equal(report.integrity_profile, 'empty');
  });

  it('rejects canonical v1 under the strict canonical flag and accepts it after restoring the flag', async () => {
    await insertHistorical();
    await append();
    assert.equal((await verify()).valid, true);
    try {
      process.env[canonicalFlag] = 'false';
      assertRejected(await verify(), 'LEGACY_CANONICAL_FORMAT', 1);
    } finally {
      process.env[canonicalFlag] = 'true';
    }
    assert.equal((await verify()).valid, true);
  });

  it('keeps the retired-key policy separate from canonical-format acceptance', async () => {
    await insertHistorical();
    process.env[retiredKeyFlag] = 'false';
    assert.equal((await verify()).valid, true, 'Dedicated-key v1 is governed by the canonical flag');
    await db.pool.query('DELETE FROM audit_events');
    await insertHistorical({ retiredKey: true });
    try {
      assertRejected(await verify(), 'LEGACY_KEY', 1);
    } finally {
      process.env[retiredKeyFlag] = 'true';
    }
    assert.equal((await verify()).valid, true);
  });

  it('rejects an independently HMAC-signed v1 downgrade after v2 in full and partial verification', async () => {
    const first = await insertHistorical();
    const second = await append();
    assert.equal(Number(second.sequence_num), Number(first.sequence_num) + 1);
    assert.equal((await verify()).valid, true);
    assert.equal((await verify({ from: 2, to: 2 })).valid, true);
    await insertHistorical({ sequence: 3, previous: second.entry_hash });
    for (const range of [{}, { from: 2 }, { from: 3 }]) {
      assertRejected(await verify(range), 'CANONICAL_DOWNGRADE', 3);
    }
    assert.equal((await verify({ to: 2 })).valid, true, 'The intact prefix remains a positive control');
  });

  it('detects relabeling a new v2 event as canonical v1 without rewriting its hash', async () => {
    const row = await append();
    assert.equal((await verify()).valid, true);
    await db.pool.query('UPDATE audit_events SET canonical_version=1 WHERE id=$1', [row.id]);
    assertRejected(await verify(), 'HASH_TAMPERED', row.sequence_num);
  });

  it('rejects a renamed historical event identifier against its authentic signed checkpoint', async () => {
    const row = await insertHistorical();
    await AuditChainService.createCheckpoint();
    assert.equal((await verify()).valid, true);
    await db.pool.query('UPDATE audit_events SET id=id+100000 WHERE id=$1', [row.id]);
    assertRejected(await verify(), 'CHECKPOINT_MISMATCH', row.sequence_num);
  });

  it('rejects an unknown stored canonical version and restores the real database constraint', async () => {
    await assertIsolatedDatabase();
    const row = await append();
    assert.equal((await verify()).valid, true);
    const constraints = (
      await db.pool.query(`SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='audit_events'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%canonical_version%'`)
    ).rows;
    assert.ok(constraints.length > 0, 'Migration 041 must constrain stored canonical versions');
    const quoteIdentifier = (value) => `"${value.replace(/"/g, '""')}"`;
    const removed = [];
    try {
      for (const constraint of constraints) {
        await db.pool.query(`ALTER TABLE audit_events DROP CONSTRAINT ${quoteIdentifier(constraint.conname)}`);
        removed.push(constraint);
      }
      await db.pool.query('UPDATE audit_events SET canonical_version=99 WHERE id=$1', [row.id]);
      assertRejected(await verify(), 'UNKNOWN_CANONICAL_VERSION', row.sequence_num);
    } finally {
      await db.pool.query('UPDATE audit_events SET canonical_version=2 WHERE id=$1', [row.id]);
      for (const constraint of removed) {
        await db.pool.query(
          `ALTER TABLE audit_events ADD CONSTRAINT ${quoteIdentifier(constraint.conname)} ${constraint.definition}`
        );
      }
    }
    assert.equal((await verify()).valid, true);
    await assert.rejects(
      db.pool.query('UPDATE audit_events SET canonical_version=99 WHERE id=$1', [row.id]),
      (error) => error.code === '23514'
    );
  });
});
