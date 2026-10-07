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
const GOVERNANCE_LOCK_ID = 7429149;

async function governanceTransaction(operation) {
  const client = await getPgPool().connect();
  const afterCommit = [];
  let result;
  try {
    await client.query('BEGIN');
    // A single order covers tenant/global requests and absent legal-hold rows.
    // The first owner of this lock decides before a competing hold or rejection.
    await client.query('SELECT pg_advisory_xact_lock($1)', [GOVERNANCE_LOCK_ID]);
    result = await operation(client, afterCommit);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Notification failures cannot turn an already committed destruction into a
  // failed/pending request. Delivery is best effort, not exactly once.
  for (const notify of afterCommit) {
    try {
      await notify();
    } catch (err) {
      logger.error(`Governance committed; post-commit notification failed: ${err.message}`);
    }
  }
  return result;
}

async function lockGovernanceTarget(client, targetType, targetId, { nodes = false, allowDestroyed = false } = {}) {
  if (targetType === 'organization') {
    const org = await client.query('SELECT id, destroyed_at FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [
      targetId
    ]);
    if (!org.rowCount || (org.rows[0].destroyed_at && !allowDestroyed)) {
      throw new GovernanceAccessError(404, 'Governance target not found');
    }
  } else if (targetType === 'global') {
    await client.query('SELECT id FROM organizations ORDER BY id FOR NO KEY UPDATE');
  }
  if (nodes) {
    // Match NukeEngine's nodes-before-users order for account destruction.
    await client.query('SELECT id FROM nodes WHERE ($1::boolean OR organization_id = $2) ORDER BY id FOR UPDATE', [
      targetType === 'global',
      targetId
    ]);
  }
}

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

