const { getPgPool } = require('../db/index');
const logger = require('../utils/logger');

// Shared with destruction governance. Keep this in the core: enrollment must not
// depend on an optional destruction module being installed or enabled.
const LIFECYCLE_LOCK_ID = 7429149;

function denied(status, message) {
  return Object.assign(new Error(message), { status });
}

async function transaction(operation) {
  const client = await getPgPool().connect();
  const afterCommit = [];
  let result;
  try {
    await client.query('BEGIN');
    // Exclusive also serializes concurrent registrations of the same identity:
    // both must return the address actually stored by the first enrollment.
    await client.query('SELECT pg_advisory_xact_lock($1)', [LIFECYCLE_LOCK_ID]);
    result = await operation(client, afterCommit);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  for (const notify of afterCommit) {
    try {
      await notify();
    } catch (err) {
      logger.error(`Enrollment committed; notification failed: ${err.message}`);
    }
  }
  return result;
}

async function authorizeOwner(client, ownerId, organizationId, { consoleActor = false } = {}) {
  const organization = await client.query(
    // FOR UPDATE also excludes a new membership through its foreign key. An
    // absent legacy membership cannot become read-only after authorization but
    // before the node INSERT while this organization lock remains held.
    'SELECT id, destroyed_at FROM organizations WHERE id = $1 FOR UPDATE',
    [organizationId]
  );
  if (!organization.rowCount || organization.rows[0].destroyed_at) {
    throw denied(403, 'Organization is not available for enrollment');
  }
  const result = await client.query(
    'SELECT id, username, role, status, organization_id FROM users WHERE id = $1 FOR NO KEY UPDATE',
    [ownerId]
  );
  const user = result.rows[0];
  if (!user || user.status !== 'active') throw denied(403, 'Enrollment owner is not active');
  const membership = await client.query(
    'SELECT role FROM memberships WHERE user_id = $1 AND organization_id = $2 FOR UPDATE',
    [ownerId, organizationId]
  );
  const ownOrganization = user.organization_id || 'org-default';
  if (
    user.role !== 'super-admin' &&
    (consoleActor ? ownOrganization !== organizationId : ownOrganization !== organizationId && !membership.rowCount)
  ) {
    throw denied(403, 'Enrollment owner does not belong to this organization');
  }
  // Preserve the existing legacy-account fallback; no membership is fabricated.
  const orgRole = user.role === 'super-admin' ? 'owner' : membership.rows[0]?.role || user.role;
  if (consoleActor && (orgRole === 'auditor' || orgRole === 'viewer')) {
    throw denied(403, 'Forbidden: read-only role cannot create nodes');
  }
  return { ...user, organization_id: organizationId, org_role: orgRole };
}

async function authorizeConsole(client, actor) {
  return authorizeOwner(client, actor.id, actor.organization_id || 'org-default', { consoleActor: true });
}

module.exports = { transaction, authorizeOwner, authorizeConsole, denied, LIFECYCLE_LOCK_ID };
