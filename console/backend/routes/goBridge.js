/**
 * Go mesh data-plane bridge.
 *
 * Implements the wire contract the Go node speaks, defined by the typed structs in
 * pkg/control/server.go. The previous inline implementation in server.js invented its
 * own field names on both sides of both endpoints, which meant nothing crossed:
 *
 *   - It read `PublicKeyHex`; the node sends `public_key_hex`. Every registration
 *     stored a node with no public key, under the id `svrn-go-unknown-`.
 *   - It answered with `{NodeID, Status, SecretHex}`; the node decodes
 *     `RegisterResponse` (`assigned_node_id`, `overlay_ipv4`, ...). Every field came
 *     back as its zero value, which is why the node logged an empty Overlay VIP.
 *   - It read `NodeID` on heartbeat; the node sends `node_id`. The handler then hit
 *     `if (!NodeID) return res.json({Status: "ok"})` and discarded the heartbeat
 *     while answering 200, so neither side ever reported a problem.
 *   - It hardcoded `overlay_ipv6` to 'fd00::1' on a UNIQUE column, so the second node
 *     to register got a constraint violation and a 500. Only one Go node could ever
 *     exist.
 *
 * The net effect was 47 node rows against 7 telemetry rows, and a fleet that looked
 * registered without a single node holding an overlay address.
 */

const express = require('express');
const crypto = require('crypto');

const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const { allocateNextVip } = require('../utils/crypto');
const HeartbeatBuffer = require('../services/HeartbeatBuffer');
const AclEngine = require('../services/AclEngine');
const RouteEngine = require('../services/RouteEngine');
const config = require('../config/env');
const logger = require('../utils/logger');

const router = express.Router();

// The node derives its own id as pk_<first 8 bytes of the public key, hex>
// (control.GenerateNodeID). The control plane assigns the same value so that both
// sides agree on one identifier: the previous bridge minted `svrn-go-<...>` while the
// node kept calling itself `pk_<...>`, so even a correctly parsed heartbeat would have
// updated zero rows.
function deriveNodeId(publicKeyHex) {
  return `pk_${publicKeyHex.slice(0, 16).toLowerCase()}`;
}

const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/i;

/**
 * Resolve the account that owns bridge-enrolled nodes.
 *
 * nodes.user_id is a foreign key. The previous bridge hardcoded 'usr-admin-seed',
 * which exists on the staging PostgreSQL database and nowhere else -- on SQLite the
 * insert fails with an opaque FOREIGN KEY constraint error. Looking up the
 * super-admin works on any deployment; the env override is for installations that
 * want enrolled nodes attributed elsewhere.
 */
async function resolveOwnerId() {
  const configured = process.env.SOVEREIGN_GO_BRIDGE_OWNER_ID;

  if (configured) {
    const rows = await runQuery(
      'SELECT id FROM users WHERE id = $1',
      [configured],
      'SELECT id FROM users WHERE id = ?',
      [configured]
    );
    if (rows.length > 0) {
      return rows[0].id;
    }
    logger.warn(`SOVEREIGN_GO_BRIDGE_OWNER_ID='${configured}' does not exist; falling back to the super-admin account.`);
  }

  const admins = await runQuery(
    "SELECT id FROM users WHERE role = 'super-admin' ORDER BY created_at LIMIT 1",
    [],
    "SELECT id FROM users WHERE role = 'super-admin' ORDER BY created_at LIMIT 1",
    []
  );

  if (admins.length === 0) {
    const err = new Error('no super-admin account exists to own enrolled nodes');
    err.status = 503;
    throw err;
  }

  return admins[0].id;
}

/**
 * Reject registrations that do not carry the shared enrolment token.
 *
 * This endpoint writes to the node table and hands out overlay addresses. It had no
 * authentication of any kind, so anyone able to reach the port could enrol nodes into
 * the mesh and exhaust the address pool.
 */
function checkRegistrationToken(req) {
  const expected = process.env.SOVEREIGN_REGISTRATION_TOKEN;

  if (!expected) {
    if (config.IS_PRODUCTION) {
      return { ok: false, status: 503, error: 'node enrolment is disabled: SOVEREIGN_REGISTRATION_TOKEN is not set' };
    }
    // Development convenience only, and noisy on purpose.
    logger.warn('SOVEREIGN_REGISTRATION_TOKEN is not set - node enrolment is unauthenticated.');
    return { ok: true };
  }

  // Accept the token from the Authorization header or the request body. Only
  // RegisterRequest carries an auth_token field, so every other endpoint has to use
  // the header; register keeps working either way.
  const header = String(req.get('authorization') || '');
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const provided = bearer || req.body.auth_token || '';
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'invalid enrolment token' };
  }

  return { ok: true };
}

