const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const config = require('../config/env');
const { logAuditEvent } = require('../utils/audit');
const { BackupRecoveryProofService } = require('../services/BackupRecoveryProofService');

describe('WP-306: Automated Disaster Recovery Backup & Recovery Proof Verification', () => {
  let dbHelper;
  let pool;
  let app;
  let superAdminToken;
  let memberToken;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    // Clean tables
    await pool.query('DELETE FROM recovery_proofs');
    await pool.query('DELETE FROM audit_checkpoints');
    await pool.query('DELETE FROM audit_events');

    // Create a super-admin user in database to satisfy foreign keys
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role)
       VALUES ('11111111-1111-1111-1111-111111111111', 'dr_admin', 'dr_admin@neronet.internal', 'hash', 'super-admin')
       ON CONFLICT (id) DO NOTHING`
    );

    // Create a normal member user
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role)
       VALUES ('22222222-2222-2222-2222-222222222222', 'dr_member', 'dr_member@neronet.internal', 'hash', 'member')
       ON CONFLICT (id) DO NOTHING`
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

    // Seed verifiable audit trail
    await logAuditEvent({
      eventType: 'SYSTEM_BOOTSTRAP',
      severity: 'info',
      actorUsername: 'dr_admin',
      message: 'Initial DR test event'
    });

    await logAuditEvent({
      eventType: 'KEY_ROTATION',
      severity: 'warn',
      actorUsername: 'dr_admin',
      message: 'Secondary DR test event'
    });
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('1. collects accurate table statistics across all base tables', async () => {
    const stats = await BackupRecoveryProofService.collectTableStats(pool);
    assert.ok(stats, 'Table stats must be returned');
    assert.ok(stats.users >= 2, 'Should count at least 2 users');
    assert.ok(stats.audit_events >= 2, 'Should count at least 2 audit events');
    assert.ok(stats._migrations >= 1, 'Should count migrations');
  });

  it('2. verifies matching restored database with PASS and valid HMAC proof', async () => {
    // When source and target pools are identical (simulating successful clean restore)
    const proof = await BackupRecoveryProofService.verifyRestoredDatabase({
      sourcePool: pool,
      targetPool: pool,
      sourceDbName: 'neronet_primary',
      targetDbName: 'neronet_ephemeral_restore',
      actorUserId: '11111111-1111-1111-1111-111111111111'
    });

    assert.strictEqual(proof.status, 'VERIFIED_PASS');
    assert.ok(proof.integrity_hash);
    assert.strictEqual(proof.audit_chain.valid, true);
    assert.strictEqual(proof.audit_chain.events_count >= 2, true);
    assert.ok(proof.tables_verified.users >= 2);
    assert.ok(proof.total_records_verified > 0);
  });

  it('3. stores proof certificate in recovery_proofs and retrieves latest proof', async () => {
    const latest = await BackupRecoveryProofService.getLatestProof(pool);
    assert.ok(latest, 'Latest proof must exist');
    assert.strictEqual(latest.status, 'VERIFIED_PASS');
    assert.strictEqual(latest.source_database, 'neronet_primary');
    assert.ok(latest.integrity_hash);
  });

  it('4. fails closed when target database has row count mismatch', async () => {
    // Mock target pool with mismatching row count
    const mockTargetPool = {
      query: async (sql, params) => {
        if (sql.includes('information_schema.tables')) {
          return pool.query(sql, params);
        }
        if (sql.includes('"users"')) {
          // Return forged count (1 instead of 2+)
          return { rows: [{ c: '1' }] };
        }
        return pool.query(sql, params);
      }
    };

    await assert.rejects(
      async () => {
        await BackupRecoveryProofService.verifyRestoredDatabase({
          sourcePool: pool,
          targetPool: mockTargetPool,
          sourceDbName: 'primary',
          targetDbName: 'tampered_target'
        });
      },
      /row count mismatch/
    );

    // Verify failure was recorded in recovery_proofs
    const latest = await BackupRecoveryProofService.getLatestProof(pool);
    assert.strictEqual(latest.status, 'VERIFIED_FAIL');
    assert.ok(latest.error_message.includes('row count mismatch'));
  });

  it('5. fails closed when target database audit chain has tampered HMAC hash', async () => {
    // Mock target pool with tampered audit event
    const mockTargetPool = {
      query: async (sql, params) => {
        if (sql.includes('SELECT * FROM audit_events')) {
          const res = await pool.query(sql, params);
          const forgedRows = res.rows.map((r) => ({ ...r }));
          // Tamper with payload message without updating entry_hash
          if (forgedRows.length > 0) {
            forgedRows[0].message = 'MALICIOUS_TAMPERED_CONTENT';
          }
          return { rows: forgedRows };
        }
        return pool.query(sql, params);
      }
    };

    await assert.rejects(
      async () => {
        await BackupRecoveryProofService.verifyRestoredDatabase({
          sourcePool: pool,
          targetPool: mockTargetPool,
          sourceDbName: 'primary',
          targetDbName: 'tampered_audit_target'
        });
      },
      /audit chain validation error.*HASH_TAMPERED/
    );
  });

  it('6. API: GET /api/audit/recovery-proof/latest returns proof to authenticated users', async () => {
    const res = await request(app)
      .get('/api/audit/recovery-proof/latest')
      .set('Authorization', `Bearer ${memberToken}`);

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.proof);
  });

  it('7. API: POST /api/audit/recovery-proof/verify rejects non-admin users with 403', async () => {
    const res = await request(app)
      .post('/api/audit/recovery-proof/verify')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({});

    assert.strictEqual(res.statusCode, 403);
    assert.ok(res.body.error.includes('Forbidden'));
  });

  it('8. API: POST /api/audit/recovery-proof/verify succeeds for super-admin', async () => {
    const res = await request(app)
      .post('/api/audit/recovery-proof/verify')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ targetDbName: 'api_triggered_verification' });

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.proof.status, 'VERIFIED_PASS');
    assert.ok(res.body.proof.integrity_hash);
  });
});
