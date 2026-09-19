/**
 * Node posture: what was measured, and what follows from it.
 *
 * The schema used to default every node's posture to
 * {"compliant": true, "disk_encrypted": true, "os": "Linux"} and the heartbeat
 * handler ignored the attestation the node sent, so the console described the whole
 * fleet as compliant and disk-encrypted without a single measurement behind it.
 *
 * Two rules hold here. A value that was not measured is null, never a default. A
 * node whose required checks are unknown is "unverified", which is neither compliant
 * nor a violation.
 */

// The checks a node must report, and pass, before it can be called compliant.
// Nothing measures either of them on the host yet, so in practice every node is
// currently unverified -- which is the point: that is the true state.
const REQUIRED_CHECKS = ['disk_encrypted', 'firewall_active'];

const STATUS_VERIFIED_COMPLIANT = 'verified_compliant';
const STATUS_NON_COMPLIANT = 'non_compliant';
const STATUS_UNVERIFIED = 'unverified';

// Upper bound on any string taken from an attestation. The document is rewritten on
// every heartbeat, so an unbounded value from a compromised node would be stored,
// buffered and returned by every node list on each beat.
const MAX_MEASURED_STRING = 128;

/** A string the node actually sent, or null. Whitespace is not a measurement. */
function measuredString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_MEASURED_STRING);
}

/**
 * A boolean the node actually sent, or null.
 *
 * Only a real boolean counts. A string "true" or a 1 is a caller that does not speak
 * the contract, and coercing it would invent the very certainty this module exists to
 * prevent.
 */
function measuredBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

/**
 * When the node took the measurement.
 *
 * Go marshals time.Time as RFC 3339, and its zero value comes across as year 1. Both
 * an unparseable and a zero timestamp fall back to the moment the control plane
 * received the beat, which is the closest thing to a measurement time that is true.
 */
function measuredAt(value, receivedAt = new Date()) {
  const parsed = typeof value === 'string' ? new Date(value) : null;
  if (parsed && !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() > 1) {
    return parsed.toISOString();
  }
  return receivedAt.toISOString();
}

/**
 * Build the posture document stored on the node row from a heartbeat attestation.
 *
 * Returns null when the heartbeat carried no attestation, so the caller leaves the
 * stored document untouched rather than overwriting it with a row of nulls.
 */
function buildPostureDocument(attestation, receivedAt = new Date()) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return null;
  }

  return {
    os_name: measuredString(attestation.os_name),
    os_version: measuredString(attestation.os_version),
    client_version: measuredString(attestation.client_version),
    disk_encrypted: measuredBoolean(attestation.disk_encrypted),
    firewall_active: measuredBoolean(attestation.firewall_active),
    is_rootless: measuredBoolean(attestation.is_rootless),
    measured_at: measuredAt(attestation.timestamp_utc, receivedAt)
  };
}

/**
 * Derive the posture status of a node from its stored document.
 *
 * verified_compliant needs every required check present and true. One required check
 * measured false is non_compliant. Anything else -- an empty document, a missing
 * check, a null -- is unverified.
 */
function derivePostureStatus(posture) {
  if (!posture || typeof posture !== 'object' || Array.isArray(posture)) {
    return STATUS_UNVERIFIED;
  }

  let allKnownAndPassing = true;

  for (const check of REQUIRED_CHECKS) {
    const value = posture[check];
    if (value === false) {
      return STATUS_NON_COMPLIANT;
    }
    if (value !== true) {
      allKnownAndPassing = false;
    }
  }

  return allKnownAndPassing ? STATUS_VERIFIED_COMPLIANT : STATUS_UNVERIFIED;
}

/** Zeroed counts, so a caller can tally without special-casing the first row. */
function emptyPostureCounts() {
  return { verified_compliant: 0, unverified: 0, non_compliant: 0 };
}

module.exports = {
  REQUIRED_CHECKS,
  STATUS_VERIFIED_COMPLIANT,
  STATUS_NON_COMPLIANT,
  STATUS_UNVERIFIED,
  buildPostureDocument,
  derivePostureStatus,
  emptyPostureCounts
};
