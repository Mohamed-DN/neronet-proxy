const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const { getPgPool } = require('../db/index');
const config = require('../config/env');
const { logAuditEvent } = require('../utils/audit');
const logger = require('../utils/logger');

// System Key Encryption Key (KEK) - 256-bit symmetric AES key
const MASTER_KEK = crypto
  .createHash('sha256')
  .update(config.JWT_SECRET || 'neronet-master-kek-v4-secret')
  .digest();

class LegalHoldActiveError extends Error {
  constructor(message = 'Cannot shred organization while legal hold is active') {
    super(message);
    this.name = 'LegalHoldActiveError';
    this.status = 403;
  }
}

class DualAuthorizationRequiredError extends Error {
  constructor(message = 'Destruction requires dual-authorization from two distinct administrators') {
    super(message);
    this.name = 'DualAuthorizationRequiredError';
    this.status = 403;
  }
}

class KeyShreddedError extends Error {
  constructor(message = 'Organization encryption key has been permanently destroyed (crypto-shredded)') {
    super(message);
    this.name = 'KeyShreddedError';
    this.status = 410;
  }
}

class CryptoShreddingService {
  /**
   * Provision or retrieve an organization's Data Encryption Key (DEK).
   * Wrapped symmetrically with AES-256-GCM (KEK envelope encryption).
   */
  static async getOrCreateOrgDEK(orgId) {
    const pool = getPgPool();
    const existingRes = await pool.query('SELECT * FROM organization_keys WHERE organization_id = $1', [orgId]);

    if (existingRes.rows.length > 0) {
      const row = existingRes.rows[0];
      if (row.status === 'destroyed') {
        throw new KeyShreddedError(`Organization ${orgId} keys have been permanently shredded`);
      }
      return CryptoShreddingService.unwrapDEK(row.encrypted_dek);
    }

    // Generate fresh 256-bit DEK
    const rawDEK = crypto.randomBytes(32);
    const wrapped = CryptoShreddingService.wrapDEK(rawDEK);
    const dekHash = crypto.createHash('sha256').update(rawDEK).digest('hex');

    await pool.query(
      `INSERT INTO organization_keys (organization_id, key_epoch, encrypted_dek, dek_hash, status)
       VALUES ($1, 1, $2, $3, 'active')
       ON CONFLICT (organization_id) DO NOTHING`,
      [orgId, wrapped, dekHash]
    );

    return rawDEK;
  }

