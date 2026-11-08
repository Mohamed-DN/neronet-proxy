'use strict';

/**
 * The control plane's authority over node transports (ADR 0022, T0 P1).
 *
 * A path between two nodes is allowed only when every party that owns a say allows it:
 * the installation (ceiling, operator configuration), the organisation (console
 * policy), each node's binary (declared at a registration that proved key
 * possession), and -- for DERP -- the relays the installation runs. Nothing here
 * widens what a node may do; every step is an intersection, and anything unknown is
 * read as "not allowed".
 */

const crypto = require('node:crypto');
const { getPgPool } = require('../db');
const AclEngine = require('./AclEngine');
const logger = require('../utils/logger');
const { normalisePublicKeyHex } = require('../utils/crypto');

const KNOWN_TRANSPORTS = ['udp', 'derp'];
const CAPABILITY = 'derp-v2';
const KNOWN_CAPABILITIES = [CAPABILITY];
const MAX_ENABLED_RELAYS = 32; // the node refuses a document with more candidates
const MAX_HOMES = 2; // the node refuses a peer advertising more
const RELAY_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RELAY_CREDENTIAL = /^nrr1_[0-9a-f]{64}$/;

function pool(client) {
  return client || getPgPool();
}

function positiveSeconds(name, fallback, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

/** Seconds a reported relay home stays valid without being reported again. */
function homeTtlSeconds() {
  return positiveSeconds('SOVEREIGN_RELAY_HOME_TTL_SECONDS', 120, 86400);
}

/** Absolute lifetime of an admission snapshot at the relay. */
function admissionStalenessSeconds() {
  return positiveSeconds('SOVEREIGN_RELAY_ADMISSION_MAX_STALENESS_SECONDS', 60, 86400);
}

/**
 * The installation ceiling. Read on every call so a misconfiguration is refused, not
 * cached; the server calls it at start so a bad value stops the process there.
 */
function ceiling() {
  const raw = process.env.SOVEREIGN_TRANSPORT_CEILING;
  if (raw === undefined || raw.trim() === '') return ['udp'];
  const parts = raw.split(',').map((s) => s.trim().toLowerCase());
  const unknown = parts.filter((p) => !KNOWN_TRANSPORTS.includes(p));
  if (unknown.length > 0 || parts.length === 0) {
    throw new Error(`SOVEREIGN_TRANSPORT_CEILING names unknown transport(s): ${unknown.join(', ') || '(empty)'}`);
  }
  return canonical(parts);
}

/** Known values only, de-duplicated, in the registry's order. */
function canonical(list, known = KNOWN_TRANSPORTS) {
  if (!Array.isArray(list)) return [];
  return known.filter((k) => list.includes(k));
}

function intersect(...lists) {
  return KNOWN_TRANSPORTS.filter((t) => lists.every((l) => Array.isArray(l) && l.includes(t)));
}

/**
 * Validate a list an administrator submitted. Unlike canonical(), an unknown or
 * repeated value is an error: silently dropping it would store a policy other than
 * the one the administrator believes they set.
 */
function parseAdminList(list) {
  if (!Array.isArray(list) || list.length > KNOWN_TRANSPORTS.length) return null;
  if (!list.every((t) => typeof t === 'string' && KNOWN_TRANSPORTS.includes(t))) return null;
  if (new Set(list).size !== list.length) return null;
  return canonical(list);
}

function organisationEffective(allowed) {
  return intersect(ceiling(), allowed == null ? ['udp'] : allowed);
}

/**
 * What a node can do with its binary under its organisation. A legacy node speaks
 * UDP only, whatever it carries.
 */
function nodeEffective(node, orgAllowed) {
  const isV2 = Array.isArray(node.node_capabilities) && node.node_capabilities.includes(CAPABILITY);
  const built = isV2 ? node.transports_built || [] : ['udp'];
  return intersect(organisationEffective(orgAllowed), built);
}

function isV2(node) {
  return Array.isArray(node.node_capabilities) && node.node_capabilities.includes(CAPABILITY);
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Record the transports and capabilities a node declared at registration. Returns
 * true when they changed, after moving the netmap version: every peer's document
 * depends on them.
 */
async function recordNodeCapability(nodeId, capability = {}, client = null) {
  const transports = canonical(capability.transports);
  const capabilities = canonical(capability.capabilities, KNOWN_CAPABILITIES);
  const res = await pool(client).query(
    `UPDATE nodes SET transports_built = $2, node_capabilities = $3, updated_at = NOW()
      WHERE id = $1 AND (transports_built IS DISTINCT FROM $2 OR node_capabilities IS DISTINCT FROM $3)
      RETURNING id`,
    [nodeId, transports, capabilities]
  );
  if (res.rowCount === 0) return false;
  await AclEngine.bumpNetmap(client);
  return true;
}

/**
 * Apply the relay homes a node reported in a heartbeat.
 *
 * Without `transport_report_version` the beat says nothing about homes (a legacy node,
 * or a node built before reports existed) and the stored homes are left alone. With
 * it, the list is the whole truth: omitted means withdrawn. Homes on a relay the
 * installation does not run are dropped; a list a node would never send is refused.
 */
async function recordRelayHomes(nodeId, body, client = null) {
  if (body.transport_report_version === undefined) return false;
  // A report this control plane cannot use is ignored, never the beat that carries
  // it: the same beat delivers quarantine, revocation and credential rotation, and a
  // node that cannot heartbeat learns none of them.
  if (body.transport_report_version !== CAPABILITY) {
    logger.warn(`[TRANSPORT] ${nodeId} sent transport_report_version ${body.transport_report_version}; report ignored`);
    return false;
  }
  const reported = Array.isArray(body.relay_homes) ? body.relay_homes : [];
  if (reported.length > MAX_HOMES) {
    logger.warn(`[TRANSPORT] ${nodeId} reported ${reported.length} relay homes (at most ${MAX_HOMES}); report ignored`);
    return false;
  }
  // Freshness is measured on this server's clock (relay_homes_reported_at). The
  // node's own timestamp is informational and never stored in the future: a fast
  // clock must neither withdraw a home nor make it look fresher than it is.
  const now = Math.floor(Date.now() / 1000);
  const known = new Set(
    (await pool(client).query('SELECT relay_id FROM transport_relays WHERE enabled = TRUE')).rows.map((r) => r.relay_id)
  );
  const homes = [];
  for (const home of reported) {
    if (known.has(home.relay_id) && !homes.some((h) => h.relay_id === home.relay_id)) {
      const observed = Number.isInteger(home.observed_at_unix) ? Math.min(home.observed_at_unix, now) : now;
      homes.push({ relay_id: home.relay_id, observed_at_unix: observed });
    }
  }
  const current = (
    await pool(client).query('SELECT relay_homes, relay_homes_reported_at FROM nodes WHERE id = $1', [nodeId])
  ).rows[0];
  if (!current) return false;
  const ttl = homeTtlSeconds();
  const ageOf = (stamp) => (stamp ? (Date.now() - new Date(stamp).getTime()) / 1000 : Infinity);
  const age = ageOf(current.relay_homes_reported_at);
  // What peers were last told: nothing once the stored homes are past their TTL.
  const published = age > ttl ? [] : (current.relay_homes || []).map((h) => h.relay_id);
  const next = homes.map((h) => h.relay_id);
  const changed = !sameList(published, next);
  // The timestamps move every beat but only the set of relays is the document. Writing
  // every beat would be one UPDATE per node per beat, so an unchanged set refreshes its
  // freshness stamp only once it is half way to expiry.
  if (!changed && (next.length === 0 || age < ttl / 2)) return false;
  await pool(client).query('UPDATE nodes SET relay_homes = $2::jsonb, relay_homes_reported_at = $3 WHERE id = $1', [
    nodeId,
    JSON.stringify(homes),
    next.length === 0 ? null : new Date()
  ]);
  if (changed) await AclEngine.bumpNetmap(client);
  return changed;
}

/** Clear homes nobody has reported within the TTL; move the version if any were. */
async function expireRelayHomes(client = null) {
  const res = await pool(client).query(
    `UPDATE nodes SET relay_homes = '[]'::jsonb, relay_homes_reported_at = NULL
      WHERE relay_homes_reported_at IS NOT NULL
        AND relay_homes_reported_at < NOW() - make_interval(secs => $1)
      RETURNING id`,
    [homeTtlSeconds()]
  );
  if (res.rowCount > 0) await AclEngine.bumpNetmap(client);
  return res.rowCount;
}

/** Move the netmap version if the ceiling differs from the one last applied. */
async function reconcileCeiling(client = null) {
  const current = ceiling();
  const res = await pool(client).query(
    `INSERT INTO transport_policy_state (singleton, applied_ceiling) VALUES (TRUE, $1)
     ON CONFLICT (singleton) DO UPDATE SET applied_ceiling = EXCLUDED.applied_ceiling, applied_at = NOW()
       WHERE transport_policy_state.applied_ceiling IS DISTINCT FROM EXCLUDED.applied_ceiling
     RETURNING (xmax = 0) AS inserted`,
    [current]
  );
  if (res.rowCount === 0) return false;
  if (!res.rows[0].inserted) {
    logger.info(`[TRANSPORT] Installation ceiling changed to ${current.join(',')}; netmap version advanced`);
  }
  await AclEngine.bumpNetmap(client);
  return true;
}

async function enabledRelays(client = null) {
  return (
    await pool(client).query(
      'SELECT relay_id, url, capability FROM transport_relays WHERE enabled = TRUE ORDER BY relay_id LIMIT $1',
      [MAX_ENABLED_RELAYS]
    )
  ).rows;
}

function freshHomes(row, relayIds) {
  if (!row.relay_homes_reported_at) return [];
  const age = (Date.now() - new Date(row.relay_homes_reported_at).getTime()) / 1000;
  if (age > homeTtlSeconds()) return [];
  const homes = Array.isArray(row.relay_homes) ? row.relay_homes : [];
  return homes.filter((h) => relayIds.has(h.relay_id)).slice(0, MAX_HOMES);
}

/**
 * The transport part of one node's netmap.
 *
 * Returns { document, peer(row) }: `document` is merged into the response (empty for
 * a legacy document), `peer` returns null for a peer the pair has no path to, or the
 * fields to merge into that peer's entry.
 */
async function planFor(self, orgAllowed, client = null) {
  // A quarantined node is isolated: no transport, so no relay either.
  const selfEffective = self.is_quarantined ? [] : nodeEffective(self, orgAllowed);
  const relays = selfEffective.includes('derp') ? await enabledRelays(client) : [];
  const relayIds = new Set(relays.map((r) => r.relay_id));
  const versioned = isV2(self);

  const document = {};
  if (versioned) {
    document.transport_policy_version = CAPABILITY;
    if (selfEffective.length > 0) document.allowed_transports = selfEffective;
    if (relays.length > 0) {
      document.relay_candidates = relays.map((r) => ({ relay_id: r.relay_id, url: r.url, capability: r.capability }));
    }
  }

  function peer(row) {
    // Same organisation: the netmap already refuses another tenant's nodes.
    const pair = intersect(selfEffective, nodeEffective(row, orgAllowed));
    if (pair.length === 0) return null;
    const fields = { udp: pair.includes('udp') };
    if (versioned) {
      fields.allowed_transports = pair;
      if (pair.includes('derp')) {
        const homes = freshHomes(row, relayIds);
        if (homes.length > 0) fields.relay_homes = homes;
      }
    }
    return fields;
  }

  return { document, peer };
}

/**
 * Of the given node ids, those a caller with no node identity (the fleet token) may
 * be shown UDP endpoints for: nodes whose own organisation and binary allow UDP.
 */
async function udpReachable(nodeIds, client = null) {
  if (nodeIds.length === 0) return new Set();
  const rows = (
    await pool(client).query(
      `SELECT n.id, n.transports_built, n.node_capabilities, o.allowed_transports
         FROM nodes n LEFT JOIN organizations o ON o.id = COALESCE(n.organization_id, 'org-default')
        WHERE n.id = ANY($1::text[])`,
      [nodeIds]
    )
  ).rows;
  return new Set(rows.filter((r) => nodeEffective(r, r.allowed_transports).includes('udp')).map((r) => r.id));
}

// --- Relays -------------------------------------------------------------------

function hashCredential(credential) {
  return crypto.createHash('sha256').update(credential, 'utf8').digest('hex');
}

function mintCredential() {
  const credential = `nrr1_${crypto.randomBytes(32).toString('hex')}`;
  return { credential, hash: hashCredential(credential) };
}

/** A relay URL the node accepts (pool.go / transports.go) and that carries no secret. */
// The authority is checked on the raw string: WHATWG URL parsing repairs input that
// Go's net/url, which the node uses, reads differently (https:///derp has host "derp"
// here and no host there). A URL the node would refuse is a relay nobody can reach.
const RELAY_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/([A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9A-Fa-f]{2})*)?$/;

function validRelayUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || !RELAY_URL.test(value)) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  // Go's net/url refuses a port it cannot read as a 16-bit number.
  const explicit = /^https:\/\/[^/:]+:([0-9]+)/.exec(value);
  if (explicit && (Number(explicit[1]) < 1 || Number(explicit[1]) > 65535)) return false;
  return (
    u.protocol === 'https:' &&
    u.hostname !== '' &&
    u.username === '' &&
    u.password === '' &&
    u.search === '' &&
    u.hash === '' &&
    !value.includes('?') &&
    !value.includes('#')
  );
}

