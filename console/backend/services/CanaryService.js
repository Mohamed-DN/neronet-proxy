const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { isPostgres, getPgPool, getDatabase } = require('../db/index');
const logger = require('../utils/logger');

let ownerKeypair = null;
let cachedLatestCanary = null;

/**
 * Initializes or retrieves the singleton Ed25519 owner keypair.
 */
function getOrCreateOwnerKeypair() {
  if (ownerKeypair) {
    return ownerKeypair;
  }

  // Generate a standard Ed25519 keypair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });

  // Extract 32-byte raw public key buffer from SPKI DER encoding
  const pubRaw = Buffer.from(pubDer.subarray(pubDer.length - 32));
  const privRaw = Buffer.from(privDer.subarray(privDer.length - 32));

  ownerKeypair = {
    privateKey,
    publicKey,
    publicKeyBase64: pubRaw.toString('base64'),
    publicKeyHex: pubRaw.toString('hex'),
    privateKeyBase64: privRaw.toString('base64'),
    privateKeyHex: privRaw.toString('hex')
  };

  return ownerKeypair;
}

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
            is_active BOOLEAN NOT NULL DEFAULT TRUE
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
            is_active INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_warrant_canaries_published ON warrant_canaries(published_at DESC);
      `);
    }
  } catch (err) {
    logger.warn(`CanaryService ensureTables notice: ${err.message}`);
  }
}

/**
 * Builds the canonical statement text for signing.
 */
function buildCanonicalStatement(dateIso, publicKeyBase64) {
  const dateShort = dateIso.split('T')[0];
  return `NERONET SOVEREIGN MESH WARRANT CANARY
=========================================================
Declaration Date: ${dateShort}
ISO8601 Timestamp: ${dateIso}
Signer Identity: NeroNet Master Network Owner (Super-Admin)
Signer Public Key (Ed25519 Base64): ${publicKeyBase64}

DECLARATION OF TRANSPARENCY:
As of ${dateIso}, the operators and infrastructure of the NeroNet
Sovereign Mesh Network have NOT received:
1. Any National Security Letters (NSLs) under 12 U.S.C. § 3414 or 18 U.S.C. § 2709.
2. Any Foreign Intelligence Surveillance Act (FISA) court orders or 702 directives.
3. Any secret subpoenas, search warrants, or court orders with non-disclosure / gag provisions.
4. Any government or law enforcement requests to insert backdoors, weaken cryptography,
   or disclose user Noise/WireGuard encryption private keys.

All network communications remain end-to-end encrypted with zero-knowledge metadata.
If this canary is not refreshed within the heartbeat interval, assume compromise.`;
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
 * Generates a fresh, signed warrant canary and persists it.
 */
async function generateCanary(customStatement = null) {
  await ensureTables();
  const keypair = getOrCreateOwnerKeypair();
  const canaryId = `cnry-${uuidv4().substring(0, 8)}`;
  const nowIso = new Date().toISOString();

  const statement = customStatement || buildCanonicalStatement(nowIso, keypair.publicKeyBase64);

  // Sign canonical statement with Ed25519 private key
  const signatureBuf = crypto.sign(null, Buffer.from(statement, 'utf8'), keypair.privateKey);
  const signatureBase64 = signatureBuf.toString('base64');

  const rawText = formatArmoredCanary(statement, signatureBase64, keypair.publicKeyBase64, nowIso);

  try {
    if (isPostgres()) {
      const pool = getPgPool();
      // Deactivate older canaries
      await pool.query('UPDATE warrant_canaries SET is_active = FALSE WHERE is_active = TRUE');
      await pool.query(
        `
        INSERT INTO warrant_canaries (
          id, published_at, statement_text, ed25519_signature, signer_public_key, is_active
        ) VALUES ($1, $2, $3, $4, $5, TRUE)
      `,
        [canaryId, nowIso, statement, signatureBase64, keypair.publicKeyBase64]
      );
    } else {
      const db = getDatabase();
      db.prepare('UPDATE warrant_canaries SET is_active = 0 WHERE is_active = 1').run();
      db.prepare(
        `
        INSERT INTO warrant_canaries (
          id, published_at, statement_text, ed25519_signature, signer_public_key, is_active
        ) VALUES (?, ?, ?, ?, ?, 1)
      `
      ).run(canaryId, nowIso, statement, signatureBase64, keypair.publicKeyBase64);
    }
  } catch (err) {
    logger.warn(`Could not save canary to DB: ${err.message}`);
  }

  const canaryObj = {
    id: canaryId,
    published_at: nowIso,
    statement_text: statement,
    ed25519_signature: signatureBase64,
    signer_public_key: keypair.publicKeyBase64,
    is_active: true,
    valid: true,
    raw: rawText
  };

  cachedLatestCanary = canaryObj;
  return canaryObj;
}

/**
 * Retrieves the latest active warrant canary.
 */
async function getLatestCanary() {
  await ensureTables();

  try {
    let row = null;
    if (isPostgres()) {
      const pool = getPgPool();
      const res = await pool.query(
        'SELECT * FROM warrant_canaries WHERE is_active = TRUE ORDER BY published_at DESC LIMIT 1'
      );
      row = res.rows[0] || null;
    } else {
      const db = getDatabase();
      row =
        db.prepare('SELECT * FROM warrant_canaries WHERE is_active = 1 ORDER BY published_at DESC LIMIT 1').get() ||
        null;
    }

    if (row) {
      const rawText = formatArmoredCanary(
        row.statement_text,
        row.ed25519_signature,
        row.signer_public_key,
        row.published_at
      );
      const isValid = verifyCanary(row.statement_text, row.ed25519_signature, row.signer_public_key);
      const canaryObj = {
        id: row.id,
        published_at: row.published_at,
        statement_text: row.statement_text,
        ed25519_signature: row.ed25519_signature,
        signer_public_key: row.signer_public_key,
        is_active: Boolean(row.is_active),
        valid: isValid,
        raw: rawText
      };
      cachedLatestCanary = canaryObj;
      return canaryObj;
    }
  } catch (err) {
    logger.warn(`Failed reading canary from DB: ${err.message}`);
  }

  if (cachedLatestCanary && cachedLatestCanary.is_active) {
    return cachedLatestCanary;
  }

  // Generate an initial canary if none exists
  return await generateCanary();
}

/**
 * Invalidates and marks all active canaries as inactive / stale.
 */
async function invalidateCanary() {
  await ensureTables();
  cachedLatestCanary = null;

  try {
    if (isPostgres()) {
      const pool = getPgPool();
      await pool.query('UPDATE warrant_canaries SET is_active = FALSE');
    } else {
      const db = getDatabase();
      db.prepare('UPDATE warrant_canaries SET is_active = 0').run();
    }
  } catch (err) {
    logger.warn(`Failed invalidating canary: ${err.message}`);
  }
}

/**
 * Initializes CanaryService on application startup.
 */
async function initCanaryService() {
  getOrCreateOwnerKeypair();
  await ensureTables();
  await getLatestCanary();
  logger.info('Warrant Canary Service initialized with Ed25519 signature verification.');
}

module.exports = {
  initCanaryService,
  ensureTables,
  getOrCreateOwnerKeypair,
  buildCanonicalStatement,
  formatArmoredCanary,
  generateCanary,
  getLatestCanary,
  verifyCanary,
  invalidateCanary
};
