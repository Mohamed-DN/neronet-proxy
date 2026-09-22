const { v4: uuidv4 } = require('uuid');
const { getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');

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

    await pool.query('DELETE FROM compartments WHERE id = $1 AND organization_id = $2', [id, organizationId]);

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
   * List peering rules between compartments
   */
  static async listPeeringRules(organizationId) {
    const pool = getPgPool();
    const res = await pool.query(
      `SELECT p.*, s.name AS src_name, d.name AS dst_name
       FROM compartment_peerings p
       JOIN compartments s ON p.src_compartment_id = s.id
       JOIN compartments d ON p.dst_compartment_id = d.id
       WHERE p.organization_id = $1
       ORDER BY p.created_at ASC`,
      [organizationId]
    );
    return res.rows;
  }

  /**
   * Create peering rule between compartments
   */
  static async createPeeringRule({ organizationId, srcCompartmentId, dstCompartmentId, policy = 'allow' }, actor) {
    const pool = getPgPool();
    const peerId = `peer-${uuidv4().substring(0, 8)}`;

    const res = await pool.query(
      `INSERT INTO compartment_peerings (id, organization_id, src_compartment_id, dst_compartment_id, policy, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [peerId, organizationId, srcCompartmentId, dstCompartmentId, policy]
    );

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
}

module.exports = CompartmentService;
