/**
 * Key revocation, delivered to the data plane.
 *
 * Revoking a peering agreement used to set a database row to 'revoked' and broadcast
 * an event to the console. Nothing reached a node: an established tunnel survived it
 * and the withdrawn device stayed reachable, which is the difference between a
 * revocation and a note that one was intended.
 *
 * Revocations go to every node for a retention window rather than being tracked per
 * node. Applying one twice is harmless, so a stateless window is idempotent and
 * survives a node being offline — where a per-node cursor would have to be stored,
 * replicated, and reconciled after a control plane failover. Past the window a node
 * has re-synced its ACL policy, and a revoked peer is no longer in it.
 */

const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const { normalisePublicKeyHex } = require('../utils/crypto');
const { bumpEpoch } = require('./AclEngine');
const logger = require('../utils/logger');

// Long enough to cover a node that was off overnight, short enough that the list
// delivered on every heartbeat stays small.
const RETENTION_HOURS = Number(process.env.SOVEREIGN_REVOCATION_RETENTION_HOURS || 24);

async function query(pgSql, pgParams, sqliteSql, sqliteParams) {
  if (isPostgres()) {
    return (await getPgPool().query(pgSql, pgParams)).rows;
  }

  const db = getDatabase();
  const statement = db.prepare(sqliteSql);
  if (/^\s*select/i.test(sqliteSql)) return statement.all(...sqliteParams);
  statement.run(...sqliteParams);
  return [];
}

/**
 * Revoke a node's key.
 *
 * Bumps the ACL epoch as well: a revoked peer must disappear from every other node's
 * compiled policy, and that only happens if they re-sync.
 */
async function revokeNodeKeys(nodeIds, { reason = 'manual', actorId = null } = {}) {
  const ids = (Array.isArray(nodeIds) ? nodeIds : [nodeIds]).filter(Boolean);
  if (ids.length === 0) return [];

  const placeholdersPg = ids.map((_, i) => `$${i + 1}`).join(', ');
  const placeholdersLite = ids.map(() => '?').join(', ');

  const rows = await query(
    `SELECT id, public_key FROM nodes WHERE id IN (${placeholdersPg})`,
    ids,
    `SELECT id, public_key FROM nodes WHERE id IN (${placeholdersLite})`,
    ids
  );

  const expiresAt = new Date(Date.now() + RETENTION_HOURS * 3600_000).toISOString();
  const revoked = [];

  for (const row of rows) {
    const keyHex = normalisePublicKeyHex(row.public_key);
    if (!keyHex) {
      // A node with an unusable key cannot be addressed by a revocation either.
      logger.warn(`Cannot revoke ${row.id}: its stored public key is not a usable Curve25519 key.`);
      continue;
    }

    await query(
      `INSERT INTO revoked_keys (public_key_hex, node_id, reason, revoked_by, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (public_key_hex) DO UPDATE SET
         reason = EXCLUDED.reason,
         revoked_by = EXCLUDED.revoked_by,
         revoked_at = NOW(),
         expires_at = EXCLUDED.expires_at`,
      [keyHex, row.id, reason, actorId, expiresAt],
      `INSERT INTO revoked_keys (public_key_hex, node_id, reason, revoked_by, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (public_key_hex) DO UPDATE SET
         reason = excluded.reason,
         revoked_by = excluded.revoked_by,
         revoked_at = CURRENT_TIMESTAMP,
         expires_at = excluded.expires_at`,
      [keyHex, row.id, reason, actorId, expiresAt]
    );

    revoked.push(keyHex);
  }

  if (revoked.length > 0) {
    // Without this the peer stays in every other node's compiled policy until
    // something else happens to change it.
    await bumpEpoch('acl');
    logger.info(`Revoked ${revoked.length} key(s), reason: ${reason}.`);
  }

  return revoked;
}

/** Revoke every node belonging to a user. Used when a user is destroyed. */
async function revokeUserNodes(userId, { reason = 'user_destroyed', actorId = null } = {}) {
  const rows = await query(
    'SELECT id FROM nodes WHERE user_id = $1',
    [userId],
    'SELECT id FROM nodes WHERE user_id = ?',
    [userId]
  );

  return revokeNodeKeys(
    rows.map((r) => r.id),
    { reason, actorId }
  );
}

/** Keys a node must stop talking to. */
async function activeRevocations() {
  const rows = await query(
    'SELECT public_key_hex FROM revoked_keys WHERE expires_at > NOW() ORDER BY revoked_at DESC',
    [],
    "SELECT public_key_hex FROM revoked_keys WHERE expires_at > datetime('now') ORDER BY revoked_at DESC",
    []
  );

  return rows.map((r) => r.public_key_hex);
}

/** Drop entries past the retention window so the heartbeat payload stays bounded. */
async function purgeExpired() {
  await query(
    'DELETE FROM revoked_keys WHERE expires_at <= NOW()',
    [],
    "DELETE FROM revoked_keys WHERE expires_at <= datetime('now')",
    []
  );
}

module.exports = {
  RETENTION_HOURS,
  revokeNodeKeys,
  revokeUserNodes,
  activeRevocations,
  purgeExpired
};