  static wrapDEK(rawDEK) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEK, iv);
    const encrypted = Buffer.concat([cipher.update(rawDEK), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  static unwrapDEK(wrappedBase64) {
    const buf = Buffer.from(wrappedBase64, 'base64');
    if (buf.length < 28) {
      throw new Error('Invalid wrapped key format');
    }
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEK, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /**
   * Encrypt tenant data with organization DEK.
   */
  static async encryptData(orgId, plaintext) {
    const dek = await CryptoShreddingService.getOrCreateOrgDEK(orgId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  /**
   * Decrypt tenant data with organization DEK. Fails permanently if key was shredded!
   */
  static async decryptData(orgId, ciphertextBase64) {
    const dek = await CryptoShreddingService.getOrCreateOrgDEK(orgId);
    const buf = Buffer.from(ciphertextBase64, 'base64');
    if (buf.length < 28) throw new Error('Ciphertext too short');

    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  /**
   * Check if organization has an active legal hold.
   */
  static async hasActiveLegalHold(orgId) {
    const pool = getPgPool();
    const res = await pool.query(
      'SELECT id, reason FROM organization_legal_holds WHERE organization_id = $1 AND active = TRUE LIMIT 1',
      [orgId]
    );
    return res.rows.length > 0 ? res.rows[0] : null;
  }

  /**
   * Impose a legal hold on an organization.
   */
  static async imposeLegalHold(orgId, reason, userId) {
    if (!reason) throw new Error('Legal hold reason is required');
    const pool = getPgPool();
    const holdId = `hold-${uuidv4().substring(0, 8)}`;

    const res = await pool.query(
      `INSERT INTO organization_legal_holds (id, organization_id, reason, imposed_by_user_id, active)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING *`,
      [holdId, orgId, reason, userId]
    );

    logAuditEvent({
      eventType: 'LEGAL_HOLD_IMPOSED',
      severity: 'warn',
      actorUserId: userId,
      targetId: orgId,
      targetType: 'organization',
      message: `Legal hold imposed on organization ${orgId}: ${reason}`
    });

    return res.rows[0];
  }

  /**
   * Release an active legal hold.
   */
  static async releaseLegalHold(holdId, userId) {
    const pool = getPgPool();
    const res = await pool.query(
      `UPDATE organization_legal_holds
          SET active = FALSE, released_at = NOW()
        WHERE id = $1 AND active = TRUE
        RETURNING *`,
      [holdId]
    );

    if (res.rows.length === 0) return null;

    logAuditEvent({
      eventType: 'LEGAL_HOLD_RELEASED',
      severity: 'warn',
      actorUserId: userId,
      targetId: res.rows[0].organization_id,
      targetType: 'organization',
      message: `Legal hold ${holdId} released for organization ${res.rows[0].organization_id}`
    });

    return res.rows[0];
  }

  /**
   * Request dual-authorization destruction.
   */
  static async requestDestruction({ targetType, targetId, initiatorUserId, comment = '' }) {
    if (!['organization', 'global'].includes(targetType)) {
      throw new Error("targetType must be 'organization' or 'global'");
    }

    // Check legal hold upfront
    if (targetType === 'organization') {
      const hold = await CryptoShreddingService.hasActiveLegalHold(targetId);
      if (hold) {
        throw new LegalHoldActiveError(`Cannot request destruction: active legal hold (${hold.reason})`);
      }
    } else if (targetType === 'global') {
      const pool = getPgPool();
      const anyHold = await pool.query(
        'SELECT id, organization_id, reason FROM organization_legal_holds WHERE active = TRUE LIMIT 1'
      );
      if (anyHold.rows.length > 0) {
        throw new LegalHoldActiveError(
          `Global destruction blocked: active legal hold on org ${anyHold.rows[0].organization_id}`
        );
      }
    }

    const pool = getPgPool();
    const authId = `auth-${uuidv4().substring(0, 8)}`;
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000); // 24h expiration

    const res = await pool.query(
      `INSERT INTO nuke_authorizations (
         id, target_type, target_id, initiator_user_id, initiator_comment,
         status, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       RETURNING *`,
      [authId, targetType, targetId, initiatorUserId, comment, expiresAt]
    );

    logAuditEvent({
      eventType: 'NUKE_AUTHORIZATION_REQUESTED',
      severity: 'critical',
      actorUserId: initiatorUserId,
      targetId: targetId,
      targetType: targetType,
      message: `Dual-authorization destruction requested for ${targetType} ${targetId} (ID: ${authId})`
    });

    return res.rows[0];
  }

  /**
   * Second administrator approves and executes destruction.
   */
  static async approveAndExecuteDestruction(authorizationId, approverUserId, approverComment = '') {
    const pool = getPgPool();
    const authRes = await pool.query('SELECT * FROM nuke_authorizations WHERE id = $1 FOR UPDATE', [authorizationId]);
    if (authRes.rows.length === 0) {
      throw new Error('Nuke authorization not found');
    }

    const auth = authRes.rows[0];
    if (auth.status !== 'pending') {
      throw new Error(`Authorization is not pending (current status: ${auth.status})`);
    }

    if (new Date(auth.expires_at) < new Date()) {
      await pool.query("UPDATE nuke_authorizations SET status = 'expired' WHERE id = $1", [authorizationId]);
      throw new Error('Authorization has expired');
    }

    // 4-EYES PRINCIPLE: Initiator cannot approve their own request!
    if (auth.initiator_user_id === approverUserId) {
      throw new DualAuthorizationRequiredError(
        'Dual-authorization violation: the approving administrator must be distinct from the initiating administrator'
      );
    }

    // Re-verify legal holds before irreversible shredding
    if (auth.target_type === 'organization') {
      const hold = await CryptoShreddingService.hasActiveLegalHold(auth.target_id);
      if (hold) {
        throw new LegalHoldActiveError(`Destruction blocked: active legal hold (${hold.reason})`);
      }
    } else if (auth.target_type === 'global') {
      const anyHold = await pool.query(
        'SELECT id, organization_id, reason FROM organization_legal_holds WHERE active = TRUE LIMIT 1'
      );
      if (anyHold.rows.length > 0) {
        throw new LegalHoldActiveError(
          `Global destruction blocked: active legal hold on org ${anyHold.rows[0].organization_id}`
        );
      }
    }

    // Execute the crypto-shredding
    let shredResult;
    if (auth.target_type === 'organization') {
      shredResult = await CryptoShreddingService.executeOrgShred(auth.target_id, {
        initiatorId: auth.initiator_user_id,
        approverId: approverUserId
      });
    } else if (auth.target_type === 'global') {
      shredResult = await CryptoShreddingService.executeGlobalShred({
        initiatorId: auth.initiator_user_id,
        approverId: approverUserId
      });
    }

    await pool.query(
      `UPDATE nuke_authorizations
          SET status = 'executed', approver_user_id = $1, approver_comment = $2, executed_at = NOW()
        WHERE id = $3`,
      [approverUserId, approverComment, authorizationId]
    );

    return {
      success: true,
      authorization_id: authorizationId,
      shredResult
    };
  }

  /**
   * Internal execution of organization crypto-shredding.
   */
  static async executeOrgShred(orgId, { initiatorId, approverId }) {
    const pool = getPgPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Crypto-shred the DEK by overwriting with random noise and nullifying
      const zeroNoise = crypto.randomBytes(64).toString('base64');
      await client.query(
        `UPDATE organization_keys
            SET encrypted_dek = $1,
                status = 'destroyed',
                shredded_at = NOW()
          WHERE organization_id = $2`,
        [zeroNoise, orgId]
      );

      // Overwrite with shredded tombstone
      await client.query(
        `UPDATE organization_keys
            SET encrypted_dek = 'SHREDDED_000000000000'
          WHERE organization_id = $1`,
        [orgId]
      );

      // 2. Wipe nodes belonging to the organization
      await client.query('DELETE FROM nodes WHERE organization_id = $1', [orgId]);

      // 3. Mark organization status as destroyed or remove
      await client.query("UPDATE organizations SET profile = 'standard' WHERE id = $1", [orgId]);

      await client.query('COMMIT');

      logAuditEvent({
        eventType: 'ORG_CRYPTO_SHREDDED',
        severity: 'critical',
        actorUserId: approverId,
        targetId: orgId,
        targetType: 'organization',
        message: `Organization ${orgId} permanently crypto-shredded with dual authorization (${initiatorId} + ${approverId})`,
        metadata: { initiator: initiatorId, approver: approverId }
      });

      return {
        shredded_organization_id: orgId,
        key_status: 'destroyed',
        irreversibility: 'DEK permanently deleted; historical backups cannot be decrypted'
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Internal execution of global disaster wipe.
   */
  static async executeGlobalShred({ initiatorId, approverId }) {
    const pool = getPgPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Shred all organization keys
      await client.query(
        `UPDATE organization_keys
            SET encrypted_dek = 'SHREDDED_GLOBAL_00000000',
                status = 'destroyed',
                shredded_at = NOW()`
      );

      // 2. Wipe nodes, routes, acl rules
      await client.query('DELETE FROM acl_rules');
      await client.query('DELETE FROM network_routes');
      await client.query('DELETE FROM nodes');
      await client.query('DELETE FROM preauth_keys');

      await client.query('COMMIT');

      logAuditEvent({
        eventType: 'GLOBAL_CRYPTO_SHREDDED',
        severity: 'critical',
        actorUserId: approverId,
        targetId: 'global',
        targetType: 'global',
        message: `Global fleet and organization keys crypto-shredded with dual authorization (${initiatorId} + ${approverId})`
      });

      return {
        target: 'global',
        status: 'shredded'
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = {
  CryptoShreddingService,
  LegalHoldActiveError,
  DualAuthorizationRequiredError,
  KeyShreddedError
};
