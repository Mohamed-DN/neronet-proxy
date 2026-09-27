const config = require('../config/env');
const { getPgPool } = require('../db/index');

/**
 * Who must have TOTP before a session is issued.
 *
 * SOVEREIGN_MFA_MANDATORY:
 *   off    - only accounts that enrolled themselves
 *   admins - also the platform super-admin and every organisation owner and admin
 *   all    - every account
 * "true" is read as "admins" and "false" as "off", the values the variable took before.
 * Unset, production means "admins" and anything else "off".
 *
 * Read on each sign-in, so a change takes effect without a restart. It is the server's
 * configuration alone: the X-Enforce-MFA request header that used to feed this
 * decision is ignored.
 */
function mode() {
  const raw = String(process.env.SOVEREIGN_MFA_MANDATORY || '')
    .trim()
    .toLowerCase();
  if (raw === 'all') return 'all';
  if (raw === 'admins' || raw === 'true') return 'admins';
  if (raw === 'off' || raw === 'false') return 'off';
  return config.IS_PRODUCTION ? 'admins' : 'off';
}

async function isAdministrator(user) {
  if (user.role === 'super-admin') return true;
  const res = await getPgPool().query(
    "SELECT 1 FROM memberships WHERE user_id = $1 AND role IN ('owner', 'admin') LIMIT 1",
    [user.id]
  );
  return res.rows.length > 0;
}

async function isMfaRequired(user) {
  if (user.totp_enabled) return true;
  const m = mode();
  if (m === 'all') return true;
  if (m === 'admins') return isAdministrator(user);
  return false;
}

module.exports = { mode, isMfaRequired };
