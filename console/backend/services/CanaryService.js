const crypto = require('crypto');
const { isPostgres, getPgPool, getDatabase } = require('../db/index');
const logger = require('../utils/logger');

/**
 * Ensures warrant_canaries table exists in PostgreSQL or SQLite.
 */
async function ensureTables(dbOrPool) {
  try {
    if (isPostgres()) {
      const pool = dbOrPool || getPgPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS warrant_canaries (
            id VARCHAR(64) PRIMARY KEY,
            published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            statement_text TEXT NOT NULL,
            ed25519_signature TEXT NOT NULL,
            signer_public_key TEXT NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            published_by VARCHAR(64)
        );
        CREATE INDEX IF NOT EXISTS idx_warrant_canaries_published ON warrant_canaries(published_at DESC);
      `);
    } else {
      const db = dbOrPool || getDatabase();
      db.exec(`
        CREATE TABLE IF NOT EXISTS warrant_canaries (
            id TEXT PRIMARY KEY,
            published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            statement_text TEXT NOT NULL,
            ed25519_signature TEXT NOT NULL,
            signer_public_key TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            published_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_warrant_canaries_published ON warrant_canaries(published_at DESC);
      `);
    }
  } catch (err) {
    logger.warn(`CanaryService ensureTables notice: ${err.message}`);
  }
}

/**
 * Builds the full formatted text file representation with armor headers.
 */
function formatArmoredCanary(statementText, signatureBase64, publicKeyBase64, publishedAt) {
  return `-----BEGIN NERONET WARRANT CANARY-----
Version: 4.0
Published-At: ${publishedAt}
Signer-Key: ${publicKeyBase64}

${statementText}

Signature:
${signatureBase64}
-----END NERONET WARRANT CANARY-----
`;
}

/**
 * Cryptographically verifies an Ed25519 signature over a statement.
 */
function verifyCanary(statementText, signatureBase64, publicKeyBase64) {
  if (!statementText || !signatureBase64 || !publicKeyBase64) {
    return false;
  }

  try {
    const pubKeyBuf = Buffer.from(publicKeyBase64, 'base64');
    // Reconstruct SPKI DER buffer for 32-byte Ed25519 public key
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const fullSpkiDer = Buffer.concat([spkiPrefix, pubKeyBuf]);

    const cryptoKey = crypto.createPublicKey({
      key: fullSpkiDer,
      format: 'der',
      type: 'spki'
    });

    const sigBuf = Buffer.from(signatureBase64, 'base64');
    const dataBuf = Buffer.from(statementText, 'utf8');

    return crypto.verify(null, dataBuf, cryptoKey, sigBuf);
  } catch (err) {
    logger.warn(`Canary cryptographic verification failed: ${err.message}`);
    return false;
  }
}

/**
 * The statement a person published, or null. Nothing is ever written or signed here: a warrant
 * canary that a server produces by itself says nothing, and says it in somebody's name.
 */
async function getLatestCanary() {
  await ensureTables();
  if (!isPostgres()) return null;
  const res = await getPgPool().query(
    `SELECT * FROM warrant_canaries
      WHERE is_active = TRUE AND published_by IS NOT NULL
      ORDER BY published_at DESC LIMIT 1`
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    published_at: row.published_at,
    published_by: row.published_by,
    statement_text: row.statement_text,
    ed25519_signature: row.ed25519_signature,
    signer_public_key: row.signer_public_key,
    is_active: true,
    valid: verifyCanary(row.statement_text, row.ed25519_signature, row.signer_public_key),
    raw: formatArmoredCanary(row.statement_text, row.ed25519_signature, row.signer_public_key, row.published_at)
  };
}

/** Withdraws whatever is published. */
async function invalidateCanary() {
  await ensureTables();
  try {
    if (isPostgres()) {
      await getPgPool().query('UPDATE warrant_canaries SET is_active = FALSE');
    } else {
      getDatabase().prepare('UPDATE warrant_canaries SET is_active = 0').run();
    }
  } catch (err) {
    logger.warn(`Failed invalidating canary: ${err.message}`);
  }
}

module.exports = { ensureTables, formatArmoredCanary, getLatestCanary, verifyCanary, invalidateCanary };
