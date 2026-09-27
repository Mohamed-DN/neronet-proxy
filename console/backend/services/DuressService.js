/**
 * Duress passwords: what they may destroy.
 *
 * An account holder can register passwords that destroy data when used to sign in.
 * The holder picks those passwords, so whatever they destroy has to be bounded by
 * what the same holder could delete through the ordinary API:
 *
 *   - nuclear: the holder's own account and devices;
 *   - stealth: the hidden compartments of the holder's own organisation, and only
 *     for an organisation owner or admin, the roles allowed to delete a compartment.
 *
 * Nothing crosses an organisation boundary. Both are honoured only where the
 * organisation has the deniability module enabled; elsewhere a duress password is
 * treated as a wrong password.
 *
 * Keys are revoked before any row is deleted, as the node delete endpoint does. Once
 * the rows are gone the keys cannot be looked up, and peers would keep tunnels open
 * to devices that no longer exist. If revocation fails nothing is deleted.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPgPool } = require('../db/index');
const RevocationEngine = require('./RevocationEngine');
const { bumpNetmap } = require('./AclEngine');
const ModuleLoader = require('./ModuleLoader');
const { logAuditEvent } = require('../utils/audit');
const logger = require('../utils/logger');

const DEFAULT_ORG = 'org-default';

// The roles DELETE /api/compartments/:id accepts.
const COMPARTMENT_DELETE_ROLES = new Set(['owner', 'admin']);

function orgOf(user) {
  return user.organization_id || DEFAULT_ORG;
}

/** Whether the user's organisation allows duress passwords at all. */
async function isEnabledFor(user) {
  return ModuleLoader.isModuleEnabledForOrg(orgOf(user), 'deniability');
}

/** The user's role in their organisation, resolved the way middleware/rbac does. */
async function orgRoleOf(user) {
  const res = await getPgPool().query('SELECT role FROM memberships WHERE user_id = $1 AND organization_id = $2', [
    user.id,
    orgOf(user)
  ]);
  if (res.rows.length > 0) return res.rows[0].role;
  return user.role === 'super-admin' ? 'owner' : 'member';
}

/**
 * Nuclear: destroy the holder's own account and every device it owns.
 *
 * If the keys cannot be revoked the account is locked instead of deleted: sessions
 * revoked, every password replaced, status set to revoked. The rows stay so that the
 * keys can still be revoked later.
 */
async function wipeOwnAccount(user, { ipAddress } = {}) {
  const pool = getPgPool();

  let revokedKeys = null;
  try {
    revokedKeys = await RevocationEngine.revokeUserNodes(user.id, { reason: 'duress_wipe', actorId: user.id });
  } catch (err) {
    logger.error(`Duress wipe for ${user.id}: key revocation failed, locking the account instead: ${err.message}`);
  }

  if (revokedKeys === null) {
    const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    await pool.query(
      `UPDATE users
          SET status = 'revoked', password_hash = $1, password_hash_root = NULL,
              password_hash_stealth_wipe = NULL, password_hash_nuclear_wipe = NULL, updated_at = NOW()
        WHERE id = $2`,
      [unusable, user.id]
    );
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE user_id = $1', [user.id]);
  } else {
    // Devices, sessions, memberships and pre-auth keys go with the account (ON DELETE CASCADE).
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  }

  await bumpNetmap();

  logAuditEvent({
    eventType: revokedKeys === null ? 'DURESS_NUCLEAR_LOCK' : 'DURESS_NUCLEAR_WIPE',
    severity: 'critical',
    actorUserId: user.id,
    actorUsername: user.username,
    targetId: user.id,
    targetType: 'user',
    message:
      revokedKeys === null
        ? `Duress password used by ${user.username}; key revocation failed, account locked`
        : `Duress password used by ${user.username}; account and ${revokedKeys.length} device key(s) destroyed`,
    ipAddress
  });

  return { deleted: revokedKeys !== null, revokedKeys: revokedKeys || [] };
}

/**
 * Stealth: destroy the hidden compartments of the holder's organisation, with the
 * devices inside them. A holder who may not delete compartments destroys nothing.
 */
async function wipeHiddenCompartments(user, { ipAddress, via = 'login' } = {}) {
  const orgId = orgOf(user);
  const role = await orgRoleOf(user);

  if (!COMPARTMENT_DELETE_ROLES.has(role)) {
    logAuditEvent({
      eventType: 'DURESS_STEALTH_WIPE_REFUSED',
      severity: 'critical',
      actorUserId: user.id,
      actorUsername: user.username,
      targetId: orgId,
      targetType: 'organization',
      message: `Duress password used by ${user.username} (${via}); role ${role} may not delete compartments, nothing wiped`,
      ipAddress
    });
    return { compartments: 0, nodes: 0 };
  }

  const pool = getPgPool();
  const nodeRes = await pool.query(
    `SELECT n.id FROM nodes n
       JOIN compartments c ON c.id = n.compartment_id
      WHERE c.organization_id = $1 AND c.is_hidden = TRUE`,
    [orgId]
  );
  const nodeIds = nodeRes.rows.map((r) => r.id);

  // Throws before anything is deleted if the keys cannot be revoked.
  await RevocationEngine.revokeNodeKeys(nodeIds, { reason: 'duress_wipe', actorId: user.id });

  if (nodeIds.length > 0) {
    await pool.query('DELETE FROM nodes WHERE id = ANY($1::varchar[])', [nodeIds]);
  }
  const compRes = await pool.query('DELETE FROM compartments WHERE organization_id = $1 AND is_hidden = TRUE', [orgId]);

  await bumpNetmap();

  logAuditEvent({
    eventType: 'DURESS_STEALTH_WIPE',
    severity: 'critical',
    actorUserId: user.id,
    actorUsername: user.username,
    targetId: orgId,
    targetType: 'organization',
    message: `Duress password used by ${user.username} (${via}); ${compRes.rowCount} hidden compartment(s) and ${nodeIds.length} device(s) destroyed`,
    ipAddress
  });

  return { compartments: compRes.rowCount, nodes: nodeIds.length };
}

module.exports = {
  isEnabledFor,
  wipeOwnAccount,
  wipeHiddenCompartments
};
