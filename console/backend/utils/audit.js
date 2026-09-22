const { getPgPool } = require('../db/index');
const logger = require('./logger');
const { AuditChainService } = require('../services/AuditChainService');
const { SiemExporter } = require('../services/SiemExporter');

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
    const row = await AuditChainService.appendEvent({
      eventType,
      severity,
      actorUserId,
      actorUsername,
      targetId,
      targetType,
      message,
      ipAddress,
      userAgent,
      metadata
    });

    // Asynchronously forward to configured SIEM destinations
    SiemExporter.forwardEvent(row).catch((err) => {
      logger.warn('Asynchronous SIEM forward error: ' + err.message);
    });

    return row;
  } catch (err) {
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
