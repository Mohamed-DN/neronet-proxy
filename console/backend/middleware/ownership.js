/**
 * Resource ownership checks.
 *
 * Authentication answers "who are you". Authorization answers "may you touch this
 * particular row", and that second question was being answered inline, differently,
 * in each route that remembered to ask it -- and not at all in several that did not.
 * A node's risk score, name and quarantine reason were readable by any authenticated
 * user for any node in the system, and its heartbeat endpoint accepted telemetry for
 * any node id, so one tenant could write fabricated metrics onto another's devices.
 *
 * Centralising the check means a new route is protected by adding a middleware
 * rather than by remembering a four-line pattern.
 */

const { getDatabase, isPostgres, getPgPool } = require('../db/index');

/**
 * Require that the addressed row belongs to the caller.
 *
 * Returns 404 rather than 403 when a non-owner addresses someone else's row. 403
 * confirms the row exists, which turns any such endpoint into an oracle for
 * enumerating other tenants' resource ids. Super-admins get the real answer.
 */
function requireOwnership({ table, param = 'id', ownerColumn = 'user_id' }) {
  return async function ownershipMiddleware(req, res, next) {
    try {
      const id = req.params[param];
      if (!id) {
        return res.status(400).json({ error: `missing ${param}` });
      }

      let row;
      if (isPostgres()) {
        const result = await getPgPool().query(`SELECT ${ownerColumn} AS owner FROM ${table} WHERE id = $1`, [id]);
        row = result.rows[0];
      } else {
        row = getDatabase().prepare(`SELECT ${ownerColumn} AS owner FROM ${table} WHERE id = ?`).get(id);
      }

      if (!row) {
        return res.status(404).json({ error: 'not found' });
      }

      if (req.user.role !== 'super-admin' && row.owner !== req.user.id) {
        return res.status(404).json({ error: 'not found' });
      }

      // Hand the resolved owner on, so a handler does not have to look it up again.
      req.resourceOwnerId = row.owner;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

const requireNodeOwnership = requireOwnership({ table: 'nodes' });
const requireAppOwnership = requireOwnership({ table: 'app_bundles' });

module.exports = {
  requireOwnership,
  requireNodeOwnership,
  requireAppOwnership
};