class GovernanceAccessError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GovernanceAccessError';
    this.status = status;
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
  static async hasActiveLegalHold(orgId, client = getPgPool()) {
    const res = await client.query(
      'SELECT id, reason FROM organization_legal_holds WHERE organization_id = $1 AND active = TRUE LIMIT 1',
      [orgId]
    );
    return res.rows.length > 0 ? res.rows[0] : null;
  }

  static async getGovernanceActor(userId, client = null) {
    const db = client || getPgPool();
    const res = await db.query(
      `SELECT id, role, status, COALESCE(organization_id, 'org-default') AS organization_id
         FROM users WHERE id = $1 ${client ? 'FOR NO KEY UPDATE' : ''}`,
      [userId]
    );
    const user = res.rows[0];
    if (!user || user.status !== 'active') {
      throw new GovernanceAccessError(403, 'Active governance account required');
    }
    const membership = await db.query(
      `SELECT role FROM memberships WHERE user_id = $1 AND organization_id = $2 ${client ? 'FOR UPDATE' : ''}`,
      [userId, user.organization_id]
    );
    return {
      id: user.id,
      organization_id: user.organization_id,
      platform: user.role === 'super-admin',
      // Migration 033 preserves legacy owner/admin authority once. Falling back
      // to users.role here would revive privileges after membership removal.
      role: membership.rows[0]?.role
    };
  }

  static async requireGovernanceRole(userId, roles = ['owner', 'admin']) {
    const actor = await CryptoShreddingService.getGovernanceActor(userId);
    if (!actor.platform && !roles.includes(actor.role)) {
      throw new GovernanceAccessError(403, 'Insufficient governance role');
    }
    return actor;
  }

  static async authorizeGovernanceTarget(userId, targetType, targetId, roles = ['owner', 'admin'], client = null) {
    const actor = await CryptoShreddingService.getGovernanceActor(userId, client);
    if (targetType === 'global') {
      if (!actor.platform) {
        throw new GovernanceAccessError(403, 'Platform super-admin role required');
      }
    } else if (targetType === 'organization') {
      if (!actor.platform && actor.organization_id !== targetId) {
        throw new GovernanceAccessError(404, 'Governance target not found');
      }
      const org = await (client || getPgPool()).query('SELECT id FROM organizations WHERE id = $1', [targetId]);
      if (org.rowCount === 0) {
        throw new GovernanceAccessError(404, 'Governance target not found');
      }
      if (!actor.platform && !roles.includes(actor.role)) {
        throw new GovernanceAccessError(403, 'Insufficient governance role');
      }
    } else {
      throw new GovernanceAccessError(400, "targetType must be 'organization' or 'global'");
    }
    return actor;
  }

  static async listLegalHolds(userId) {
    const actor = await CryptoShreddingService.getGovernanceActor(userId);
    return (
      await getPgPool().query(
        'SELECT * FROM organization_legal_holds WHERE ($1::boolean OR organization_id = $2) ORDER BY created_at DESC',
        [actor.platform, actor.organization_id]
      )
    ).rows;
  }

  static async listDestructionRequests(userId, { pendingOnly = false } = {}) {
    const actor = await CryptoShreddingService.getGovernanceActor(userId);
    return (
      await getPgPool().query(
        `SELECT * FROM nuke_authorizations
          WHERE ($1::boolean OR (target_type = 'organization' AND target_id = $2))
            AND (NOT $3::boolean OR (status = 'pending' AND expires_at > NOW()))
          ORDER BY created_at DESC`,
        [actor.platform, actor.organization_id, pendingOnly]
      )
    ).rows;
  }

  static async rejectDestruction(authorizationId, userId, comment = 'Rejected by administrator') {
    return governanceTransaction(async (client) => {
      const existing = await client.query('SELECT * FROM nuke_authorizations WHERE id = $1 FOR UPDATE', [
        authorizationId
      ]);
      if (!existing.rowCount) return null;
      const auth = existing.rows[0];
      // Authorization is still checked for a terminal request: a tenant cannot
      // use its id to discover whether another tenant executed it.
      await lockGovernanceTarget(client, auth.target_type, auth.target_id, { allowDestroyed: true });
      await CryptoShreddingService.authorizeGovernanceTarget(
        userId,
        auth.target_type,
        auth.target_id,
        ['owner', 'admin'],
        client
      );
      const res = await client.query(
        `UPDATE nuke_authorizations SET status = 'rejected', approver_user_id = $1,
              approver_comment = $2, executed_at = NOW()
          WHERE id = $3 AND status = 'pending' RETURNING *`,
        [userId, comment, authorizationId]
      );
      return res.rows[0] || null;
    });
  }

  /** Impose a legal hold in the same ordering as destruction. */
  static async imposeLegalHold(orgId, reason, userId) {
    if (!reason) throw new Error('Legal hold reason is required');
    return governanceTransaction(async (client, afterCommit) => {
      await lockGovernanceTarget(client, 'organization', orgId);
      await CryptoShreddingService.authorizeGovernanceTarget(userId, 'organization', orgId, ['owner', 'admin'], client);
      const res = await client.query(
        `INSERT INTO organization_legal_holds (id, organization_id, reason, imposed_by_user_id, active)
         VALUES ($1, $2, $3, $4, TRUE) RETURNING *`,
        [`hold-${uuidv4().substring(0, 8)}`, orgId, reason, userId]
      );
      afterCommit.push(() =>
        logAuditEvent({
          eventType: 'LEGAL_HOLD_IMPOSED',
          severity: 'warn',
          actorUserId: userId,
          targetId: orgId,
          targetType: 'organization',
          message: `Legal hold imposed on organization ${orgId}: ${reason}`
        })
      );
      return res.rows[0];
    });
  }

  /** Release an active legal hold. */
  static async releaseLegalHold(holdId, userId) {
    return governanceTransaction(async (client, afterCommit) => {
      const existing = await client.query('SELECT organization_id FROM organization_legal_holds WHERE id = $1', [
        holdId
      ]);
      if (!existing.rowCount) return null;
      const orgId = existing.rows[0].organization_id;
      await lockGovernanceTarget(client, 'organization', orgId);
      await CryptoShreddingService.authorizeGovernanceTarget(userId, 'organization', orgId, ['owner'], client);
      const res = await client.query(
        `UPDATE organization_legal_holds SET active = FALSE, released_at = NOW()
          WHERE id = $1 AND active = TRUE RETURNING *`,
        [holdId]
      );
      if (!res.rowCount) return null;
      afterCommit.push(() =>
        logAuditEvent({
          eventType: 'LEGAL_HOLD_RELEASED',
          severity: 'warn',
          actorUserId: userId,
          targetId: orgId,
          targetType: 'organization',
          message: `Legal hold ${holdId} released for organization ${orgId}`
        })
      );
      return res.rows[0];
    });
  }

  static async checkDestructionHolds(targetType, targetId, client) {
    if (targetType === 'organization') {
      const hold = await CryptoShreddingService.hasActiveLegalHold(targetId, client);
      if (hold) throw new LegalHoldActiveError(`Destruction blocked: active legal hold (${hold.reason})`);
    } else if (targetType === 'global') {
      const holds = await client.query(
        'SELECT organization_id FROM organization_legal_holds WHERE active = TRUE LIMIT 1'
      );
      if (holds.rowCount) {
        throw new LegalHoldActiveError(
          `Global destruction blocked: active legal hold on org ${holds.rows[0].organization_id}`
        );
      }
    }
  }

  /** Request dual-authorization destruction. */
  static async requestDestruction({ targetType, targetId, initiatorUserId, comment = '' }) {
    return governanceTransaction(async (client, afterCommit) => {
      await lockGovernanceTarget(client, targetType, targetId);
      await CryptoShreddingService.authorizeGovernanceTarget(
        initiatorUserId,
        targetType,
        targetId,
        ['owner', 'admin'],
        client
      );
      await CryptoShreddingService.checkDestructionHolds(targetType, targetId, client);
      const authId = `auth-${uuidv4().substring(0, 8)}`;
      const res = await client.query(
        `INSERT INTO nuke_authorizations (
           id, target_type, target_id, initiator_user_id, initiator_comment, status, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING *`,
        [authId, targetType, targetId, initiatorUserId, comment, new Date(Date.now() + 24 * 3600 * 1000)]
      );
      afterCommit.push(() =>
        logAuditEvent({
          eventType: 'NUKE_AUTHORIZATION_REQUESTED',
          severity: 'critical',
          actorUserId: initiatorUserId,
          targetId,
          targetType,
          message: `Dual-authorization destruction requested for ${targetType} ${targetId} (ID: ${authId})`
        })
      );
      return res.rows[0];
    });
  }

  /** Second administrator approves and executes destruction. */
  static async approveAndExecuteDestruction(authorizationId, approverUserId, approverComment = '') {
    const result = await governanceTransaction(async (client, afterCommit) => {
      const authRes = await client.query('SELECT * FROM nuke_authorizations WHERE id = $1 FOR UPDATE', [
        authorizationId
      ]);
      if (!authRes.rowCount) throw new GovernanceAccessError(404, 'Governance target not found');
      const auth = authRes.rows[0];
      await lockGovernanceTarget(client, auth.target_type, auth.target_id, { nodes: true, allowDestroyed: true });
      // Lock both current accounts in stable order, before their memberships.
      await client.query('SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR NO KEY UPDATE', [
        [approverUserId, auth.initiator_user_id]
      ]);
      await CryptoShreddingService.authorizeGovernanceTarget(
        approverUserId,
        auth.target_type,
        auth.target_id,
        ['owner', 'admin'],
        client
      );
      try {
        await CryptoShreddingService.authorizeGovernanceTarget(
          auth.initiator_user_id,
          auth.target_type,
          auth.target_id,
          ['owner', 'admin'],
          client
        );
      } catch (err) {
        if (!(err instanceof GovernanceAccessError)) throw err;
        throw new GovernanceAccessError(403, 'Initiator is no longer authorized for this target');
      }
      if (auth.status !== 'pending') throw new Error(`Authorization is not pending (current status: ${auth.status})`);
      if (new Date(auth.expires_at) < new Date()) {
        await client.query("UPDATE nuke_authorizations SET status = 'expired' WHERE id = $1", [authorizationId]);
        return { expired: true };
      }
      if (auth.initiator_user_id === approverUserId) {
        throw new DualAuthorizationRequiredError(
          'Dual-authorization violation: the approving administrator must be distinct from the initiating administrator'
        );
      }
      await lockGovernanceTarget(client, auth.target_type, auth.target_id);
      await CryptoShreddingService.checkDestructionHolds(auth.target_type, auth.target_id, client);
      const context = { initiatorId: auth.initiator_user_id, approverId: approverUserId, client, afterCommit };
      const shredResult =
        auth.target_type === 'organization'
          ? await CryptoShreddingService.executeOrgShred(auth.target_id, context)
          : await CryptoShreddingService.executeGlobalShred(context);
      await client.query(
        `UPDATE nuke_authorizations
            SET status = 'executed', approver_user_id = $1, approver_comment = $2, executed_at = NOW()
          WHERE id = $3`,
        [approverUserId, approverComment, authorizationId]
      );
      return { success: true, authorization_id: authorizationId, shredResult };
    });
    if (result.expired) throw new Error('Authorization has expired');
    return result;
  }

  /** Internal shred; helpers share the approval's transaction and deferred events. */
  static async executeOrgShred(orgId, { initiatorId, approverId, client, afterCommit }) {
    if (!client) {
      return governanceTransaction(async (db, notifications) => {
        await lockGovernanceTarget(db, 'organization', orgId, { nodes: true });
        await CryptoShreddingService.checkDestructionHolds('organization', orgId, db);
        return CryptoShreddingService.executeOrgShred(orgId, {
          initiatorId,
          approverId,
          client: db,
          afterCommit: notifications
        });
      });
    }
    const RevocationEngine = require('./RevocationEngine');
    const AclEngine = require('./AclEngine');
    const nodeIds = (await client.query('SELECT id FROM nodes WHERE organization_id = $1', [orgId])).rows.map(
      (r) => r.id
    );
    await RevocationEngine.revokeNodeKeys(nodeIds, { reason: 'organization_shredded', actorId: approverId, client });
    await client.query(
      `INSERT INTO organization_keys (organization_id, key_epoch, encrypted_dek, dek_hash, status, shredded_at)
       VALUES ($1, 1, 'SHREDDED', 'SHREDDED', 'destroyed', NOW())
       ON CONFLICT (organization_id) DO UPDATE SET
         encrypted_dek = 'SHREDDED', dek_hash = 'SHREDDED', status = 'destroyed', shredded_at = NOW()`,
      [orgId]
    );
    await client.query('DELETE FROM nodes WHERE organization_id = $1', [orgId]);
    await client.query('DELETE FROM acl_rules WHERE organization_id = $1', [orgId]);
    await client.query('DELETE FROM preauth_keys WHERE organization_id = $1', [orgId]);
    await client.query('DELETE FROM compartments WHERE organization_id = $1', [orgId]);
    await client.query('DELETE FROM organization_oidc_configs WHERE organization_id = $1', [orgId]);
    const users = await client.query(
      `UPDATE users SET status = 'revoked', totp_secret = NULL, totp_pending_secret = NULL,
                        oidc_refresh_token = NULL, updated_at = NOW()
        WHERE organization_id = $1 AND role <> 'super-admin' RETURNING id`,
      [orgId]
    );
    if (users.rowCount) {
      await client.query(
        'UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE user_id = ANY($1) AND revoked = FALSE',
        [users.rows.map((r) => r.id)]
      );
    }
    await client.query('UPDATE organizations SET destroyed_at = NOW() WHERE id = $1', [orgId]);
    await client.query("UPDATE mesh_epochs SET epoch = epoch + 1, updated_at = NOW() WHERE name = 'netmap'");
    afterCommit.push(() => AclEngine.bumpNetmap());
    afterCommit.push(() =>
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
          users_revoked: users.rowCount
        }
      })
    );
    return {
      shredded_organization_id: orgId,
      key_status: 'destroyed',
      nodes_revoked: nodeIds.length,
      users_revoked: users.rowCount,
      irreversibility:
        'The data key is destroyed: secrets sealed with it cannot be opened from the live database. ' +
        'Backups taken before now stay readable until the key-encryption key is rotated and the old one destroyed.'
    };
  }

  /** Internal global shred, under the same governance lock as tenant holds. */
  static async executeGlobalShred({ initiatorId, approverId, client, afterCommit }) {
    if (!client) {
      return governanceTransaction(async (db, notifications) => {
        await lockGovernanceTarget(db, 'global', 'global', { nodes: true });
        await CryptoShreddingService.checkDestructionHolds('global', 'global', db);
        return CryptoShreddingService.executeGlobalShred({
          initiatorId,
          approverId,
          client: db,
          afterCommit: notifications
        });
      });
    }
    const RevocationEngine = require('./RevocationEngine');
    const AclEngine = require('./AclEngine');
    const nodeIds = (await client.query('SELECT id FROM nodes')).rows.map((r) => r.id);
    await RevocationEngine.revokeNodeKeys(nodeIds, { reason: 'global_shredded', actorId: approverId, client });
    await client.query(
      `UPDATE organization_keys SET encrypted_dek = 'SHREDDED_GLOBAL_00000000', status = 'destroyed', shredded_at = NOW()`
    );
    await client.query('DELETE FROM acl_rules');
    await client.query('DELETE FROM network_routes');
    await client.query('DELETE FROM nodes');
    await client.query('DELETE FROM preauth_keys');
    await client.query("UPDATE mesh_epochs SET epoch = epoch + 1, updated_at = NOW() WHERE name = 'netmap'");
    afterCommit.push(() => AclEngine.bumpNetmap());
    afterCommit.push(() =>
      logAuditEvent({
        eventType: 'GLOBAL_CRYPTO_SHREDDED',
        severity: 'critical',
        actorUserId: approverId,
        targetId: 'global',
        targetType: 'global',
        message: `Global fleet and organization keys crypto-shredded with dual authorization (${initiatorId} + ${approverId})`
      })
    );
    return { target: 'global', status: 'shredded' };
  }
}

module.exports = {
  CryptoShreddingService,
  LegalHoldActiveError,
  DualAuthorizationRequiredError,
  KeyShreddedError,
  GovernanceAccessError
};
