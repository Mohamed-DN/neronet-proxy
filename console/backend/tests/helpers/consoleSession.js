const jwt = require('jsonwebtoken');
const config = require('../../config/env');
const { getPgPool } = require('../../db');

/** Issue a real family while retaining the claims each fixture intends to test. */
async function issueConsoleTestToken(payload, optionsOrExpiresIn) {
  const { issueSession } = require('../../services/ConsoleSessionService');
  const pool = getPgPool();
  const id = payload.id || payload.sub;
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  if (!result.rows[0]) throw new Error(`Console session fixture user does not exist: ${id}`);

  const user = { ...result.rows[0], compartment_access: payload.compartment_access || 'standard' };
  const session = await issueSession({ user, ipAddress: '127.0.0.1' });
  const issued = jwt.decode(session.token);
  if (!issued?.sid) throw new Error('Console session fixture was issued without a family ID');
  const claims = { ...payload, sid: issued.sid };
  if (issued.root_grant_id) claims.root_grant_id = issued.root_grant_id;
  const options = typeof optionsOrExpiresIn === 'string' ? { expiresIn: optionsOrExpiresIn } : optionsOrExpiresIn;
  const token = jwt.sign(claims, config.JWT_SECRET, options);
  const fixture = jwt.decode(token);

  // Long-lived fixtures exercise timeout clamping and exact durable revocation
  // expiry. Their real family (and root grant) must remain valid for that span.
  if (Number.isFinite(fixture.exp)) {
    await pool.query(
      `UPDATE console_sessions
       SET expires_at = GREATEST(expires_at, to_timestamp($2)),
           root_grant_expires_at = CASE WHEN root_grant_id IS NOT NULL
             THEN to_timestamp($2) ELSE root_grant_expires_at END
       WHERE id = $1`,
      [issued.sid, fixture.exp]
    );
  }
  return token;
}

module.exports = { issueConsoleTestToken };
