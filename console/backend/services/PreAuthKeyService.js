/**
 * Pre-Auth Key Management Service.
 *
 * Implements ADR 0017 (Node Identity v2):
 * - Ephemeral & reusable pre-authenticated enrolment tokens
 * - Secure hashing (plaintext secret shown once upon creation)
 * - Single-use enforcement, expiration checks, and role boundaries
 * - Bootstrap key support for zero-touch staging fleet deployment
 */

const crypto = require('crypto');
const { getPgPool } = require('../db/index');
const logger = require('../utils/logger');

const SECRET_PREFIX = 'nnk1_';

function hashSecret(secret) {
  return crypto
    .createHash('sha256')
    .update(String(secret || '').trim())
    .digest('hex');
}

/**
 * Creates a new pre-auth key.
 */
async function createPreAuthKey({
  ownerId,
  organizationId = null,
  allowedRole = null,
  isReusable = false,
  maxUses = null,
  expiresInHours = 24
}) {
  if (!ownerId) {
    throw new Error('ownerId is required to create a pre-auth key');
  }

  const rawRandom = crypto.randomBytes(32).toString('hex');
  const secret = `${SECRET_PREFIX}${rawRandom}`;
  const keyHash = hashSecret(secret);
  const keyPrefix = secret.slice(0, 10);
  const keyId = `pak_${crypto.randomBytes(16).toString('hex')}`;

  const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600 * 1000) : null;
  const effectiveMaxUses = isReusable ? (maxUses ? Number(maxUses) : null) : 1;
  const orgId = organizationId || 'org-default';

  const pool = getPgPool();
  await pool.query(
    `INSERT INTO preauth_keys
       (id, key_hash, key_prefix, owner_id, organization_id, allowed_role, is_reusable, used_count, max_uses, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, NOW())`,
    [keyId, keyHash, keyPrefix, ownerId, orgId, allowedRole || null, Boolean(isReusable), effectiveMaxUses, expiresAt]
  );

  return {
    id: keyId,
    secret,
    key_prefix: keyPrefix,
    owner_id: ownerId,
    organization_id: orgId,
    allowed_role: allowedRole || null,
    is_reusable: Boolean(isReusable),
    max_uses: effectiveMaxUses,
    expires_at: expiresAt ? expiresAt.toISOString() : null
  };
}

/**
 * Validates and atomically increments/consumes a pre-auth key.
 */
async function validateAndConsumePreAuthKey(secret, requestedRole = null, targetOwnerId = null) {
  if (!secret || typeof secret !== 'string') {
    return { ok: false, status: 401, error: 'pre-auth key is required' };
  }

  const keyHash = hashSecret(secret);
  const pool = getPgPool();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query('SELECT * FROM preauth_keys WHERE key_hash = $1 FOR UPDATE', [keyHash]);
    if (res.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, status: 401, error: 'invalid pre-auth key' };
    }

    const key = res.rows[0];

    if (key.revoked_at) {
      await client.query('ROLLBACK');
      return { ok: false, status: 401, error: 'pre-auth key has been revoked' };
    }

    if (key.expires_at && new Date(key.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return { ok: false, status: 401, error: 'pre-auth key has expired' };
    }

    if (!key.is_reusable && key.used_count >= (key.max_uses || 1)) {
      await client.query('ROLLBACK');
      return { ok: false, status: 401, error: 'single-use pre-auth key has already been consumed' };
    }

    if (key.allowed_role && requestedRole && key.allowed_role !== requestedRole) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        status: 403,
        error: `pre-auth key restricts enrolment to role '${key.allowed_role}', cannot enrol as '${requestedRole}'`
      };
    }

    if (targetOwnerId && key.owner_id !== targetOwnerId) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        status: 403,
        error: 'pre-auth key owner does not match existing node owner'
      };
    }

    // Increment used count
    await client.query('UPDATE preauth_keys SET used_count = used_count + 1 WHERE id = $1', [key.id]);
    await client.query('COMMIT');

    return { ok: true, key };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`Error validating pre-auth key: ${err.message}`);
    return { ok: false, status: 500, error: 'internal database error during key validation' };
  } finally {
    client.release();
  }
}

/**
 * Lists pre-auth keys scoped by user / organization / super-admin.
 */
async function listPreAuthKeys(userId, isSuperAdmin = false, orgId = null) {
  const pool = getPgPool();
  let queryText = `
    SELECT id, key_prefix, owner_id, organization_id, allowed_role, is_reusable, used_count, max_uses, expires_at, revoked_at, created_at
    FROM preauth_keys
  `;
  const params = [];

  if (!isSuperAdmin) {
    if (orgId) {
      queryText += ' WHERE organization_id = $1';
      params.push(orgId);
    } else {
      queryText += ' WHERE owner_id = $1';
      params.push(userId);
    }
  }
  queryText += ' ORDER BY created_at DESC';

  const res = await pool.query(queryText, params);
  return res.rows;
}

/**
 * Revokes a pre-auth key.
 */
async function revokePreAuthKey(keyId, userId, isSuperAdmin = false, orgId = null) {
  const pool = getPgPool();
  let queryText = 'UPDATE preauth_keys SET revoked_at = NOW() WHERE id = $1';
  const params = [keyId];

  if (!isSuperAdmin) {
    if (orgId) {
      queryText += ' AND organization_id = $2';
      params.push(orgId);
    } else {
      queryText += ' AND owner_id = $2';
      params.push(userId);
    }
  }

  const res = await pool.query(queryText, params);
  return res.rowCount > 0;
}

/**
 * Idempotently registers or verifies the staging bootstrap pre-auth key.
 */
async function ensureBootstrapKey(bootstrapSecret, adminUserId) {
  if (!bootstrapSecret || !adminUserId) {
    return;
  }
  const secret = String(bootstrapSecret).trim();
  const keyHash = hashSecret(secret);
  const keyPrefix = secret.slice(0, 10);
  const keyId = 'pak_bootstrap_admin';

  const pool = getPgPool();
  try {
    const existing = await pool.query('SELECT id FROM preauth_keys WHERE key_hash = $1', [keyHash]);
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO preauth_keys
           (id, key_hash, key_prefix, owner_id, allowed_role, is_reusable, used_count, max_uses, expires_at, created_at)
         VALUES ($1, $2, $3, $4, NULL, TRUE, 0, NULL, NULL, NOW())
         ON CONFLICT (key_hash) DO NOTHING`,
        [keyId, keyHash, keyPrefix, adminUserId]
      );
    }
    const fingerprint = crypto.createHash('sha256').update(keyHash).digest('hex').slice(0, 16);
    logger.info(`Bootstrap pre-auth key active (fingerprint: ${fingerprint})`);
  } catch (err) {
    logger.warn(`Failed to seed bootstrap pre-auth key: ${err.message}`);
  }
}

module.exports = {
  hashSecret,
  createPreAuthKey,
  validateAndConsumePreAuthKey,
  listPreAuthKeys,
  revokePreAuthKey,
  ensureBootstrapKey
};
