// Runs through the dedicated test backend's stdin; never prints sealed values or keys.
const assert = require('node:assert/strict');
const { getPgPool } = require('./db');
const { CryptoShreddingService } = require('./services/CryptoShreddingService');
const { AuditChainService } = require('./services/AuditChainService');
const pool = getPgPool();
const marker = 'neronet-backup-drill-secret';
const fixtureId = 'backup-drill-user';

async function main() {
  if (process.env.BACKUP_FIXTURE_MODE === 'seed') {
    const sealed = await CryptoShreddingService.sealForOrg('org-default', marker);
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id, totp_pending_secret)
       VALUES ($1, 'backup-drill-user', 'backup-drill@example.invalid', 'unused', 'member', 'org-default', $2)
       ON CONFLICT (id) DO UPDATE SET totp_pending_secret = EXCLUDED.totp_pending_secret`,
      [fixtureId, sealed]
    );
    await pool.query(
      `INSERT INTO acl_rules (id, action, source_cidr, destination_cidr, description, organization_id)
       VALUES ('backup-drill-acl', 'DROP', '192.0.2.0/24', '192.0.2.0/24', 'Backup drill marker', 'org-default')
       ON CONFLICT (id) DO NOTHING`
    );
    await AuditChainService.appendEvent({ eventType: 'BACKUP_DRILL', severity: 'info', message: 'Backup drill marker' });
    await AuditChainService.createCheckpoint();
  }
  const user = (await pool.query('SELECT totp_pending_secret FROM users WHERE id = $1', [fixtureId])).rows[0];
  assert.ok(user && CryptoShreddingService.isSealed(user.totp_pending_secret));
  assert.equal(await CryptoShreddingService.openForOrg('org-default', user.totp_pending_secret), marker);
  const chain = await AuditChainService.verifyChain();
  assert.equal(chain.valid, true);
  assert.equal(chain.checkpoints_unverifiable, 0);
  assert.ok(chain.checkpoints_verified > 0);
  for (const table of ['acl_rules', 'node_credentials', 'organization_keys', 'mesh_epochs']) {
    assert.ok(Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n) > 0, `${table} fixture is empty`);
  }
  console.log('Sealed secret opened; audit HMAC and signed checkpoint verified; ACL, credentials, organization keys and epochs present.');
}

main().then(() => pool.end()).catch(async (error) => {
  console.error(error.message);
  await pool.end();
  process.exitCode = 1;
});
