const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const { getPgPool } = require('../db/index');
const config = require('../config/env');
const { logAuditEvent } = require('../utils/audit');
const logger = require('../utils/logger');

/*
 * Key hierarchy
 *
 *   SOVEREIGN_SHRED_KEK_SECRET --HKDF--> KEK --AES-256-GCM--> one data key (DEK) per
 *   organisation, stored wrapped in organization_keys --AES-256-GCM--> the
 *   organisation's secrets, sealed in their own columns (sealForOrg).
 *
 * What a shred does: the organisation's wrapped DEK is overwritten, so what was
 * sealed with it -- its OIDC client secret, its users' identity-provider refresh
 * tokens and TOTP seeds -- can no longer be opened from the live database. A backup
 * taken before the shred still holds the wrapped DEK, and it stays openable for as
 * long as the KEK that wrapped it exists. To make such backups unreadable, rotate the
 * KEK after the shred (SOVEREIGN_SHRED_KEK_PREVIOUS = old, SOVEREIGN_SHRED_KEK_SECRET
 * = new, restart: surviving DEKs are re-wrapped) and then destroy the old value.
 *
 * Data outside those columns (node rows, rules, audit events) is not encrypted with
 * the DEK. The shred deletes the organisation's nodes, rules, keys and compartments
 * and suspends its users; backups keep that data until they expire.
 *
 * The KEK used to be SHA-256 of JWT_SECRET, with a literal committed to this
 * repository as the fallback. Data keys wrapped that way are still opened, with
 * JWT_SECRET only, and re-wrapped under the current KEK the first time they are.
 */

const WRAP_PREFIX = 'v2:';
const SEAL_PREFIX = 'enc:v1:';

function deriveKek(secret) {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'neronet/shred-kek/v2', 32)
  );
}

function kekId(kek) {
  return crypto.createHash('sha256').update(kek).digest('hex').slice(0, 16);
}

/** The KEKs this process can use: the current one first, then the one being retired. */
function keks() {
  if (!config.SHRED_KEK_SECRET) {
    // requireSecret returns null in production when the value is missing or
    // published, and startup refuses to continue; never substitute a default here.
    throw new Error('SOVEREIGN_SHRED_KEK_SECRET is not configured');
  }
  const list = [];
  const current = deriveKek(config.SHRED_KEK_SECRET);
  list.push({ id: kekId(current), key: current });
  if (config.SHRED_KEK_PREVIOUS) {
    const previous = deriveKek(config.SHRED_KEK_PREVIOUS);
    list.push({ id: kekId(previous), key: previous });
  }
  return list;
}

function legacyKek() {
  return config.JWT_SECRET ? crypto.createHash('sha256').update(config.JWT_SECRET).digest() : null;
}

function gcmEncrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function gcmDecrypt(key, buf, aad) {
  if (buf.length < 28) throw new Error('Invalid ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

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
      const { dek, current } = CryptoShreddingService.unwrapDEK(row.encrypted_dek, orgId);
      if (!current) {
        // Wrapped with the retiring KEK or the old JWT-derived one: re-wrap now, and
        // only if nobody changed the row in the meantime.
        await pool.query(
          "UPDATE organization_keys SET encrypted_dek = $1 WHERE organization_id = $2 AND encrypted_dek = $3 AND status = 'active'",
          [CryptoShreddingService.wrapDEK(dek, orgId), orgId, row.encrypted_dek]
        );
      }
      return dek;
    }

    // Generate fresh 256-bit DEK
    const rawDEK = crypto.randomBytes(32);
    const wrapped = CryptoShreddingService.wrapDEK(rawDEK, orgId);
    const dekHash = crypto.createHash('sha256').update(rawDEK).digest('hex');

    const inserted = await pool.query(
      `INSERT INTO organization_keys (organization_id, key_epoch, encrypted_dek, dek_hash, status)
       VALUES ($1, 1, $2, $3, 'active')
       ON CONFLICT (organization_id) DO NOTHING
       RETURNING organization_id`,
      [orgId, wrapped, dekHash]
    );
    if (inserted.rows.length === 0) {
      // Another request created it first; use that one, or data sealed by the two
      // would be under different keys.
      return CryptoShreddingService.getOrCreateOrgDEK(orgId);
    }

    return rawDEK;
  }

  /** Wrap a DEK under the current KEK. The organisation id is bound as associated data. */
  static wrapDEK(rawDEK, orgId) {
    const [kek] = keks();
    return `${WRAP_PREFIX}${kek.id}:${gcmEncrypt(kek.key, rawDEK, `dek:${orgId}`).toString('base64')}`;
  }

  /** Returns { dek, current }: current is false when the DEK should be re-wrapped. */
  static unwrapDEK(wrapped, orgId) {
    if (typeof wrapped === 'string' && wrapped.startsWith(WRAP_PREFIX)) {
      const [id, body] = wrapped.slice(WRAP_PREFIX.length).split(':');
      const available = keks();
      const kek = available.find((k) => k.id === id);
      if (!kek) {
        throw new Error(`The data key of ${orgId} is wrapped with a KEK (${id}) that is not configured`);
      }
      return { dek: gcmDecrypt(kek.key, Buffer.from(body, 'base64'), `dek:${orgId}`), current: kek === available[0] };
    }
    const legacy = legacyKek();
    if (!legacy) {
      throw new Error(`The data key of ${orgId} predates SOVEREIGN_SHRED_KEK_SECRET and JWT_SECRET is not set`);
    }
    return { dek: gcmDecrypt(legacy, Buffer.from(String(wrapped), 'base64')), current: false };
  }

  /**
   * Seal a secret that belongs to an organisation with its DEK. A shred of the
   * organisation makes it unreadable. Null and undefined pass through.
   */
  static async sealForOrg(orgId, plaintext) {
    if (plaintext === null || plaintext === undefined) return plaintext;
    const org = orgId || 'org-default';
    const dek = await CryptoShreddingService.getOrCreateOrgDEK(org);
    return SEAL_PREFIX + gcmEncrypt(dek, Buffer.from(String(plaintext), 'utf8'), `secret:${org}`).toString('base64');
  }

  /**
   * Open a value sealed by sealForOrg. A value without the prefix was stored before
   * sealing existed and is returned as it is (sealLegacySecrets converts those).
   * Throws KeyShreddedError when the organisation has been shredded.
   */
  static async openForOrg(orgId, value) {
    if (value === null || value === undefined || !String(value).startsWith(SEAL_PREFIX)) return value;
    const org = orgId || 'org-default';
    const dek = await CryptoShreddingService.getOrCreateOrgDEK(org);
    const buf = Buffer.from(String(value).slice(SEAL_PREFIX.length), 'base64');
    return gcmDecrypt(dek, buf, `secret:${org}`).toString('utf8');
  }

  static isSealed(value) {
    return typeof value === 'string' && value.startsWith(SEAL_PREFIX);
  }

  /**
   * Seal the organisation secrets stored before sealing existed. Idempotent, and
   * safe on several instances at once: a row is rewritten only if it still holds
   * the plaintext that was read.
   */
  static async sealLegacySecrets() {
    const pool = getPgPool();
    let sealed = 0;

    const columns = [
      { table: 'users', key: 'id', org: "COALESCE(organization_id, 'org-default')", column: 'totp_secret' },
      { table: 'users', key: 'id', org: "COALESCE(organization_id, 'org-default')", column: 'totp_pending_secret' },
      { table: 'users', key: 'id', org: "COALESCE(organization_id, 'org-default')", column: 'oidc_refresh_token' },
      { table: 'organization_oidc_configs', key: 'id', org: 'organization_id', column: 'client_secret' }
    ];

    for (const c of columns) {
      const rows = await pool.query(
        `SELECT ${c.key} AS k, ${c.org} AS org, ${c.column} AS v FROM ${c.table}
          WHERE ${c.column} IS NOT NULL AND ${c.column} NOT LIKE '${SEAL_PREFIX}%'`
      );
      for (const row of rows.rows) {
        try {
          const value = await CryptoShreddingService.sealForOrg(row.org, row.v);
          const res = await pool.query(
            `UPDATE ${c.table} SET ${c.column} = $1 WHERE ${c.key} = $2 AND ${c.column} = $3`,
            [value, row.k, row.v]
          );
          sealed += res.rowCount;
        } catch (err) {
          if (!(err instanceof KeyShreddedError)) throw err;
        }
      }
    }

    if (sealed > 0) logger.info(`Sealed ${sealed} stored secret(s) with their organisation's data key.`);
    return sealed;
  }

  /**
   * Re-wrap every active data key under the current KEK. Run at start-up when a
   * previous KEK is configured, so that the previous one can then be removed.
   */
  static async rewrapAllDataKeys() {
    const pool = getPgPool();
    const [current] = keks();
    const rows = await pool.query(
      "SELECT organization_id, encrypted_dek FROM organization_keys WHERE status = 'active'"
    );
    let rewrapped = 0;
    for (const row of rows.rows) {
      if (String(row.encrypted_dek).startsWith(`${WRAP_PREFIX}${current.id}:`)) continue;
      const { dek } = CryptoShreddingService.unwrapDEK(row.encrypted_dek, row.organization_id);
      const res = await pool.query(
        "UPDATE organization_keys SET encrypted_dek = $1 WHERE organization_id = $2 AND encrypted_dek = $3 AND status = 'active'",
        [CryptoShreddingService.wrapDEK(dek, row.organization_id), row.organization_id, row.encrypted_dek]
      );
      rewrapped += res.rowCount;
    }
    if (rewrapped > 0) logger.info(`Re-wrapped ${rewrapped} organisation data key(s) under the current KEK.`);
    return rewrapped;
  }

  /** Seal arbitrary organisation data with its DEK (same as sealForOrg). */
  static async encryptData(orgId, plaintext) {
    return CryptoShreddingService.sealForOrg(orgId, plaintext);
  }

  /** Open data sealed by encryptData. Throws KeyShreddedError after a shred. */
  static async decryptData(orgId, ciphertext) {
    if (!CryptoShreddingService.isSealed(ciphertext)) throw new Error('Invalid ciphertext');
    return CryptoShreddingService.openForOrg(orgId, ciphertext);
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
   *
   * The node keys are revoked first, outside the transaction: a revocation that
   * fails stops the shred before anything irreversible happens.
   */
  static async executeOrgShred(orgId, { initiatorId, approverId }) {
    const pool = getPgPool();
    const RevocationEngine = require('./RevocationEngine');
    const AclEngine = require('./AclEngine');

    const nodeIds = (await pool.query('SELECT id FROM nodes WHERE organization_id = $1', [orgId])).rows.map(
      (r) => r.id
    );
    if (nodeIds.length > 0) {
      await RevocationEngine.revokeNodeKeys(nodeIds, { reason: 'organization_shredded', actorId: approverId });
    }

    const client = await pool.connect();
    let suspended = 0;
    try {
      await client.query('BEGIN');

      // 1. Destroy the data key. The tombstone row also exists for an organisation
      //    that never had a key, so none can be created for it afterwards.
      await client.query(
        `INSERT INTO organization_keys (organization_id, key_epoch, encrypted_dek, dek_hash, status, shredded_at)
         VALUES ($1, 1, 'SHREDDED', 'SHREDDED', 'destroyed', NOW())
         ON CONFLICT (organization_id) DO UPDATE SET
           encrypted_dek = 'SHREDDED', dek_hash = 'SHREDDED', status = 'destroyed', shredded_at = NOW()`,
        [orgId]
      );

      // 2. What is not sealed with the key is deleted: nodes, rules, enrolment keys,
      //    compartments, the identity-provider configuration.
      await client.query('DELETE FROM nodes WHERE organization_id = $1', [orgId]);
      await client.query('DELETE FROM acl_rules WHERE organization_id = $1', [orgId]);
      await client.query('DELETE FROM preauth_keys WHERE organization_id = $1', [orgId]);
      await client.query('DELETE FROM compartments WHERE organization_id = $1', [orgId]);
      await client.query('DELETE FROM organization_oidc_configs WHERE organization_id = $1', [orgId]);

      // 3. Its users can no longer sign in. The platform super-admin is not an
      //    organisation's user and keeps access.
      const users = await client.query(
        `UPDATE users SET status = 'revoked', totp_secret = NULL, totp_pending_secret = NULL,
                          oidc_refresh_token = NULL, updated_at = NOW()
          WHERE organization_id = $1 AND role <> 'super-admin'
          RETURNING id`,
        [orgId]
      );
      suspended = users.rowCount;
      if (suspended > 0) {
        await client.query(
          'UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE user_id = ANY($1) AND revoked = FALSE',
          [users.rows.map((r) => r.id)]
        );
      }

      // 4. Mark the organisation. It used to be switched to the standard profile,
      //    which turned its high-risk modules back on.
      await client.query('UPDATE organizations SET destroyed_at = NOW() WHERE id = $1', [orgId]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await AclEngine.bumpNetmap();

    logAuditEvent({
      eventType: 'ORG_CRYPTO_SHREDDED',
      severity: 'critical',
      actorUserId: approverId,
      targetId: orgId,
      targetType: 'organization',
      message: `Organization ${orgId} crypto-shredded with dual authorization (${initiatorId} + ${approverId})`,
      metadata: {
        initiator: initiatorId,
        approver: approverId,
        nodes_revoked: nodeIds.length,
        users_revoked: suspended
      }
    });

    return {
      shredded_organization_id: orgId,
      key_status: 'destroyed',
      nodes_revoked: nodeIds.length,
      users_revoked: suspended,
      irreversibility:
        'The data key is destroyed: secrets sealed with it cannot be opened from the live database. ' +
        'Backups taken before now stay readable until the key-encryption key is rotated and the old one destroyed.'
    };
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
