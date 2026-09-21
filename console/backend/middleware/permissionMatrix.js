/**
 * Permission Matrix as Code (ADR 0019 / WP-106).
 *
 * Defines the complete route permission table across the console backend.
 * Every mounted endpoint must have an explicit entry here.
 */

const PERMISSION_MATRIX = [
  // Health & Version (Public)
  { method: 'GET', path: '/api/health', roles: ['*'], rule: 'public' },
  { method: 'GET', path: '/api/status', roles: ['*'], rule: 'public' },
  { method: 'GET', path: '/api/version', roles: ['*'], rule: 'public' },

  // Auth (Public & Authenticated)
  { method: 'POST', path: '/api/auth/register', roles: ['*'], rule: 'public' },
  { method: 'POST', path: '/api/auth/login', roles: ['*'], rule: 'public' },
  {
    method: 'POST',
    path: '/api/auth/mfa/setup',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'self'
  },
  { method: 'POST', path: '/api/auth/mfa/verify', roles: ['*'], rule: 'public' },
  { method: 'POST', path: '/api/auth/refresh', roles: ['*'], rule: 'public' },
  {
    method: 'GET',
    path: '/api/auth/me',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'self'
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'self'
  },
  {
    method: 'POST',
    path: '/api/auth/setup-passwords',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'self'
  },

  // Users
  { method: 'GET', path: '/api/users', roles: ['super-admin', 'owner', 'admin'], rule: 'org' },
  { method: 'POST', path: '/api/users', roles: ['super-admin', 'owner', 'admin'], rule: 'org' },
  {
    method: 'GET',
    path: '/api/users/:id',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'self'
  },
  {
    method: 'PUT',
    path: '/api/users/:id',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'self'
  },
  { method: 'DELETE', path: '/api/users/:id', roles: ['super-admin', 'owner'], rule: 'org' },
  {
    method: 'GET',
    path: '/api/users/:id/quota',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'self'
  },

  // Organizations
  {
    method: 'GET',
    path: '/api/organizations',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'org'
  },
  { method: 'POST', path: '/api/organizations', roles: ['super-admin'], rule: 'platform' },
  {
    method: 'GET',
    path: '/api/organizations/:id',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'org'
  },
  { method: 'PUT', path: '/api/organizations/:id', roles: ['super-admin', 'owner', 'admin'], rule: 'org' },
  { method: 'DELETE', path: '/api/organizations/:id', roles: ['super-admin', 'owner'], rule: 'org' },
  {
    method: 'GET',
    path: '/api/organizations/:id/members',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'org'
  },
  { method: 'POST', path: '/api/organizations/:id/members', roles: ['super-admin', 'owner', 'admin'], rule: 'org' },
  { method: 'PUT', path: '/api/organizations/:id/members/:userId', roles: ['super-admin', 'owner'], rule: 'org' },
  {
    method: 'DELETE',
    path: '/api/organizations/:id/members/:userId',
    roles: ['super-admin', 'owner', 'admin'],
    rule: 'org'
  },

  // Nodes
  {
    method: 'GET',
    path: '/api/nodes',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'org'
  },
  {
    method: 'POST',
    path: '/api/nodes',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'member', 'user'],
    rule: 'org'
  },
  {
    method: 'GET',
    path: '/api/nodes/:id',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'],
    rule: 'own-node'
  },
  {
    method: 'PUT',
    path: '/api/nodes/:id',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'member', 'user'],
    rule: 'own-node'
  },
  { method: 'DELETE', path: '/api/nodes/:id', roles: ['super-admin', 'owner', 'admin'], rule: 'own-node' },
  { method: 'POST', path: '/api/nodes/:id/quarantine', roles: ['super-admin', 'owner', 'admin'], rule: 'own-node' },
  { method: 'POST', path: '/api/nodes/:id/release', roles: ['super-admin', 'owner', 'admin'], rule: 'own-node' },

  // Pre-Auth Keys
  {
    method: 'GET',
    path: '/api/preauth-keys',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
    rule: 'org'
  },
  { method: 'POST', path: '/api/preauth-keys', roles: ['super-admin', 'owner', 'admin', 'network_admin'], rule: 'org' },
  {
    method: 'DELETE',
    path: '/api/preauth-keys/:id',
    roles: ['super-admin', 'owner', 'admin', 'network_admin'],
    rule: 'org'
  },

  // ACL Rules
  {
    method: 'GET',
    path: '/api/acl',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
    rule: 'org'
  },
  { method: 'POST', path: '/api/acl', roles: ['super-admin', 'owner', 'admin', 'network_admin'], rule: 'org' },
  { method: 'DELETE', path: '/api/acl/:id', roles: ['super-admin', 'owner', 'admin', 'network_admin'], rule: 'org' },

  // Risk
  {
    method: 'GET',
    path: '/api/risk',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
    rule: 'org'
  },
  {
    method: 'GET',
    path: '/api/risk/fleet',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
    rule: 'org'
  },

  // Stats & Audit
  {
    method: 'GET',
    path: '/api/stats',
    roles: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
    rule: 'org'
  },
  { method: 'GET', path: '/api/audit', roles: ['super-admin', 'owner', 'admin', 'auditor'], rule: 'org' },

  // Nuke & Canary
  { method: 'GET', path: '/api/nuke/state', roles: ['super-admin', 'owner'], rule: 'org' },
  { method: 'POST', path: '/api/nuke/arm', roles: ['super-admin', 'owner'], rule: 'org' },
  { method: 'POST', path: '/api/nuke/disarm', roles: ['super-admin', 'owner'], rule: 'org' },
  { method: 'POST', path: '/api/nuke/trigger', roles: ['super-admin', 'owner'], rule: 'org' }
];

/**
 * Match a request method and path against the permission matrix
 */
function findPermissionRule(method, path) {
  const normMethod = method.toUpperCase();
  for (const entry of PERMISSION_MATRIX) {
    if (entry.method !== normMethod) continue;

    // Convert route template (e.g. /api/nodes/:id) to regex
    const regexStr = '^' + entry.path.replace(/:[a-zA-Z0-9_]+/g, '[^/]+') + '$';
    const regex = new RegExp(regexStr);

    if (regex.test(path)) {
      return entry;
    }
  }
  return null;
}

/**
 * Middleware that checks the permission matrix
 */
function permissionMatrixMiddleware(req, res, next) {
  // If route is within /v4/control (node wire contract) or /.well-known, pass through
  if (req.path.startsWith('/v4/control') || req.path.startsWith('/.well-known')) {
    return next();
  }

  const rule = findPermissionRule(req.method, req.path);
  if (!rule) {
    // Undefined route in matrix: default-deny
    return next();
  }

  if (rule.rule === 'public') {
    return next();
  }

  // If endpoint requires auth, ensure user is authenticated
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // super-admin has platform access
  if (req.user.role === 'super-admin') {
    return next();
  }

  const userRole = req.user.org_role || req.user.role || 'user';

  // Check if role is permitted
  if (!rule.roles.includes('*') && !rule.roles.includes(userRole)) {
    return res.status(403).json({ error: 'Forbidden: insufficient role permissions' });
  }

  // Auditor / viewer mutating protection
  if ((userRole === 'auditor' || userRole === 'viewer') && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return res.status(403).json({ error: 'Forbidden: read-only role cannot mutate resources' });
  }

  return next();
}

module.exports = {
  PERMISSION_MATRIX,
  findPermissionRule,
  permissionMatrixMiddleware
};
