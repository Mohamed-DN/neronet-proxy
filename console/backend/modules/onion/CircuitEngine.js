/**
 * Onion circuit path selection.
 *
 * The client half of this has existed since the start: pkg/routing.Build3HopCircuit
 * derives a per-hop ephemeral key and seals each layer under its own nonce. What was
 * missing is the control plane telling a node which three relays to use, so the
 * differentiating feature was unreachable from any deployment.
 *
 * Path selection is the security decision here, not the crypto. A three-hop circuit
 * whose hops all belong to one operator, or sit in one autonomous system, protects
 * nothing: that single party observes entry and exit and can correlate them directly.
 * Tor enforces family and /16 diversity for exactly this reason.
 *
 * Diversity is therefore preferred wherever the fleet can provide it, and the
 * response states what was actually achieved. Refusing outright would be wrong for
 * the common case: a self-hosted mesh has one owner and one ASN by definition, and
 * onion routing still protects its traffic from network observers and from the
 * destination -- just not from the operator, who is the user. A federated mesh is the
 * opposite, and there a single-operator path is worthless.
 *
 * What must never happen is a caller believing they have anonymity they do not have.
 * So the circuit is built, and `diversity` says plainly what it is.
 */

const crypto = require('crypto');

const { getDatabase, isPostgres, getPgPool } = require('../../db/index');
const { normalisePublicKeyHex } = require('../../utils/crypto');
const logger = require('../../utils/logger');

// Tor rotates circuits on roughly this cadence. A long-lived circuit gives a hostile
// relay more traffic to correlate and more time to act on what it sees.
const CIRCUIT_LIFETIME_SECONDS = Number(process.env.SOVEREIGN_CIRCUIT_LIFETIME_SECONDS || 600);

const DEFAULT_HOP_COUNT = 3;
const MAX_HOP_COUNT = 5;

class CircuitError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

async function query(pgSql, pgParams, sqliteSql, sqliteParams) {
  if (isPostgres()) {
    return (await getPgPool().query(pgSql, pgParams)).rows;
  }
  return getDatabase()
    .prepare(sqliteSql)
    .all(...sqliteParams);
}

/** Unbiased random index, so a path is not predictable from a weak generator. */
function randomIndex(bound) {
  if (bound <= 1) return 0;
  return crypto.randomInt(0, bound);
}

