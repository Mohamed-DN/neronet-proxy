#!/usr/bin/env node
const { Pool } = require('pg');
const { BackupRecoveryProofService } = require('../services/BackupRecoveryProofService');
const logger = require('../utils/logger');

async function main() {
  const sourceUrl = process.env.DATABASE_URL || 'postgresql://neronet:neronet_dev_password@localhost:5432/neronet_test';
  const targetUrl = process.env.RESTORE_DATABASE_URL || process.env.TARGET_DATABASE_URL;

  if (!targetUrl) {
    console.error('ERROR: RESTORE_DATABASE_URL environment variable is required.');
    console.error('Usage: RESTORE_DATABASE_URL=postgresql://... node dr-prover.js');
    process.exit(1);
  }

  const sourcePool = new Pool({ connectionString: sourceUrl });
  const targetPool = new Pool({ connectionString: targetUrl });

  try {
    console.log('===============================================================');
    console.log('🛡️  NeroNet Automated Disaster Recovery & Backup Proof Verifier');
    console.log('===============================================================');

    const proof = await BackupRecoveryProofService.verifyRestoredDatabase({
      sourcePool,
      targetPool,
      sourceDbName: process.env.SOURCE_DB_NAME || 'primary',
      targetDbName: process.env.TARGET_DB_NAME || 'restored_ephemeral',
      secret: process.env.SOVEREIGN_JWT_SECRET
    });

    console.log('\n[✓] DISASTER RECOVERY PROOF VERIFIED SUCCESSFULLY:');
    console.log(JSON.stringify(proof, null, 2));
    console.log('\nIntegrity Hash:', proof.integrity_hash);
    console.log('Status: PASS (Zero data loss, HMAC chain fully intact)\n');

    await sourcePool.end();
    await targetPool.end();
    process.exit(0);
  } catch (err) {
    console.error('\n[✗] DISASTER RECOVERY PROOF FAILED:');
    console.error(err.message);
    await sourcePool.end();
    await targetPool.end();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
