const { getPgPool } = require('../db/index');

/**
 * Middleware that enriches req.user with organization_id and org_role from memberships table
 */
async function resolveUserOrg(req, res, next) {
  if (!req.user || !req.user.id) {
    return next();
  }

  try {
    const pool = getPgPool();

    // If org_id already present and org_role present, skip DB lookup
    if (req.user.organization_id && req.user.org_role) {
      return next();
    }

    // 1. Check users.organization_id
    const userRes = await pool.query('SELECT organization_id, role FROM users WHERE id = $1', [req.user.id]);
    if (userRes.rows.length > 0) {
      req.user.organization_id = req.user.organization_id || userRes.rows[0].organization_id || 'org-default';
    } else {
      req.user.organization_id = req.user.organization_id || 'org-default';
    }

    // 2. Lookup role in memberships table
    const memRes = await pool.query('SELECT role FROM memberships WHERE user_id = $1 AND organization_id = $2', [
      req.user.id,
      req.user.organization_id
    ]);

    if (memRes.rows.length > 0) {
      req.user.org_role = memRes.rows[0].role;
    } else {
      // Fallback: super-admin gets 'owner', user gets 'member'
      req.user.org_role = req.user.role === 'super-admin' ? 'owner' : 'member';
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Require at least one of the specified roles (checks platform role or org role)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // super-admin has platform-wide superuser access
    if (req.user.role === 'super-admin') {
      return next();
    }

    const currentRole = req.user.org_role || req.user.role;
    if (!roles.includes(currentRole)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role permissions' });
    }

    next();
  };
}

/**
 * Require a specific organizational role
 */
function requireOrgRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.user.role === 'super-admin') {
      return next();
    }

    const orgRole = req.user.org_role || req.user.role;
    if (!roles.includes(orgRole)) {
      return res.status(403).json({ error: 'Forbidden: insufficient organizational role permissions' });
    }

    next();
  };
}

/**
 * Read-only protector: Auditor / viewer cannot invoke mutating operations
 */
function requireNotAuditor(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const role = req.user.org_role || req.user.role;
  if ((role === 'auditor' || role === 'viewer') && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return res.status(403).json({ error: 'Forbidden: read-only role cannot perform mutating operations' });
  }

  next();
}

/**
 * Require super-admin role strictly
 */
function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'super-admin') {
    return res.status(403).json({ error: 'Forbidden: platform super-admin role required' });
  }
  next();
}

module.exports = {
  resolveUserOrg,
  requireRole,
  requireOrgRole,
  requireNotAuditor,
  requireSuperAdmin
};
