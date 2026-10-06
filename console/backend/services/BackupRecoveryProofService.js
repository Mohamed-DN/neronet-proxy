const { getPgPool } = require('../db/index');
const { AuditChainService } = require('./AuditChainService');
const { logAuditEvent } = require('../utils/audit');
const logger = require('../utils/logger');
const { collectSchema, collectSequences, collectData, digest, quoteIdentifier } = require('./DatabaseRecoverySnapshot');

const CRITICAL_TABLES = [
  '_migrations',
  'users',
  'nodes',
  'organizations',
  'compartments',
  'audit_events',
  'audit_checkpoints',
  'node_credentials',
  'preauth_keys',
  'acl_rules',
  'compartment_peerings',
  'organization_keys'
];

function invalidTarget(message) {
  const error = new Error(message);
  error.code = 'DR_INVALID_TARGET';
  return error;
}

class BackupRecoveryProofService {
  static async collectTableStats(pool) {
    const res = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    );
    const stats = {};
    for (const row of res.rows) {
      const count = await pool.query('SELECT count(*)::bigint AS c FROM public.' + quoteIdentifier(row.table_name));
      stats[row.table_name] = Number(count.rows[0].c);
    }
    return stats;
  }

  // Compare two quiescent databases. This does not take a backup, restore one or
  // prove offsite storage. Actual names must differ so URL aliases and caller
  // labels cannot certify the source through another connection.
  static async verifyRestoredDatabase({ sourcePool, targetPool, secret, actorUserId = null }) {
    if (!targetPool) throw invalidTarget('A target restored database is required');
    if (!sourcePool || sourcePool === targetPool) {
      throw invalidTarget('Recovery verification requires a separate target database');
    }
    const startTime = Date.now();
    let sourceClient, targetClient;
    let sourceDbName = 'unknown',
      targetDbName = 'unknown';
    let auditChainResult = {};
    let verifiedTables = {};
    let fingerprints;
    let failure;
    try {
      sourceClient = await sourcePool.connect();
      targetClient = await targetPool.connect();
      sourceDbName = (await sourceClient.query('SELECT current_database() AS name')).rows[0].name;
      targetDbName = (await targetClient.query('SELECT current_database() AS name')).rows[0].name;
      if (sourceDbName === targetDbName) {
        throw invalidTarget('Recovery verification requires a separate target database with a different database name');
      }
      for (const client of [sourceClient, targetClient]) {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
        await client.query('SET LOCAL search_path = public, pg_catalog');
        await client.query('SET LOCAL row_security = off');
      }
      const sourceSchema = await collectSchema(sourceClient);
      const targetSchema = await collectSchema(targetClient);
      const schemaHash = digest(sourceSchema);
      if (schemaHash !== digest(targetSchema)) throw new Error('Disaster recovery proof failed: schema mismatch');
      for (const name of CRITICAL_TABLES) {
        if (!sourceSchema.relations.some((r) => r.name === name && ['r', 'p'].includes(r.kind))) {
          throw new Error('Disaster recovery proof failed: required table "' + name + '" missing');
        }
      }
      auditChainResult = await AuditChainService.verifyChain({ pool: targetClient, secret });
      if (!auditChainResult.valid) {
        throw new Error(
          'Disaster recovery proof failed: audit chain validation error [' +
            auditChainResult.reason +
            ']: ' +
            auditChainResult.message
        );
      }
      if (auditChainResult.checkpoints_unverifiable > 0) {
        throw new Error(
          'Disaster recovery proof failed: audit checkpoints cannot be verified with the trusted signing key'
        );
      }
      const sourceSequences = await collectSequences(sourceClient, sourceSchema);
      const targetSequences = await collectSequences(targetClient, targetSchema);
      const sequenceHash = digest(sourceSequences);
      if (sequenceHash !== digest(targetSequences))
        throw new Error('Disaster recovery proof failed: sequence mismatch');
      const sourceData = await collectData(sourceClient, sourceSchema);
      const targetData = await collectData(targetClient, targetSchema);
      for (const [name, source] of Object.entries(sourceData)) {
        const target = targetData[name];
        verifiedTables[name] = target.count;
        if (source.count !== target.count || source.hash !== target.hash) {
          throw new Error('Disaster recovery proof failed: data mismatch in table "' + name + '"');
        }
      }
      // Sequence state is outside MVCC; movement during a scan means writers
      // have not been stopped as this comparison requires.
      if (
        sequenceHash !== digest(await collectSequences(sourceClient, sourceSchema)) ||
        sequenceHash !== digest(await collectSequences(targetClient, targetSchema))
      ) {
        throw new Error('Disaster recovery proof failed: sequence changed during verification; stop database writers');
      }
      fingerprints = { schema_hash: schemaHash, data_hash: digest(sourceData), sequence_hash: sequenceHash };
      await sourceClient.query('COMMIT');
      await targetClient.query('COMMIT');
    } catch (err) {
      failure = err;
    } finally {
      for (const client of [sourceClient, targetClient]) {
        if (client) {
          await client.query('ROLLBACK').catch(() => {});
          client.release();
        }
      }
    }
    if (failure) {
      if (failure.code !== 'DR_INVALID_TARGET') {
        await this.recordFailure({
          sourcePool,
          sourceDbName,
          targetDbName,
          errorMsg: failure.message,
          actorUserId,
          startTime,
          tablesVerified: verifiedTables,
          auditChainStatus: auditChainResult
        });
      }
      throw failure;
    }

    const durationMs = Date.now() - startTime;
    const totalRecords = Object.values(verifiedTables).reduce((sum, count) => sum + count, 0);
    auditChainResult.database_fingerprints = fingerprints;
    const integrityHash = digest({
      version: 2,
      source_database: sourceDbName,
      target_database: targetDbName,
      ...fingerprints,
      audit_head: auditChainResult.head_hash || 'genesis',
      audit_events: auditChainResult.events_count,
      checkpoints_verified: auditChainResult.checkpoints_verified
    });
    const proof = {
      status: 'VERIFIED_PASS',
      verified_at: new Date().toISOString(),
      source_database: sourceDbName,
      target_database: targetDbName,
      tables_verified: verifiedTables,
      audit_chain: auditChainResult,
      total_records_verified: totalRecords,
      execution_duration_ms: durationMs,
      integrity_hash: integrityHash,
      ...fingerprints,
      comparison_scope: 'public schema and data; database writers must be stopped',
      backup_restore_performed: false
    };
    // The proof and audit event are written after the compared snapshots end.
    try {
      const res = await sourcePool.query(
        "INSERT INTO recovery_proofs (proof_type, status, verified_at, source_database, target_database, tables_verified, audit_chain_status, total_records_verified, execution_duration_ms, integrity_hash, created_by_user_id) VALUES ('EPHEMERAL_RESTORE_VERIFICATION', $1, now(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
        [
          proof.status,
          sourceDbName,
          targetDbName,
          JSON.stringify(verifiedTables),
          JSON.stringify(auditChainResult),
          totalRecords,
          durationMs,
          integrityHash,
          actorUserId
        ]
      );
      proof.proof_id = res.rows[0].id;
    } catch (err) {
      logger.warn('Could not insert recovery proof row into source database: ' + err.message);
    }
    await logAuditEvent({
      eventType: 'DR_RECOVERY_PROOF_VERIFIED',
      severity: 'info',
      actorUserId,
      actorUsername: 'dr-prover',
      message:
        'Separate database comparison verified: ' +
        totalRecords +
        ' records across ' +
        Object.keys(verifiedTables).length +
        ' public tables',
      metadata: { integrityHash, durationMs, eventsVerified: auditChainResult.events_count, ...fingerprints }
    });
    logger.info('Disaster recovery database comparison PASSED in ' + durationMs + 'ms');
    return proof;
  }

  static async recordFailure({
    sourcePool,
    sourceDbName,
    targetDbName,
    errorMsg,
    actorUserId,
    startTime,
    tablesVerified = {},
    auditChainStatus = {}
  }) {
    const durationMs = Date.now() - startTime;
    try {
      await sourcePool.query(
        `INSERT INTO recovery_proofs (
          proof_type, status, verified_at, source_database, target_database,
          tables_verified, audit_chain_status, total_records_verified,
          execution_duration_ms, integrity_hash, created_by_user_id, error_message
        ) VALUES (
          'EPHEMERAL_RESTORE_VERIFICATION', 'VERIFIED_FAIL', now(), $1, $2,
          $3, $4, 0, $5, '0000000000000000000000000000000000000000000000000000000000000000', $6, $7
        )`,
        [
          sourceDbName,
          targetDbName,
          JSON.stringify(tablesVerified),
          JSON.stringify(auditChainStatus),
          durationMs,
          actorUserId,
          errorMsg
        ]
      );
    } catch (err) {}

    try {
      await logAuditEvent({
        eventType: 'DR_RECOVERY_PROOF_FAILED',
        severity: 'critical',
        actorUserId,
        actorUsername: 'dr-prover',
        message: `Disaster recovery proof failed: ${errorMsg}`,
        metadata: { errorMsg, durationMs }
      });
    } catch (err) {}
  }

  /**
   * Retrieves the most recent disaster recovery proof certificate.
   */
  static async getLatestProof(pool = null) {
    const activePool = pool || getPgPool();
    const res = await activePool.query(`SELECT * FROM recovery_proofs ORDER BY verified_at DESC LIMIT 1`);
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }
}

module.exports = { BackupRecoveryProofService, CRITICAL_TABLES };
