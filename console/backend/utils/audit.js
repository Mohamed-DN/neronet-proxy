const { isPostgres, getPgPool, getDatabase } = require('../db/index');
const logger = require('./logger');

async function logAuditEvent({
  eventType,
  severity = 'info',
  actorUserId = null,
  actorUsername = 'system',
  targetId = null,
  targetType = null,
  message,
  ipAddress = '127.0.0.1',
  userAgent = null,
  metadata = {}
}) {
  severity = normaliseSeverity(severity);

  try {
    if (isPostgres()) {
      const pool = getPgPool();
      await pool.query(
        `
        INSERT INTO audit_events (
          event_type, severity, actor_user_id, actor_username,
          target_id, target_type, message, ip_address, user_agent, metadata_json
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
      `,
        [
          eventType,
          severity,
          actorUserId,
          actorUsername,
          targetId,
          targetType,
          message,
          ipAddress,
          userAgent,
          typeof metadata === 'object' ? JSON.stringify(metadata) : metadata
        ]
      );
    } else {
      const db = getDatabase();
      const stmt = db.prepare(`
        INSERT INTO audit_events (
          event_type, severity, actor_user_id, actor_username,
          target_id, target_type, message, ip_address, user_agent, metadata_json
        ) VALUES (
          @eventType, @severity, @actorUserId, @actorUsername,
          @targetId, @targetType, @message, @ipAddress, @userAgent, @metadataJson
        )
      `);

      stmt.run({
        eventType,
        severity,
        actorUserId,
        actorUsername,
        targetId,
        targetType,
        message,
        ipAddress,
        userAgent,
        metadataJson: typeof metadata === 'string' ? metadata : JSON.stringify(metadata)
      });
    }
  } catch (err) {
    // A failure here is not a cosmetic one. This function named the column
    // `metadata` on PostgreSQL where the table defines `metadata_json`, so every
    // write failed and was swallowed: the deployment ran for weeks with an audit
    // ledger that recorded nothing, while the console showed an empty log as though
    // nothing had happened. The SQLite branch used the right name, so the tests
    // passed throughout.
    //
    // The count is what makes the next such failure visible: /api/health reports it
    // rather than leaving it in a log nobody reads.
    failedWrites += 1;
    lastFailure = { at: new Date().toISOString(), reason: err.message };
    logger.error('Failed to write audit event:', err.message);
  }
}

// The column is constrained to these four. A caller passing anything else — and
// 'warning' for 'warn' is the obvious slip — had its record rejected and dropped.
// Losing an audit record over a label is worse than recording it under a near
// neighbour, so the common aliases are mapped and anything unrecognised is kept as
// 'info' with the original preserved in the message-bearing metadata.
const VALID_SEVERITIES = new Set(['info', 'warn', 'error', 'critical']);
const SEVERITY_ALIASES = {
  warning: 'warn',
  err: 'error',
  fatal: 'critical',
  debug: 'info',
  notice: 'info'
};

function normaliseSeverity(value) {
  const lower = String(value || 'info').toLowerCase();
  if (VALID_SEVERITIES.has(lower)) return lower;
  if (SEVERITY_ALIASES[lower]) return SEVERITY_ALIASES[lower];

  logger.warn(`Audit severity '${value}' is not one of ${[...VALID_SEVERITIES].join(', ')}; recorded as info`);
  return 'info';
}

let failedWrites = 0;
let lastFailure = null;

/** Audit ledger write failures since start, for the health probe. */
function auditHealth() {
  return {
    failed_writes: failedWrites,
    last_failure: lastFailure,
    status: failedWrites === 0 ? 'ok' : 'degraded'
  };
}

module.exports = { logAuditEvent, auditHealth };