/** Run a query against whichever backend is configured. */
async function runQuery(pgSql, pgParams, sqliteSql, sqliteParams) {
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query(pgSql, pgParams);
    return res.rows;
  }

  const db = getDatabase();
  const statement = db.prepare(sqliteSql);
  if (/^\s*select/i.test(sqliteSql)) {
    return statement.all(...sqliteParams);
  }
  statement.run(...sqliteParams);
  return [];
}

// POST /v4/control/register
router.post('/register', async (req, res) => {
  try {
    const auth = checkRegistrationToken(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const publicKeyHex = String(req.body.public_key_hex || '').trim();
    if (!PUBLIC_KEY_RE.test(publicKeyHex)) {
      // A registration without a usable public key has no stable identity. The old
      // handler substituted a random string here and stored the result anyway.
      return res.status(400).json({ error: 'public_key_hex must be 64 hex characters' });
    }

    const role = String(req.body.role || 'CLIENT_ORIGIN');
    const capability = req.body.capability || {};
    const countryCode = String(capability.country_code || 'US').slice(0, 2).toUpperCase();
    const ipClass = String(capability.ip_class || 'RESIDENTIAL');
    const city = String(capability.city || '');
    const asn = Number.isFinite(capability.asn) ? capability.asn : 0;
    const endpoints = Array.isArray(req.body.endpoints) ? req.body.endpoints : [];

    const nodeId = deriveNodeId(publicKeyHex);
    const name = `Go-Node-${publicKeyHex.slice(0, 8)}`;
    const ownerId = await resolveOwnerId();

    // Re-registration must return the addresses the node already holds rather than
    // allocating new ones, otherwise every restart burns an address and orphans the
    // previous lease.
    const existing = await runQuery(
      'SELECT overlay_ipv4, overlay_ipv6 FROM nodes WHERE id = $1',
      [nodeId],
      'SELECT overlay_ipv4, overlay_ipv6 FROM nodes WHERE id = ?',
      [nodeId]
    );

    let overlayIpv4;
    let overlayIpv6;

    if (existing.length > 0) {
      overlayIpv4 = existing[0].overlay_ipv4;
      overlayIpv6 = existing[0].overlay_ipv6;
    } else {
      const vip = await allocateNextVip(isPostgres() ? getPgPool() : getDatabase());
      overlayIpv4 = vip.overlayIpv4;
      overlayIpv6 = vip.overlayIpv6;
    }

    const endpointsJson = JSON.stringify(endpoints);

    if (isPostgres()) {
      const pool = getPgPool();
      await pool.query(
        `INSERT INTO nodes (
           id, user_id, name, role, ip_class, country_code, city, asn,
           is_healthy, public_key, overlay_ipv4, overlay_ipv6, endpoints
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, $10, $11, $12::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           is_healthy = TRUE,
           role = EXCLUDED.role,
           ip_class = EXCLUDED.ip_class,
           country_code = EXCLUDED.country_code,
           endpoints = EXCLUDED.endpoints,
           updated_at = NOW()`,
        [nodeId, ownerId, name, role, ipClass, countryCode, city, asn,
         publicKeyHex, overlayIpv4, overlayIpv6, endpointsJson]
      );
    } else {
      const db = getDatabase();
      db.prepare(
        `INSERT INTO nodes (
           id, user_id, name, role, ip_class, country_code, city, asn,
           is_healthy, public_key, overlay_ipv4, overlay_ipv6, endpoints
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           is_healthy = 1,
           role = excluded.role,
           ip_class = excluded.ip_class,
           country_code = excluded.country_code,
           endpoints = excluded.endpoints,
           updated_at = CURRENT_TIMESTAMP`
      ).run(nodeId, ownerId, name, role, ipClass, countryCode, city, asn,
            publicKeyHex, overlayIpv4, overlayIpv6, endpointsJson);
    }

    // Rules expand to one entry per peer, so the compiled policy changes when the
    // fleet changes, not only when the rules do. Missing this is the subtle failure:
    // rules stay identical while the peers they expand to do not.
    if (existing.length === 0) {
      await AclEngine.bumpEpoch('acl');
    }

    logger.info(`[GO-BRIDGE] Registered ${nodeId} (${role}) with overlay ${overlayIpv4} / ${overlayIpv6}`);

    // Field names and shape must match control.RegisterResponse exactly.
    return res.json({
      assigned_node_id: nodeId,
      overlay_ipv4: overlayIpv4,
      overlay_ipv6: overlayIpv6,
      relays: [],
      lease_expiry_utc: Math.floor(Date.now() / 1000) + 86400,
      network_psk_hex: '',
      policy_epoch: 0,
      route_epoch: 0
    });
  } catch (err) {
    logger.error(`[GO-BRIDGE] Registration failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /v4/control/heartbeat
router.post('/heartbeat', async (req, res) => {
  try {
    const nodeId = String(req.body.node_id || '').trim();
    if (!nodeId) {
      // Answering 200 to a heartbeat that was thrown away is how this went unnoticed
      // for so long: neither side logged anything.
      return res.status(400).json({ error: 'node_id is required' });
    }

    const cpuPct = clampNumber(req.body.cpu_usage_pct, 0, 100, 0);
    const memMb = clampNumber(req.body.memory_usage_mb, 0, Number.MAX_SAFE_INTEGER, 0);
    const batteryPct = clampNumber(req.body.battery_level_pct, 0, 100, 100);
    const txBytes = clampNumber(req.body.tx_bytes_sec, 0, Number.MAX_SAFE_INTEGER, 0);
    const rxBytes = clampNumber(req.body.rx_bytes_sec, 0, Number.MAX_SAFE_INTEGER, 0);

    // The node must exist before its heartbeat is buffered, otherwise an unknown id
    // accumulates state that no flush can ever apply.
    const known = await runQuery(
      'SELECT is_quarantined, quarantine_reason FROM nodes WHERE id = $1',
      [nodeId],
      'SELECT is_quarantined, quarantine_reason FROM nodes WHERE id = ?',
      [nodeId]
    );

    if (known.length === 0) {
      return res.status(404).json({ error: `unknown node_id ${nodeId}` });
    }

    // Buffered rather than written straight through: at 100,000 nodes beating every
    // 15 seconds this endpoint alone would be 6,667 UPDATEs per second against a
    // table with 11 indexes. See services/HeartbeatBuffer.js.
    //
    // latency_ms is deliberately never written. The previous handler set it to
    // `floor(random() * 50 + 10)` on every heartbeat, so the console displayed an
    // invented round-trip time for every node in the fleet. The node does not measure
    // RTT yet; showing nothing is correct until it does.
    const buffered = await HeartbeatBuffer.record(nodeId, {
      txBytes,
      rxBytes,
      cpuPct,
      memMb,
      batteryPct
    });

    if (!buffered) {
      // Valkey unavailable: fall back to writing through, so a cache outage costs
      // throughput rather than telemetry.
      await runQuery(
        `UPDATE nodes SET
         tx_bytes = tx_bytes + $1,
         rx_bytes = rx_bytes + $2,
         cpu_usage_pct = $3,
         memory_usage_pct = $4,
         battery_pct = $5,
         is_healthy = TRUE,
         last_heartbeat = NOW(),
         updated_at = NOW()
       WHERE id = $6`,
        [txBytes, rxBytes, cpuPct, memMb, batteryPct, nodeId],
        `UPDATE nodes SET
         tx_bytes = tx_bytes + ?,
         rx_bytes = rx_bytes + ?,
         cpu_usage_pct = ?,
         memory_usage_pct = ?,
         battery_pct = ?,
         is_healthy = 1,
         last_heartbeat = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
        [txBytes, rxBytes, cpuPct, memMb, batteryPct, nodeId]
      );
    }

    const quarantined = Boolean(known[0].is_quarantined);
    const quarantineReason = known[0].quarantine_reason || '';

    // Shape must match control.HeartbeatResponse.
    return res.json({
      acknowledged: true,
      force_rekey: false,
      drain_and_exit: false,
      revoked_keys: [],
      is_quarantined: quarantined,
      quarantine_reason: quarantineReason,
      policy_epoch: 0,
      route_epoch: 0
    });
  } catch (err) {
    logger.error(`[GO-BRIDGE] Heartbeat failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /v4/control/discover
//
// Peer and bridge discovery. Until this existed a node enrolled, received an overlay
// address, and then had no way to learn that any other node existed -- so there was
// no mesh, only a registration table that the console drew as a topology.
//
// Requires the enrolment token: this returns the node inventory, including public
// keys and endpoints, which is not something an unauthenticated caller should be able
// to enumerate.
router.post('/discover', async (req, res) => {
  try {
    const auth = checkRegistrationToken(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const targetCountry = String(req.body.target_country || '').slice(0, 2).toUpperCase();
    const targetAsn = Number(req.body.target_asn) || 0;
    const ipClass = String(req.body.ip_class || '').toUpperCase();
    const explicitHostId = String(req.body.explicit_host_id || '').trim();
    const limit = clampNumber(req.body.limit, 1, 100, 20);

    // Only healthy, unquarantined relays and exit bridges are routable. A client
    // origin has nothing to offer another node.
    const filters = ["role IN ('EXIT_BRIDGE', 'RELAY', 'HYBRID')", 'is_healthy = TRUE', 'is_quarantined = FALSE'];
    const params = [];

    const add = (clause, value) => {
      params.push(value);
      filters.push(clause.replace('$$', `$${params.length}`));
    };

    if (explicitHostId) add('id = $$', explicitHostId);
    if (targetCountry) add('country_code = $$', targetCountry);
    if (targetAsn) add('asn = $$', targetAsn);
    if (ipClass) add('ip_class = $$', ipClass);

    const where = filters.join(' AND ');

    // Ordering is the routing decision: prefer low latency, then low risk. Nodes that
    // have never reported are ranked last rather than excluded, so a fresh mesh still
    // discovers its own members.
    const order = `ORDER BY
      (last_heartbeat IS NULL) ASC,
      latency_ms ASC,
      risk_score ASC,
      created_at ASC`;

    const pgSql = `SELECT id, public_key, overlay_ipv4, endpoints, country_code, city, asn,
                          ip_class, latency_ms, risk_score, last_heartbeat
                     FROM nodes WHERE ${where} ${order} LIMIT $${params.length + 1}`;

    const sqliteSql = pgSql.replace(/\$\d+/g, '?').replace(/TRUE/g, '1').replace(/FALSE/g, '0');

    const rows = await runQuery(pgSql, [...params, limit], sqliteSql, [...params, limit]);

    const bridges = rows.map((row, index) => ({
      node_id: row.id,
      public_key_hex: row.public_key,
      overlay_ipv4: row.overlay_ipv4,
      endpoints: parseEndpoints(row.endpoints),
      capability: {
        enabled: true,
        country_code: row.country_code || 'US',
        city: row.city || '',
        asn: Number(row.asn) || 0,
        ip_class: row.ip_class || 'RESIDENTIAL',
        max_bandwidth_kbps: 0,
        max_concurrent_streams: 0,
        allow_udp: true,
        ac_power_only: false
      },
      // Descending, so the first result scores highest. The ordering above already
      // encodes the preference; this exposes it to a client that wants to re-rank.
      score: Number((1 - index / Math.max(rows.length, 1)).toFixed(4))
    }));

    return res.json({ bridges });
  } catch (err) {
    logger.error(`[GO-BRIDGE] Discovery failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /v4/control/sync-acls
//
// Policy delivery. pkg/acl compiles and enforces zero-trust policy correctly and was
// handed nothing, because this endpoint did not exist -- so every rule configured in
// the console had no effect on any node.
//
// The node sends the epoch it currently holds. An unchanged epoch is answered without
// compiling or transferring a policy: at fleet scale that is the difference between
// every node pulling a full policy every 15 seconds and almost none of them doing so.
router.post('/sync-acls', async (req, res) => {
  try {
    const auth = checkRegistrationToken(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const nodeId = String(req.body.node_id || '').trim();
    if (!nodeId) {
      return res.status(400).json({ error: 'node_id is required' });
    }

    const currentEpoch = Number(req.body.policy_epoch) || 0;
    const epoch = await AclEngine.getEpoch('acl');

    if (currentEpoch === epoch) {
      // Up to date. A null policy tells the client to keep what it has; sending the
      // same policy again would be a full transfer to say nothing changed.
      return res.json({ new_policy_epoch: epoch, policy: null });
    }

    const policy = await AclEngine.compilePolicyFor(nodeId);
    if (!policy) {
      return res.status(404).json({ error: `unknown node_id ${nodeId}` });
    }

    return res.json({ new_policy_epoch: policy.epoch, policy });
  } catch (err) {
    logger.error(`[GO-BRIDGE] ACL sync failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /v4/control/sync-routes
//
// Subnet route delivery. A route says "this subnet is reachable through these peers".
// Nodes could never learn that, because this endpoint did not exist.
//
// Same epoch protocol as ACL sync: an unchanged epoch is answered without building or
// transferring the route set.
router.post('/sync-routes', async (req, res) => {
  try {
    const auth = checkRegistrationToken(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const nodeId = String(req.body.node_id || '').trim();
    if (!nodeId) {
      return res.status(400).json({ error: 'node_id is required' });
    }

    const currentEpoch = Number(req.body.route_epoch) || 0;
    const epoch = await AclEngine.getEpoch('routes');

    if (currentEpoch === epoch) {
      return res.json({ new_route_epoch: epoch, routes: [] });
    }

    const known = await runQuery(
      'SELECT id FROM nodes WHERE id = $1',
      [nodeId],
      'SELECT id FROM nodes WHERE id = ?',
      [nodeId]
    );

    if (known.length === 0) {
      return res.status(404).json({ error: `unknown node_id ${nodeId}` });
    }

    return res.json({ new_route_epoch: epoch, routes: await RouteEngine.routesFor(nodeId) });
  } catch (err) {
    logger.error(`[GO-BRIDGE] Route sync failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/** Endpoints are JSONB on PostgreSQL and a TEXT column on SQLite. */
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

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

module.exports = router;
module.exports.deriveNodeId = deriveNodeId;