function publicRelay(row) {
  return {
    relay_id: row.relay_id,
    url: row.url,
    capability: row.capability,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    credential_rotated_at: row.credential_rotated_at
  };
}

class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function listRelays() {
  return (await getPgPool().query('SELECT * FROM transport_relays ORDER BY relay_id')).rows.map(publicRelay);
}

async function enabledCount(client) {
  return Number((await client.query('SELECT count(*) AS n FROM transport_relays WHERE enabled = TRUE')).rows[0].n);
}

async function createRelay({ relay_id: relayId, url }, actorId) {
  if (typeof relayId !== 'string' || !RELAY_ID.test(relayId)) throw new RelayError(400, 'invalid relay_id');
  if (!validRelayUrl(url)) throw new RelayError(400, 'relay url must be https with a host and no credentials');
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE transport_relays IN SHARE ROW EXCLUSIVE MODE');
    if ((await enabledCount(client)) >= MAX_ENABLED_RELAYS) {
      throw new RelayError(409, `at most ${MAX_ENABLED_RELAYS} relays may be enabled`);
    }
    const { credential, hash } = mintCredential();
    const res = await client.query(
      `INSERT INTO transport_relays (relay_id, url, credential_hash, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (relay_id) DO NOTHING RETURNING *`,
      [relayId, url, hash, actorId]
    );
    if (res.rowCount === 0) throw new RelayError(409, 'relay already exists');
    await AclEngine.bumpNetmap(client);
    await client.query('COMMIT');
    return { relay: publicRelay(res.rows[0]), credential };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function updateRelay(relayId, body) {
  const sets = [];
  const params = [relayId];
  if (body.url !== undefined) {
    if (!validRelayUrl(body.url)) throw new RelayError(400, 'relay url must be https with a host and no credentials');
    params.push(body.url);
    sets.push(`url = $${params.length}`);
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new RelayError(400, 'enabled must be a boolean');
    params.push(body.enabled);
    sets.push(`enabled = $${params.length}`);
  }
  if (sets.length === 0) throw new RelayError(400, 'nothing to update');
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE transport_relays IN SHARE ROW EXCLUSIVE MODE');
    const res = await client.query(
      `UPDATE transport_relays SET ${sets.join(', ')}, updated_at = NOW() WHERE relay_id = $1 RETURNING *`,
      params
    );
    if (res.rowCount === 0) throw new RelayError(404, 'relay not found');
    if ((await enabledCount(client)) > MAX_ENABLED_RELAYS) {
      throw new RelayError(409, `at most ${MAX_ENABLED_RELAYS} relays may be enabled`);
    }
    await AclEngine.bumpNetmap(client);
    await client.query('COMMIT');
    return publicRelay(res.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function rotateRelayCredential(relayId) {
  const { credential, hash } = mintCredential();
  const res = await getPgPool().query(
    `UPDATE transport_relays SET credential_hash = $2, credential_rotated_at = NOW(), updated_at = NOW()
      WHERE relay_id = $1 RETURNING *`,
    [relayId, hash]
  );
  if (res.rowCount === 0) throw new RelayError(404, 'relay not found');
  return { relay: publicRelay(res.rows[0]), credential };
}

/**
 * The relay named by a service credential, or null. Only the relay credential is
 * accepted: a fleet token, a node credential or a console session names no relay.
 */
async function authenticateRelay(authorization) {
  const match = /^Bearer (\S+)$/.exec(String(authorization || ''));
  if (!match || !RELAY_CREDENTIAL.test(match[1])) return null;
  const res = await getPgPool().query(
    'SELECT relay_id FROM transport_relays WHERE credential_hash = $1 AND enabled = TRUE',
    [hashCredential(match[1])]
  );
  return res.rows[0] ? res.rows[0].relay_id : null;
}

/**
 * The node keys a relay may admit. A key here grants a relay session, never a peer:
 * which peers a node may reach is still the netmap's decision alone.
 */
async function admissionSnapshot() {
  const top = ceiling();
  const generatedAt = Math.floor(Date.now() / 1000);
  let keys = [];
  if (top.includes('derp')) {
    const res = await getPgPool().query(
      `SELECT n.public_key
         FROM nodes n
         JOIN organizations o ON o.id = COALESCE(n.organization_id, 'org-default')
        WHERE n.is_quarantined = FALSE
          AND n.is_healthy = TRUE
          AND o.destroyed_at IS NULL
          AND $1 = ANY(n.node_capabilities)
          AND 'derp' = ANY(n.transports_built)
          AND 'derp' = ANY(COALESCE(o.allowed_transports, ARRAY['udp']::TEXT[]))`,
      [CAPABILITY]
    );
    const revoked = new Set(
      (await getPgPool().query('SELECT public_key_hex FROM revoked_keys WHERE expires_at > NOW()')).rows.map((r) =>
        String(r.public_key_hex).toLowerCase()
      )
    );
    keys = [
      ...new Set(
        res.rows
          .map((r) => normalisePublicKeyHex(r.public_key))
          .filter(Boolean)
          .map((k) => k.toLowerCase())
          .filter((k) => !revoked.has(k))
      )
    ].sort();
  }
  return { keys, generated_at_unix: generatedAt, max_staleness_seconds: admissionStalenessSeconds() };
}

// --- Organisation policy -------------------------------------------------------

async function getOrganisationPolicy(orgId) {
  const res = await getPgPool().query(
    'SELECT id, allowed_transports FROM organizations WHERE id = $1 AND destroyed_at IS NULL',
    [orgId]
  );
  if (!res.rows[0]) return null;
  const allowed = res.rows[0].allowed_transports;
  return {
    organization_id: orgId,
    allowed_transports: allowed == null ? null : canonical(allowed),
    ceiling: ceiling(),
    effective_transports: organisationEffective(allowed)
  };
}

async function setOrganisationPolicy(orgId, list) {
  const parsed = parseAdminList(list);
  if (!parsed)
    throw new RelayError(400, `allowed_transports must be a list of distinct values from ${KNOWN_TRANSPORTS}`);
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE organizations SET allowed_transports = $2, updated_at = NOW()
        WHERE id = $1 AND destroyed_at IS NULL RETURNING id`,
      [orgId, parsed]
    );
    if (res.rowCount === 0) throw new RelayError(404, 'Organization not found');
    await AclEngine.bumpNetmap(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getOrganisationPolicy(orgId);
}

let sweepTimer = null;

/** Expire unreported homes in the background. */
function startSweeper(intervalMs = 15000) {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    expireRelayHomes().catch((err) => logger.warn(`[TRANSPORT] relay home expiry failed: ${err.message}`));
  }, intervalMs);
  sweepTimer.unref();
}

function stopSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

module.exports = {
  CAPABILITY,
  KNOWN_TRANSPORTS,
  ceiling,
  canonical,
  parseAdminList,
  organisationEffective,
  recordNodeCapability,
  recordRelayHomes,
  expireRelayHomes,
  reconcileCeiling,
  planFor,
  udpReachable,
  listRelays,
  createRelay,
  updateRelay,
  rotateRelayCredential,
  authenticateRelay,
  admissionSnapshot,
  getOrganisationPolicy,
  setOrganisationPolicy,
  startSweeper,
  stopSweeper,
  RelayError,
  validRelayUrl
};
