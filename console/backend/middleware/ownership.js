/**
 * Resource ownership & tenant isolation checks (ADR 0019 / WP-106).
 *
 * Centralises the check so that:
 * 1. Cross-organization access returns 404 (eliminating existence oracle leaks).
 * 2. Members within the same organization with role owner/admin/network_admin/auditor
 *    can view organizational resources.
 * 3. Auditors receive 403 on mutating HTTP requests (POST, PUT, DELETE, PATCH).
 */

const { getPgPool } = require('../db/index');

/**
 * Require that the addressed row belongs to the caller or their organization.
 *
 * Returns 404 rather than 403 when a non-owner addresses someone else's row to avoid
 * an existence oracle. Super-admins have global access.
 */
function requireOwnership({ table, param = 'id', ownerColumn = 'user_id' }) {
  return async function ownershipMiddleware(req, res, next) {
    try {
      const id = req.params[param];
      if (!id) {
        return res.status(400).json({ error: `missing ${param}` });
      }

      const pool = getPgPool();
      let query = `SELECT ${ownerColumn} AS owner, organization_id FROM ${table} WHERE id = $1`;
      let result;
      try {
        result = await pool.query(query, [id]);
      } catch (err) {
        // If organization_id column doesn't exist on table yet
        result = await pool.query(`SELECT ${ownerColumn} AS owner FROM ${table} WHERE id = $1`, [id]);
      }

      const row = result.rows[0];
      if (!row) {
        return res.status(404).json({ error: 'not found' });
      }

      // 1. Super-admin platform override
      if (req.user.role === 'super-admin') {
        req.resourceOwnerId = row.owner;
        req.resourceOrgId = row.organization_id;
        return next();
      }

      // 2. Cross-Organization check: if resource belongs to another org -> 404 (no existence oracle)
      const userOrgId = req.user.organization_id;
      if (row.organization_id && userOrgId && row.organization_id !== userOrgId) {
        return res.status(404).json({ error: 'not found' });
      }

      const orgRole = req.user.org_role || req.user.role;
      const isOrgAdminOrAuditor = ['owner', 'admin', 'network_admin', 'auditor'].includes(orgRole);

      // If user is within the same organization and has elevated org role
      if (row.organization_id && userOrgId && row.organization_id === userOrgId && isOrgAdminOrAuditor) {
        // Auditor cannot mutate
        if (
          (orgRole === 'auditor' || orgRole === 'viewer') &&
          ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)
        ) {
          return res.status(403).json({ error: 'Forbidden: read-only role cannot mutate resource' });
        }
        req.resourceOwnerId = row.owner;
        req.resourceOrgId = row.organization_id;
        return next();
      }

      // 3. User-level ownership check
      if (row.owner !== req.user.id) {
        return res.status(404).json({ error: 'not found' });
      }

      req.resourceOwnerId = row.owner;
      req.resourceOrgId = row.organization_id;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

const requireNodeOwnership = requireOwnership({ table: 'nodes' });

module.exports = {
  requireOwnership,
  requireNodeOwnership
};