function parseEndpoints(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

/**
 * Two hops conflict when one party could observe both.
 *
 * Owner is the strongest signal available here: the same account controlling two hops
 * sees both ends regardless of where they sit. ASN is the network-level equivalent,
 * and matches what Tor approximates with /16 diversity.
 */
function conflictsWith(candidate, chosen) {
  return chosen.some(
    (hop) =>
      hop.id === candidate.id ||
      hop.user_id === candidate.user_id ||
      (Number(candidate.asn) > 0 && Number(hop.asn) === Number(candidate.asn))
  );
}

/**
 * Pick the next hop, preferring one no already-chosen party can observe.
 *
 * Falls back to any unused node when the fleet cannot offer independence. The caller
 * records that fact rather than hiding it.
 */
function pickNextHop(pool, chosen) {
  const independent = pool.filter((candidate) => !conflictsWith(candidate, chosen));
  if (independent.length > 0) {
    return { node: independent[randomIndex(independent.length)], independent: true };
  }

  const unused = pool.filter((candidate) => !chosen.some((hop) => hop.id === candidate.id));
  if (unused.length === 0) return null;

  return { node: unused[randomIndex(unused.length)], independent: false };
}

/** Describe the independence a finished path actually has. */
function describeDiversity(hops) {
  const owners = new Set(hops.map((h) => h.user_id));
  const asns = new Set(hops.map((h) => Number(h.asn)).filter((a) => a > 0));

  const distinctOwners = owners.size === hops.length;
  const distinctAsns = asns.size === hops.length;

  let note;
  if (distinctOwners && distinctAsns) {
    note = 'Every hop is operated by a different account in a different autonomous system.';
  } else if (distinctOwners) {
    note =
      'Hops have different operators but share an autonomous system: a network-level observer may see more than one hop.';
  } else {
    note =
      'All hops are operated by the same account, so that operator can correlate both ends of this circuit. ' +
      'This still conceals traffic from network observers and from the destination, but not from whoever runs the mesh.';
  }

  return {
    distinct_operators: distinctOwners,
    distinct_networks: distinctAsns,
    operator_count: owners.size,
    network_count: asns.size,
    note
  };
}

/**
 * Build a circuit path.
 *
 * The last hop is the exit and is chosen first: it carries the country constraint,
 * and choosing it last would frequently leave no eligible exit after the other hops
 * had consumed the available operators.
 */
async function buildCircuit({ requesterNodeId = null, targetCountry = '', hopCount = DEFAULT_HOP_COUNT } = {}) {
  const hops = Math.min(Math.max(Number(hopCount) || DEFAULT_HOP_COUNT, 2), MAX_HOP_COUNT);
  const country = String(targetCountry || '')
    .slice(0, 2)
    .toUpperCase();

  const relays = await query(
    `SELECT id, user_id, public_key, overlay_ipv4, endpoints, country_code, asn, role, latency_ms
       FROM nodes
      WHERE role IN ('RELAY', 'EXIT_BRIDGE', 'HYBRID')
        AND is_healthy = TRUE
        AND is_quarantined = FALSE`,
    [],
    `SELECT id, user_id, public_key, overlay_ipv4, endpoints, country_code, asn, role, latency_ms
       FROM nodes
      WHERE role IN ('RELAY', 'EXIT_BRIDGE', 'HYBRID')
        AND is_healthy = 1
        AND is_quarantined = 0`,
    []
  );

  // The requester must not be a hop in its own circuit: it already knows its own
  // traffic, and including it wastes a hop that could have added an observer.
  //
  // A hop also needs a usable public key. Rows written before the bridge spoke the
  // right contract carry placeholders like 'unknown-...', and selecting one produces
  // a circuit that fails at the first Diffie-Hellman rather than at selection, where
  // the reason would be obvious.
  const pool = relays
    .filter((node) => node.id !== requesterNodeId)
    .map((node) => ({ ...node, public_key_hex: normalisePublicKeyHex(node.public_key) }))
    .filter((node) => node.public_key_hex !== null);

  if (pool.length < hops) {
    throw new CircuitError(`need ${hops} healthy relays to build a circuit, ${pool.length} available`, 503);
  }

  const exitCandidates = pool.filter(
    (node) =>
      (node.role === 'EXIT_BRIDGE' || node.role === 'HYBRID') &&
      (!country || String(node.country_code).toUpperCase() === country)
  );

  if (exitCandidates.length === 0) {
    throw new CircuitError(
      country ? `no healthy exit bridge available in ${country}` : 'no healthy exit bridge available',
      503
    );
  }

  const exit = exitCandidates[randomIndex(exitCandidates.length)];
  const chosen = [exit];

  // Fill the remaining hops backwards from the exit, so the entry hop is chosen last.
  for (let i = 1; i < hops; i++) {
    const next = pickNextHop(pool, chosen);

    if (!next) {
      throw new CircuitError(
        `cannot build a ${hops}-hop circuit: only ${chosen.length} distinct relays are available`,
        503
      );
    }

    chosen.unshift(next.node);
  }

  const diversity = describeDiversity(chosen);

  if (!diversity.distinct_operators) {
    logger.warn(
      `Circuit built without operator diversity (${diversity.operator_count} operator across ${hops} hops). ${diversity.note}`
    );
  }

  return {
    // uint32 on the wire. Random rather than sequential: a predictable circuit id
    // leaks how many circuits exist and lets an observer guess future ones.
    circuit_id: crypto.randomInt(1, 4294967295),
    hops: chosen.map((node, index) => ({
      hop_index: index,
      node_id: node.id,
      public_key_hex: node.public_key_hex,
      endpoints: parseEndpoints(node.endpoints)
    })),
    expiry_timestamp: Math.floor(Date.now() / 1000) + CIRCUIT_LIFETIME_SECONDS,
    // Additive field: Go's CircuitResponse ignores it, and the console and CLI can
    // surface it. A caller must be able to tell a diverse path from one that only
    // looks like one.
    diversity
  };
}

module.exports = {
  CircuitError,
  describeDiversity,
  CIRCUIT_LIFETIME_SECONDS,
  buildCircuit,
  conflictsWith
};
