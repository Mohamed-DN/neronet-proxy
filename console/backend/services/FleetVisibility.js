const { getPgPool } = require('../db');

const ORG_READERS = new Set(['owner', 'admin', 'network_admin', 'auditor']);

async function resolveMetricsScope(user, selectedOrganization) {
  const result = await getPgPool().query(
    `SELECT u.id, u.role, u.status, COALESCE(u.organization_id, 'org-default') AS organization_id,
            m.role AS membership_role
       FROM users u LEFT JOIN memberships m ON m.user_id=u.id
        AND m.organization_id=COALESCE(u.organization_id, 'org-default') WHERE u.id=$1`,
    [user.id]
  );
  const actor = result.rows[0];
  if (!actor || actor.status !== 'active') {
    const error = new Error('Active statistics account required');
    error.status = 403;
    throw error;
  }
  if (actor.role === 'super-admin') {
    return { organizationId: selectedOrganization || undefined };
  }
  return {
    organizationId: actor.organization_id,
    userId: ORG_READERS.has(actor.membership_role) ? undefined : actor.id
  };
}

// All callers alias nodes as n and compartments as c. Scope is resolved from the
// current database account, never from a tenant or role claimed by an old JWT.
function nodeVisibility(accessTier = 'standard', scope = {}, parameterOffset = 0) {
  const conditions = [];
  const params = [];
  if (accessTier !== 'root') conditions.push('COALESCE(c.is_hidden, FALSE) = FALSE');
  for (const [value, column] of [
    [scope.organizationId, "COALESCE(n.organization_id, 'org-default')"],
    [scope.userId, 'n.user_id']
  ]) {
    if (value !== undefined) {
      params.push(value);
      conditions.push(`${column} = $${parameterOffset + params.length}`);
    }
  }
  return {
    join: "LEFT JOIN compartments c ON c.id = COALESCE(n.compartment_id, 'cmp-' || COALESCE(n.organization_id, 'org-default'))",
    where: conditions.length ? conditions.join(' AND ') : 'TRUE',
    params
  };
}

module.exports = { resolveMetricsScope, nodeVisibility };
