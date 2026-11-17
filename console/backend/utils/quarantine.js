// What the console knows about why a device is blocked, in one place.
//
// A device is blocked (quarantined) in two ways: an administrator does it (the reason is
// theirs, or 'Manual security quarantine'), or the risk engine does it by itself and always
// writes AUTO_QUARANTINE_REASON. The column nodes.quarantine_reason is the only record of
// which, so the engine and the member-facing policy must share this one string.
const AUTO_QUARANTINE_REASON = 'Behavioral Risk Score > 75 (Impossible travel / network anomaly)';

// Same set of roles that verifyNodeAccess in routes/nodes.js treats as administrators.
const ADMIN_ROLES = ['super-admin', 'owner', 'admin', 'network_admin'];

function isAdministrator(user) {
  if (!user) return false;
  if (user.role === 'super-admin') return true;
  return ADMIN_ROLES.includes(user.org_role || user.role || 'member');
}

// A block an administrator put there (anything but the risk engine's own reason).
function isManualBlock(row) {
  return Boolean(row.is_quarantined) && row.quarantine_reason !== AUTO_QUARANTINE_REASON;
}

module.exports = { AUTO_QUARANTINE_REASON, isAdministrator, isManualBlock };
