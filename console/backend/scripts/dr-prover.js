#!/usr/bin/env node
const { Pool } = require('pg');
const { BackupRecoveryProofService } = require('../services/BackupRecoveryProofService');
const { closeDatabase } = require('../db/index');

async function main() {
  const sourceUrl = process.env.DATABASE_URL;
  const targetUrl = process.env.RESTORE_DATABASE_URL || process.env.TARGET_DATABASE_URL;
  const auditSecret = process.env.SOVEREIGN_AUDIT_HMAC_SECRET;
  if (!sourceUrl || !targetUrl || !auditSecret) {
    console.error('DATABASE_URL, RESTORE_DATABASE_URL and SOVEREIGN_AUDIT_HMAC_SECRET are required.');
    process.exitCode = 1;
    return;
  }
  const sourcePool = new Pool({ connectionString: sourceUrl, connectionTimeoutMillis: 10000 });
  const targetPool = new Pool({ connectionString: targetUrl, connectionTimeoutMillis: 10000 });
  try {
    const proof = await BackupRecoveryProofService.verifyRestoredDatabase({
      sourcePool,
      targetPool,
      secret: auditSecret
    });
    console.log(JSON.stringify(proof, null, 2));
    console.log('PASS: separate quiescent databases match in public schema, data and sequences.');
    console.log('This comparison does not perform a backup/restore or verify offsite storage.');
  } catch (err) {
    console.error('Recovery database comparison failed: ' + err.message);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([sourcePool.end(), targetPool.end()]);
    await closeDatabase();
  }
}

if (require.main === module) main();
module.exports = { main };
