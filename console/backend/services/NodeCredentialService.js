/**
 * Node Credential Service.
 *
 * Implements ADR 0017 (Node Identity v2):
 * - Opaque 256-bit bearer token generation (nnt1_<hex>)
 * - SHA-256 hashed storage in node_credentials
 * - 24-hour TTL with automatic rotation when remaining life is under 12 hours
 * - Immediate credential invalidation upon node quarantine or revocation
 */

const crypto = require('crypto');
const { getPgPool } = require('../db/index');
const logger = require('../utils/logger');

const TOKEN_PREFIX = 'nnt1_';

function hashToken(rawToken) {
  return crypto
    .createHash('sha256')
    .update(String(rawToken || '').trim())
    .digest('hex');
}

/**
 * Mints an ephemeral bearer credential for an enrolled node.
 */
async function mintCredential(nodeId, ttlHours = 24) {
  if (!nodeId) {
    throw new Error('nodeId is required to mint a credential');
  }

  const rawRandom = crypto.randomBytes(32).toString('hex');
  const credential = `${TOKEN_PREFIX}${rawRandom}`;
  const tokenHash = hashToken(credential);
  const credId = `nc_${crypto.randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  const pool = getPgPool();
  await pool.query(
    `INSERT INTO node_credentials (id, node_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [credId, nodeId, tokenHash, expiresAt]
  );

  return {
    credentialId: credId,
    credential,
    expiresAt: expiresAt.toISOString(),
    expiresAtDate: expiresAt
  };
}

/**
 * Validates a bearer credential presented on /v4/control/* endpoints.
 */
async function validateCredential(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { ok: false, status: 401, error: 'authorization bearer token required' };
  }

  const cleanToken = rawToken.trim();
  const tokenHash = hashToken(cleanToken);
  const pool = getPgPool();

  try {
    const res = await pool.query(
      `SELECT nc.id AS credential_id, nc.node_id, nc.expires_at, nc.revoked_at,
              n.role, n.user_id, n.is_quarantined
       FROM node_credentials nc
       JOIN nodes n ON nc.node_id = n.id
       WHERE nc.token_hash = $1`,
      [tokenHash]
    );

    if (res.rows.length === 0) {
      return { ok: false, status: 401, error: 'invalid node credential' };
    }

    const row = res.rows[0];

    if (row.revoked_at) {
      return { ok: false, status: 401, error: 'node credential has been revoked' };
    }

    if (new Date(row.expires_at) < new Date()) {
      return { ok: false, status: 401, error: 'node credential has expired' };
    }

    if (row.is_quarantined) {
      return { ok: false, status: 403, error: 'node is quarantined', quarantined: true };
    }

    // Touch last_used_at asynchronously
    pool
      .query('UPDATE node_credentials SET last_used_at = NOW() WHERE id = $1', [row.credential_id])
      .catch((e) => logger.warn(`Failed updating last_used_at on credential: ${e.message}`));

    return {
      ok: true,
      node: {
        id: row.node_id,
        role: row.role,
        userId: row.user_id,
        credentialId: row.credential_id,
        expiresAt: row.expires_at
      }
    };
  } catch (err) {
    logger.error(`Error validating node credential: ${err.message}`);
    return { ok: false, status: 500, error: 'internal database error during credential check' };
  }
}

/**
 * Revokes all active credentials for a given node.
 */
async function revokeNodeCredentials(nodeId) {
  if (!nodeId) return 0;
  const pool = getPgPool();
  const res = await pool.query(
    'UPDATE node_credentials SET revoked_at = NOW() WHERE node_id = $1 AND revoked_at IS NULL',
    [nodeId]
  );
  return res.rowCount;
}

/**
 * Checks if credential lifetime has less than threshold remaining and rotates it.
 */
async function checkAndRotateCredential(credentialId, nodeId, remainingHoursThreshold = 12) {
  const pool = getPgPool();
  try {
    const res = await pool.query('SELECT expires_at FROM node_credentials WHERE id = $1', [credentialId]);
    if (res.rows.length === 0) {
      return { rotated: false };
    }

    const expiresAt = new Date(res.rows[0].expires_at);
    const msRemaining = expiresAt.getTime() - Date.now();
    const thresholdMs = remainingHoursThreshold * 3600 * 1000;

    if (msRemaining < thresholdMs) {
      const minted = await mintCredential(nodeId, 24);
      // Mark previous credential revoked
      await pool.query('UPDATE node_credentials SET revoked_at = NOW() WHERE id = $1', [credentialId]);
      return {
        rotated: true,
        new_credential: minted.credential,
        credential_expires_at: minted.expiresAt
      };
    }
  } catch (err) {
    logger.warn(`Error checking credential rotation for node ${nodeId}: ${err.message}`);
  }

  return { rotated: false };
}

module.exports = {
  hashToken,
  mintCredential,
  validateCredential,
  revokeNodeCredentials,
  checkAndRotateCredential
};
