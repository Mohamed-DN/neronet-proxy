const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { spawnSync } = require('node:child_process');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupTestDatabase } = require('./helpers/db');
const { getPgPool, closeDatabase } = require('../db');
const { createApp } = require('../server');
const config = require('../config/env');
const { logAuditEvent, settleAuditWrites } = require('../utils/audit');
const { AuditChainService } = require('../services/AuditChainService');
const { BackupRecoveryProofService } = require('../services/BackupRecoveryProofService');
const { normalizeConstraintDefinition } = require('../services/DatabaseRecoverySnapshot');

describe('Disaster recovery proof against a separate restored database', () => {
  let dbHelper, pool, app, maintenancePool, sourceUrl, superAdminToken, memberToken;

  before(async () => {
    const baseUrl = process.env.DATABASE_URL;
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    sourceUrl = process.env.DATABASE_URL;
    maintenancePool = new Pool({ connectionString: baseUrl });
    app = createApp();
    await pool.query('DELETE FROM recovery_proofs');
    await pool.query('DELETE FROM audit_checkpoints');
    await pool.query('DELETE FROM audit_events');
    await pool.query(
      'INSERT INTO users (id, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING',
      [
        '11111111-1111-1111-1111-111111111111',
        'dr_admin',
        'dr_admin@neronet.internal',
        'hash',
        'super-admin',
        '22222222-2222-2222-2222-222222222222',
        'dr_member',
        'dr_member@neronet.internal',
        'hash',
        'member'
      ]
    );
    superAdminToken = jwt.sign(
      { id: '11111111-1111-1111-1111-111111111111', username: 'dr_admin', role: 'super-admin' },
      config.JWT_SECRET,
      { expiresIn: '1h' }
    );
    memberToken = jwt.sign(
      { id: '22222222-2222-2222-2222-222222222222', username: 'dr_member', role: 'member' },
      config.JWT_SECRET,
      { expiresIn: '1h' }
    );
    await pool.query('CREATE TABLE dr_payloads (value text, metadata jsonb)');
    await pool.query('INSERT INTO dr_payloads VALUES ($1,$2),($3,$4),($3,$4)', [
      'first',
      '{"nested":{"b":2,"a":1}}',
      'second',
      '{}'
    ]);
    await logAuditEvent({ eventType: 'SYSTEM_BOOTSTRAP', message: 'DR test event' });
    await AuditChainService.createCheckpoint();
  });

  after(async () => {
    await closeDatabase();
    await maintenancePool?.end();
    await dbHelper?.cleanup();
  });

  // A PostgreSQL template copy gives each test independent schema, rows and
  // sequences. The backup drill, separately, exercises pg_dump and restic.
  async function withRestoredDatabase(check) {
    await settleAuditWrites();
    const targetName = 'neronet_dr_' + process.pid + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    // Close and drain the shared source pool before PostgreSQL terminates
    // connections to make the source database eligible for TEMPLATE cloning.
    // Otherwise idle pool clients receive an asynchronous admin-termination
    // error and intermittently fail this test outside the active assertion.
    const sourcePool = pool;
    let sourcePoolError;
    sourcePool.on('error', (err) => {
      sourcePoolError = err;
    });
    await closeDatabase();
    await maintenancePool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbHelper.dbName]
    );
    await maintenancePool.query('CREATE DATABASE "' + targetName + '" TEMPLATE "' + dbHelper.dbName + '"');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sourcePoolError, undefined, 'template cloning must not terminate idle clients in the source pool');
    pool = getPgPool();
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = '/' + targetName;
    const targetPool = new Pool({ connectionString: targetUrl.toString() });
    try {
      await check(targetPool, targetUrl.toString());
    } finally {
      await targetPool.end();
      await settleAuditWrites();
      await maintenancePool.query('DROP DATABASE "' + targetName + '" WITH (FORCE)');
    }
  }

  function verify(targetPool, options = {}) {
    return BackupRecoveryProofService.verifyRestoredDatabase({ sourcePool: pool, targetPool, ...options });
  }

  it('rejects a changed value even when every table has the same row count', async () => {
    await withRestoredDatabase(async (targetPool) => {
      await targetPool.query('UPDATE users SET email = $1 WHERE id = $2', [
        'changed@neronet.internal',
        '22222222-2222-2222-2222-222222222222'
      ]);
      await assert.rejects(verify(targetPool), /data mismatch.*users/);
    });
  });

  it('canonicalizes equivalent varchar CHECK definitions returned before and after pg_dump restore', () => {
    const source = "CHECK (action::text = ANY (ARRAY['ACCEPT'::character varying, 'DROP'::character varying]::text[]))";
    const restored =
      "CHECK (action::text = ANY (ARRAY['ACCEPT'::character varying::text, 'DROP'::character varying::text]))";
    const changed =
      "CHECK (action::text = ANY (ARRAY['ACCEPT'::character varying::text, 'BLOCK'::character varying::text]))";

    assert.equal(normalizeConstraintDefinition(source), normalizeConstraintDefinition(restored));
    assert.notEqual(normalizeConstraintDefinition(source), normalizeConstraintDefinition(changed));
  });

  it('preserves quoted CHECK values and leaves unsupported expressions strict', () => {
    const source =
      "CHECK (action::text = ANY (ARRAY['QUOTE''S'::character varying, '::character varying::text], ::text[]'::character varying]::text[]))";
    const restored =
      "CHECK (action::text = ANY (ARRAY['QUOTE''S'::character varying::text, '::character varying::text], ::text[]'::character varying::text]))";
    assert.equal(normalizeConstraintDefinition(source), normalizeConstraintDefinition(restored));
    assert.ok(normalizeConstraintDefinition(source).includes("'::character varying::text], ::text[]'"));
    const unrelated = "CHECK (other = '::character varying::text')";
    assert.equal(normalizeConstraintDefinition(unrelated), unrelated);
    assert.notEqual(
      normalizeConstraintDefinition(source),
      normalizeConstraintDefinition(source.replace("'::character varying::text], ::text[]'", "'different'"))
    );
  });

  it('verifies all public tables, schema and sequences of a real separate copy', async () => {
    await withRestoredDatabase(async (targetPool) => {
      const proof = await verify(targetPool);
      assert.equal(proof.status, 'VERIFIED_PASS');
      assert.equal(proof.source_database, dbHelper.dbName);
      assert.notEqual(proof.target_database, proof.source_database);
      assert.equal(proof.audit_chain.valid, true);
      assert.ok(proof.audit_chain.checkpoints_verified > 0);
      assert.ok(proof.tables_verified.acl_rules !== undefined);
      assert.ok(proof.tables_verified.node_credentials !== undefined);
      assert.equal(proof.tables_verified.dr_payloads, 3);
      for (const key of ['integrity_hash', 'schema_hash', 'data_hash', 'sequence_hash'])
        assert.match(proof[key], /^[a-f0-9]{64}$/);
      assert.equal((await BackupRecoveryProofService.getLatestProof(pool)).status, 'VERIFIED_PASS');
    });
  });

  it('ignores row order and JSON object key order while preserving duplicates', async () => {
    await withRestoredDatabase(async (targetPool) => {
      await targetPool.query('DELETE FROM dr_payloads');
      await targetPool.query('INSERT INTO dr_payloads VALUES ($1,$2),($1,$2),($3,$4)', [
        'second',
        '{}',
        'first',
        '{"nested":{"a":1,"b":2}}'
      ]);
      assert.equal((await verify(targetPool)).status, 'VERIFIED_PASS');
    });
  });

  it('rejects data changes outside the former critical-table list', async () => {
    await withRestoredDatabase(async (targetPool) => {
      await targetPool.query("UPDATE dr_payloads SET value = 'altered' WHERE value = 'first'");
      await assert.rejects(verify(targetPool), /data mismatch.*dr_payloads/);
    });
  });

  it('rejects a changed default, a removed constraint and an extra table', async () => {
    const mutations = [
      "ALTER TABLE users ALTER COLUMN email SET DEFAULT 'unexpected@neronet.internal'",
      'ALTER TABLE users DROP CONSTRAINT users_email_key',
      'CREATE TABLE unexpected_table (value text)'
    ];
    for (const sql of mutations) {
      await withRestoredDatabase(async (targetPool) => {
        await targetPool.query(sql);
        await assert.rejects(verify(targetPool), /schema mismatch/);
      });
    }
  });

  it('rejects sequence is_called changes with identical last_value', async () => {
    await withRestoredDatabase(async (targetPool) => {
      const state = (await pool.query('SELECT last_value, is_called FROM overlay_vip_seq')).rows[0];
      await targetPool.query("SELECT setval('overlay_vip_seq', $1, $2)", [state.last_value, !state.is_called]);
      await assert.rejects(verify(targetPool), /sequence mismatch/);
    });
  });

  it('rejects tampered audit content, a wrong HMAC key and unverifiable checkpoints', async () => {
    await withRestoredDatabase(async (targetPool) => {
      await targetPool.query("UPDATE audit_events SET message = 'tampered' WHERE sequence_num = 1");
      await assert.rejects(verify(targetPool), /audit chain validation error.*HASH_TAMPERED/);
    });
    await withRestoredDatabase(async (targetPool) => {
      await assert.rejects(
        verify(targetPool, { secret: 'wrong-audit-key' }),
        /audit chain validation error.*UNKNOWN_KEY/
      );
    });
    await withRestoredDatabase(async (targetPool) => {
      await targetPool.query("UPDATE audit_checkpoints SET signature = repeat('0', 128)");
      await assert.rejects(verify(targetPool), /audit.*checkpoint/i);
    });
  });

  it('rejects missing target, same pool and same database via another pool', async () => {
    await assert.rejects(verify(undefined), /target.*required/i);
    await assert.rejects(verify(pool), /separate.*database/i);
    const sameDatabasePool = new Pool({ connectionString: sourceUrl });
    try {
      await assert.rejects(verify(sameDatabasePool), /separate.*database/i);
    } finally {
      await sameDatabasePool.end();
    }
  });

  it('API rejects missing target and source URL without issuing PASS', async () => {
    for (const body of [{}, { targetDbUrl: ' ' }, { targetDbUrl: sourceUrl, targetDbName: 'fake_restore' }]) {
      const res = await request(app)
        .post('/api/audit/recovery-proof/verify')
        .set('Authorization', 'Bearer ' + superAdminToken)
        .send(body);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.proof, undefined);
    }
  });

  it('API rejects members and verifies a separate target for a super-admin', async () => {
    const denied = await request(app)
      .post('/api/audit/recovery-proof/verify')
      .set('Authorization', 'Bearer ' + memberToken)
      .send({});
    assert.equal(denied.statusCode, 403);
    await withRestoredDatabase(async (_targetPool, targetDbUrl) => {
      const res = await request(app)
        .post('/api/audit/recovery-proof/verify')
        .set('Authorization', 'Bearer ' + superAdminToken)
        .send({ targetDbUrl });
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      assert.equal(res.body.proof.status, 'VERIFIED_PASS');
    });
    const latest = await request(app)
      .get('/api/audit/recovery-proof/latest')
      .set('Authorization', 'Bearer ' + memberToken);
    assert.equal(latest.statusCode, 200);
    assert.ok(latest.body.proof);
  });

  it('CLI verifies with an audit HMAC key distinct from its JWT key', async () => {
    await withRestoredDatabase(async (_targetPool, targetUrl) => {
      const result = spawnSync(process.execPath, [require.resolve('../scripts/dr-prover')], {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          DATABASE_URL: sourceUrl,
          RESTORE_DATABASE_URL: targetUrl,
          SOVEREIGN_DATA_DIR: config.DATA_DIR,
          SOVEREIGN_AUDIT_HMAC_SECRET: config.AUDIT_HMAC_SECRET,
          SOVEREIGN_JWT_SECRET: 'a-different-cli-jwt-signing-secret'
        }
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PASS: separate quiescent databases match/);
      assert.ok(!result.stdout.includes(config.AUDIT_HMAC_SECRET));
    });
  });
});
