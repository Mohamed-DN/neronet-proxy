const { v4: uuidv4 } = require('uuid');
const { getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');
const AclEngine = require('./AclEngine');

// A node with no organisation belongs to the default one (see AclEngine).
const DEFAULT_ORG = 'org-default';
// The most nodes one request may move. A fleet larger than this moves in batches.
const MAX_MEMBERS_PER_REQUEST = 1000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Compartments are sub-networks the data plane enforces (ADR 0021): AclEngine only
 * offers a node the peers in its own compartment and in the compartments peered with
 * it. Anything here that changes who is in which compartment, or which compartments
 * are peered, changes compiled policies, so it advances the ACL epoch and the fleet
 * re-fetches within a heartbeat.
 */
class CompartmentService {
  /**
   * Ensure default compartment exists for organization
   */
  static async ensureDefaultCompartment(organizationId) {
    const pool = getPgPool();
    const defaultId = `cmp-${organizationId}`;
    await pool.query(
      `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden, created_at, updated_at)
       VALUES ($1, $2, 'Default Compartment', 'default', '100.64.0.0/24', FALSE, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [defaultId, organizationId]
    );
  }

  /**
   * List compartments for an organization.
   * If accessTier !== 'root', filter out hidden compartments (is_hidden = TRUE).
   */
  static async listCompartments(organizationId, accessTier = 'standard') {
    const pool = getPgPool();
    let query = 'SELECT * FROM compartments WHERE organization_id = $1';
    const params = [organizationId];

    if (accessTier !== 'root') {
      query += ' AND is_hidden = FALSE';
    }

    query += ' ORDER BY created_at ASC, name ASC';
    let res = await pool.query(query, params);

    if (res.rows.length === 0) {
      await CompartmentService.ensureDefaultCompartment(organizationId);
      res = await pool.query(query, params);
    }

    return res.rows;
  }

  /**
   * Get single compartment by ID.
   * Returns null if not found or if is_hidden = TRUE and accessTier !== 'root' (acts like 404).
   */
  static async getCompartment(id, organizationId, accessTier = 'standard') {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM compartments WHERE id = $1 AND organization_id = $2', [
      id,
      organizationId
    ]);

    if (res.rows.length === 0) return null;
    const compartment = res.rows[0];

    if (compartment.is_hidden && accessTier !== 'root') {
      return null;
    }

    return compartment;
  }

  /**
   * Create a new compartment within an organization.
   */
  static async createCompartment(
    { organizationId, name, slug, subnetCidr, isHidden = false },
    accessTier = 'standard',
    actor
  ) {
    if (!organizationId || !name) {
      throw new Error('Missing required compartment fields');
    }

    // Only root access tier can create hidden compartments
    if (isHidden && accessTier !== 'root') {
      throw new Error('Forbidden: root access tier required to create hidden compartments');
    }

    const pool = getPgPool();
    const compSlug = slug || name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const compId = `cmp-${uuidv4().substring(0, 8)}`;
    const cidr = subnetCidr || '100.64.0.0/24';

    const res = await pool.query(
      `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING *`,
      [compId, organizationId, name, compSlug, cidr, Boolean(isHidden)]
    );

    logAuditEvent({
      eventType: 'COMPARTMENT_CREATE',
      severity: isHidden ? 'warn' : 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: compId,
      targetType: 'compartment',
      message: `Compartment ${name} created in org ${organizationId}${isHidden ? ' (GHOST/HIDDEN)' : ''}`
    });

    return res.rows[0];
  }

  /**
   * Update compartment.
   */
  static async updateCompartment(id, organizationId, updates, accessTier = 'standard', actor) {
    const pool = getPgPool();
    const existing = await CompartmentService.getCompartment(id, organizationId, accessTier);
    if (!existing) return null;

    const { name, subnetCidr, isHidden } = updates;
    const fields = [];
    const args = [];
    let i = 1;

    if (name) {
      fields.push(`name = $${i++}`);
      args.push(name);
    }
    if (subnetCidr) {
      fields.push(`subnet_cidr = $${i++}`);
      args.push(subnetCidr);
    }
    if (isHidden !== undefined) {
      if (accessTier !== 'root') {
        throw new Error('Forbidden: root access tier required to toggle hidden status');
      }
      fields.push(`is_hidden = $${i++}`);
      args.push(Boolean(isHidden));
    }

    if (fields.length === 0) return existing;

    fields.push(`updated_at = NOW()`);
    args.push(id, organizationId);

    const res = await pool.query(
      `UPDATE compartments SET ${fields.join(', ')} WHERE id = $${i++} AND organization_id = $${i++} RETURNING *`,
      args
    );

    logAuditEvent({
      eventType: 'COMPARTMENT_UPDATE',
      severity: 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: id,
      targetType: 'compartment',
      message: `Compartment ${id} updated`
    });

    return res.rows[0];
  }

  /**
   * Delete compartment. Invariant: cannot delete the default compartment.
   */
  static async deleteCompartment(id, organizationId, accessTier = 'standard', actor) {
    const pool = getPgPool();
    const existing = await CompartmentService.getCompartment(id, organizationId, accessTier);
    if (!existing) return false;

    if (existing.slug === 'default') {
      throw new Error('Cannot delete the default compartment of an organization');
    }

    // Its nodes fall back to the default compartment (ON DELETE SET NULL), and its
    // peerings go with it (ON DELETE CASCADE): both change who reaches whom.
    await pool.query('DELETE FROM compartments WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    await AclEngine.bumpEpoch('acl');

    logAuditEvent({
      eventType: 'COMPARTMENT_DELETE',
      severity: 'warn',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: id,
      targetType: 'compartment',
      message: `Compartment ${id} deleted`
    });

    return true;
  }

  /**
   * List peering rules between compartments.
   *
   * Below the root tier a peering that touches a hidden compartment is left out: its
   * row carries the hidden compartment's id and name, which is exactly what the
   * compartment list already withholds.
   */
  static async listPeeringRules(organizationId, accessTier = 'standard') {
    const pool = getPgPool();
    const res = await pool.query(
      `SELECT p.*, s.name AS src_name, d.name AS dst_name
       FROM compartment_peerings p
       JOIN compartments s ON p.src_compartment_id = s.id
       JOIN compartments d ON p.dst_compartment_id = d.id
       WHERE p.organization_id = $1
         AND ($2 = 'root' OR (s.is_hidden = FALSE AND d.is_hidden = FALSE))
       ORDER BY p.created_at ASC`,
      [organizationId, accessTier]
    );
    return res.rows;
  }

  /**
   * Create or replace the peering between two compartments.
   *
   * A peering connects its two compartments both ways, so there is one row per pair:
   * an existing row in either direction is replaced. Both compartments must belong to
   * the caller's organisation and be visible at the caller's access tier -- otherwise
   * an id from another tenant, or a hidden compartment's id, would be accepted and
   * now that peerings are enforced, acted on.
   */
  static async createPeeringRule(
    { organizationId, srcCompartmentId, dstCompartmentId, policy = 'allow' },
    actor,
    accessTier = 'standard'
  ) {
    if (!['allow', 'deny'].includes(policy)) {
      throw httpError(400, "policy must be 'allow' or 'deny'");
    }
    if (srcCompartmentId === dstCompartmentId) {
      throw httpError(400, 'A compartment cannot be peered with itself');
    }
    const src = await CompartmentService.getCompartment(srcCompartmentId, organizationId, accessTier);
    const dst = await CompartmentService.getCompartment(dstCompartmentId, organizationId, accessTier);
    if (!src || !dst) {
      throw httpError(404, 'Compartment not found');
    }

    const pool = getPgPool();
    const peerId = `peer-${uuidv4().substring(0, 8)}`;

    await pool.query(
      `DELETE FROM compartment_peerings
        WHERE organization_id = $1
          AND ((src_compartment_id = $2 AND dst_compartment_id = $3) OR (src_compartment_id = $3 AND dst_compartment_id = $2))`,
      [organizationId, srcCompartmentId, dstCompartmentId]
    );
    const res = await pool.query(
      `INSERT INTO compartment_peerings (id, organization_id, src_compartment_id, dst_compartment_id, policy, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [peerId, organizationId, srcCompartmentId, dstCompartmentId, policy]
    );
    await AclEngine.bumpEpoch('acl');

    logAuditEvent({
      eventType: 'COMPARTMENT_PEER_CREATE',
      severity: 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: peerId,
      targetType: 'compartment_peering',
      message: `Peering ${policy} created between ${srcCompartmentId} and ${dstCompartmentId}`
    });

    return res.rows[0];
  }

  /** Remove a peering. Returns false when the organisation has no such peering. */
  static async deletePeeringRule(id, organizationId, actor) {
    const pool = getPgPool();
    const res = await pool.query(
      'DELETE FROM compartment_peerings WHERE id = $1 AND organization_id = $2 RETURNING src_compartment_id, dst_compartment_id',
      [id, organizationId]
    );
    if (res.rows.length === 0) return false;
    await AclEngine.bumpEpoch('acl');

    logAuditEvent({
      eventType: 'COMPARTMENT_PEER_DELETE',
      severity: 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: id,
      targetType: 'compartment_peering',
      message: `Peering between ${res.rows[0].src_compartment_id} and ${res.rows[0].dst_compartment_id} removed`
    });

    return true;
  }

  /**
   * Move nodes into a compartment.
   *
   * Only nodes of the organisation move; ids from elsewhere are ignored rather than
   * reported, so the answer does not confirm another tenant's node ids. Below the root
   * tier, nodes in a hidden compartment are left where they are, for the same reason
   * the compartment itself reads as absent there. Returns the ids that moved, or null
   * when the compartment is not found.
   */
  static async setMembers(compartmentId, organizationId, nodeIds, accessTier = 'standard', actor) {
    if (!Array.isArray(nodeIds) || nodeIds.length === 0 || nodeIds.some((id) => typeof id !== 'string' || !id)) {
      throw httpError(400, 'node_ids must be a non-empty array of node ids');
    }
    if (nodeIds.length > MAX_MEMBERS_PER_REQUEST) {
      throw httpError(400, `At most ${MAX_MEMBERS_PER_REQUEST} nodes per request`);
    }

    const target = await CompartmentService.getCompartment(compartmentId, organizationId, accessTier);
    if (!target) return null;

    const pool = getPgPool();
    const res = await pool.query(
      `UPDATE nodes n SET compartment_id = $1
        WHERE n.id = ANY($2::text[])
          AND COALESCE(n.organization_id, '${DEFAULT_ORG}') = $3
          AND ($4 = 'root' OR NOT EXISTS (SELECT 1 FROM compartments c WHERE c.id = n.compartment_id AND c.is_hidden = TRUE))
        RETURNING n.id`,
      [compartmentId, [...new Set(nodeIds)], organizationId, accessTier]
    );
    const moved = res.rows.map((r) => r.id).sort();

    if (moved.length > 0) {
      await AclEngine.bumpEpoch('acl');
      logAuditEvent({
        eventType: 'COMPARTMENT_MEMBERS_SET',
        severity: target.is_hidden ? 'warn' : 'info',
        actorUserId: actor?.id,
        actorUsername: actor?.username,
        targetId: compartmentId,
        targetType: 'compartment',
        message: `${moved.length} node(s) moved into compartment ${compartmentId}`
      });
    }

    return moved;
  }
}

module.exports = CompartmentService;
