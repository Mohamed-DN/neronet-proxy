const { v4: uuidv4 } = require('uuid');
const { getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');

class OrgService {
  /**
   * List all organizations (super-admin view or member filtered)
   */
  static async listOrganizations(userId, role) {
    const pool = getPgPool();
    if (role === 'super-admin') {
      const res = await pool.query('SELECT * FROM organizations ORDER BY created_at ASC');
      return res.rows;
    }

    const res = await pool.query(
      `SELECT o.*, m.role AS member_role
       FROM organizations o
       JOIN memberships m ON o.id = m.organization_id
       WHERE m.user_id = $1
       ORDER BY o.created_at ASC`,
      [userId]
    );
    return res.rows;
  }

  /**
   * Get organization by ID
   */
  static async getOrganization(orgId) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM organizations WHERE id = $1', [orgId]);
    return res.rows[0] || null;
  }

  /**
   * Create a new organization
   */
  static async createOrganization(
    { name, slug, default_policy = 'deny', max_netmap_staleness_seconds = 300, profile = 'standard' },
    creator
  ) {
    if (!name) {
      throw new Error('Organization name is required');
    }
    if (!['open', 'deny'].includes(default_policy)) {
      throw new Error('Invalid default_policy: must be open or deny');
    }
    if (!['standard', 'regulated'].includes(profile)) {
      throw new Error('Invalid profile: must be standard or regulated');
    }

    const pool = getPgPool();
    const orgId = `org-${uuidv4().substring(0, 8)}`;
    const baseSlug = (slug || name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    // Check slug collision
    let finalSlug = baseSlug;
    let counter = 1;
    while (true) {
      const slugCheck = await pool.query('SELECT id FROM organizations WHERE slug = $1', [finalSlug]);
      if (slugCheck.rows.length === 0) break;
      finalSlug = `${baseSlug}-${counter++}`;
    }

    const res = await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy, max_netmap_staleness_seconds, profile)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [orgId, name, finalSlug, default_policy, max_netmap_staleness_seconds, profile]
    );

    const org = res.rows[0];

    // If a creator user is specified, add them as the initial owner
    if (creator && creator.id) {
      const memId = `mem-${uuidv4().substring(0, 8)}`;
      await pool.query(
        `INSERT INTO memberships (id, user_id, organization_id, role)
         VALUES ($1, $2, $3, 'owner')
         ON CONFLICT (user_id, organization_id) DO NOTHING`,
        [memId, creator.id, orgId]
      );
    }

    logAuditEvent({
      eventType: 'ORG_CREATE',
      severity: 'info',
      actorUserId: creator?.id || 'system',
      actorUsername: creator?.username || 'system',
      targetId: orgId,
      targetType: 'organization',
      message: `Organization ${name} (${orgId}) created`
    });

    return org;
  }

  /**
   * Update an organization
   */
  static async updateOrganization(orgId, { name, default_policy, max_netmap_staleness_seconds, profile }, actor) {
    const pool = getPgPool();
    const updates = [];
    const params = [];
    let idx = 1;

    if (name) {
      updates.push(`name = $${idx++}`);
      params.push(name);
    }
    if (default_policy) {
      if (!['open', 'deny'].includes(default_policy)) {
        throw new Error('Invalid default_policy: must be open or deny');
      }
      updates.push(`default_policy = $${idx++}`);
      params.push(default_policy);
    }
    if (max_netmap_staleness_seconds !== undefined) {
      updates.push(`max_netmap_staleness_seconds = $${idx++}`);
      params.push(Number(max_netmap_staleness_seconds));
    }
    if (profile) {
      if (!['standard', 'regulated'].includes(profile)) {
        throw new Error('Invalid profile: must be standard or regulated');
      }
      updates.push(`profile = $${idx++}`);
      params.push(profile);
    }

    if (updates.length === 0) {
      return OrgService.getOrganization(orgId);
    }

    updates.push('updated_at = NOW()');
    params.push(orgId);

    const res = await pool.query(
      `UPDATE organizations SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    logAuditEvent({
      eventType: 'ORG_UPDATE',
      severity: 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: orgId,
      targetType: 'organization',
      message: `Organization ${orgId} updated`
    });

    return res.rows[0] || null;
  }

  /**
   * Delete an organization (cannot delete org-default)
   */
  static async deleteOrganization(orgId, actor) {
    if (orgId === 'org-default') {
      throw new Error('Cannot delete default organization');
    }

    const pool = getPgPool();
    const res = await pool.query('DELETE FROM organizations WHERE id = $1 RETURNING id, name', [orgId]);
    if (res.rows.length === 0) {
      return false;
    }

    logAuditEvent({
      eventType: 'ORG_DELETE',
      severity: 'warn',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: orgId,
      targetType: 'organization',
      message: `Organization ${res.rows[0].name} (${orgId}) deleted`
    });

    return true;
  }

  /**
   * List members of an organization
   */
  static async listMembers(orgId) {
    const pool = getPgPool();
    const res = await pool.query(
      `SELECT m.id AS membership_id, m.role, m.created_at AS joined_at,
              u.id AS user_id, u.username, u.email, u.status, u.role AS platform_role
       FROM memberships m
       JOIN users u ON m.user_id = u.id
       WHERE m.organization_id = $1
       ORDER BY m.created_at ASC`,
      [orgId]
    );
    return res.rows;
  }

  /**
   * Add or invite member to an organization
   */
  static async addMember(orgId, userId, role = 'member', actor) {
    if (!['owner', 'admin', 'network_admin', 'auditor', 'member'].includes(role)) {
      throw new Error(`Invalid role: ${role}`);
    }

    const pool = getPgPool();
    const memId = `mem-${uuidv4().substring(0, 8)}`;

    const res = await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, organization_id)
       DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()
       RETURNING *`,
      [memId, userId, orgId, role]
    );

    // Update user's active organization_id if not set
    await pool.query('UPDATE users SET organization_id = $1 WHERE id = $2 AND organization_id IS NULL', [
      orgId,
      userId
    ]);

    logAuditEvent({
      eventType: 'ORG_MEMBER_ADD',
      severity: 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: userId,
      targetType: 'user',
      message: `User ${userId} added to organization ${orgId} with role ${role}`
    });

    return res.rows[0];
  }

  /**
   * Update member role in organization
   */
  static async updateMemberRole(orgId, userId, newRole, actor) {
    if (!['owner', 'admin', 'network_admin', 'auditor', 'member'].includes(newRole)) {
      throw new Error(`Invalid role: ${newRole}`);
    }

    const pool = getPgPool();

    // Check if changing last owner
    const currentMemberRes = await pool.query(
      'SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2',
      [orgId, userId]
    );

    if (currentMemberRes.rows.length === 0) {
      return null;
    }

    if (currentMemberRes.rows[0].role === 'owner' && newRole !== 'owner') {
      const ownerCountRes = await pool.query(
        "SELECT count(*)::int AS count FROM memberships WHERE organization_id = $1 AND role = 'owner'",
        [orgId]
      );
      if (ownerCountRes.rows[0].count <= 1) {
        throw new Error('Cannot demote the last owner of the organization');
      }
    }

    const res = await pool.query(
      `UPDATE memberships SET role = $1, updated_at = NOW()
       WHERE organization_id = $2 AND user_id = $3
       RETURNING *`,
      [newRole, orgId, userId]
    );

    logAuditEvent({
      eventType: 'ORG_MEMBER_ROLE_CHANGE',
      severity: 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: userId,
      targetType: 'user',
      message: `User ${userId} role changed to ${newRole} in org ${orgId}`
    });

    return res.rows[0];
  }

  /**
   * Remove member from organization
   */
  static async removeMember(orgId, userId, actor) {
    const pool = getPgPool();

    // Guard: cannot remove the last owner
    const memberRes = await pool.query('SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2', [
      orgId,
      userId
    ]);

    if (memberRes.rows.length === 0) {
      return false;
    }

    if (memberRes.rows[0].role === 'owner') {
      const ownerCountRes = await pool.query(
        "SELECT count(*)::int AS count FROM memberships WHERE organization_id = $1 AND role = 'owner'",
        [orgId]
      );
      if (ownerCountRes.rows[0].count <= 1) {
        throw new Error('Cannot remove the last owner of the organization');
      }
    }

    await pool.query('DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);

    logAuditEvent({
      eventType: 'ORG_MEMBER_REMOVE',
      severity: 'warn',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: userId,
      targetType: 'user',
      message: `User ${userId} removed from org ${orgId}`
    });

    return true;
  }

  /**
   * Get a user's role inside an organization
   */
  static async getUserOrgRole(orgId, userId) {
    const pool = getPgPool();
    const res = await pool.query('SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2', [
      orgId,
      userId
    ]);
    return res.rows[0] ? res.rows[0].role : null;
  }

  /**
   * Get active modules for an organization
   */
  static async getOrgModules(orgId) {
    const pool = getPgPool();
    const org = await OrgService.getOrganization(orgId);
    if (!org) return [];

    const ModuleLoader = require('./ModuleLoader');
    let moduleIds = ModuleLoader.getLoadedModuleIds();
    if (!moduleIds || moduleIds.length === 0) {
      moduleIds = ['nuke', 'deniability', 'onion'];
    }

    const res = await pool.query('SELECT module_id, enabled FROM organization_modules WHERE organization_id = $1', [
      orgId
    ]);

    const explicitSettings = new Map();
    for (const row of res.rows) {
      explicitSettings.set(row.module_id, Boolean(row.enabled));
    }

    return moduleIds.map((modId) => {
      if (org.profile === 'regulated' && ['nuke', 'deniability', 'onion'].includes(modId)) {
        return { module_id: modId, enabled: false };
      }
      const isExplicit = explicitSettings.has(modId);
      return {
        module_id: modId,
        enabled: isExplicit ? explicitSettings.get(modId) : true
      };
    });
  }

  /**
   * Update module enabled status for an organization
   */
  static async setOrgModule(orgId, moduleId, enabled, actor) {
    const ModuleLoader = require('./ModuleLoader');
    return ModuleLoader.setOrgModuleStatus(orgId, moduleId, enabled, actor);
  }
}

module.exports = OrgService;
