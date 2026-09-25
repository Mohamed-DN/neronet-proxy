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

const { getPgPool } = require('../db/index');
const { allocateNextVip, normalisePublicKeyHex } = require('../utils/crypto');
const { buildPostureDocument } = require('../utils/posture');
const HeartbeatBuffer = require('../services/HeartbeatBuffer');
const AclEngine = require('../services/AclEngine');
const RouteEngine = require('../services/RouteEngine');
const RevocationEngine = require('../services/RevocationEngine');
const NetmapService = require('../services/NetmapService');
const ControlPlaneKeyService = require('../services/ControlPlaneKeyService');
const PreAuthKeyService = require('../services/PreAuthKeyService');
const NodeCredentialService = require('../services/NodeCredentialService');
const config = require('../config/env');
const logger = require('../utils/logger');
const { logAuditEvent } = require('../utils/audit');
const { validateRequest, responseValidationInterceptor } = require('../middleware/contractValidator');

const router = express.Router();

router.use(
  responseValidationInterceptor({
    '/challenge': 'ChallengeResponse',
    '/register': 'RegisterResponse',
    '/heartbeat': 'HeartbeatResponse',
    '/discover': 'DiscoverResponse',
    '/circuit': 'CircuitResponse',
    '/sync-acls': 'ACLSyncResponse',
    '/sync-routes': 'RouteSyncResponse',
    '/netmap': 'NetmapResponse'
  })
);

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
    logger.warn(
      `SOVEREIGN_GO_BRIDGE_OWNER_ID='${configured}' does not exist; falling back to the super-admin account.`
    );
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
/**
 * Authenticates node requests on /v4/control/* endpoints.
 *
 * Implements ADR 0017 (Node Identity v2):
 * - Accepts 256-bit bearer node credentials (nnt1_<hex>)
 * - Enforces node ID invariance: request body node_id must match authenticated identity (403 Forbidden)
 * - Validates credential revocation and expiration (401 Unauthorized)
 * - Retains legacy registration token support during transition and development
 */
async function checkNodeAuth(req) {
  const header = String(req.get('authorization') || '').trim();
  let bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!bearer && req.body && req.body.credential) {
    bearer = String(req.body.credential).trim();
  }
  if (!bearer && req.body && req.body.auth_token) {
    bearer = String(req.body.auth_token).trim();
  }

  // 1. Node Credential (nnt1_...)
  if (bearer && bearer.startsWith('nnt1_')) {
    const credResult = await NodeCredentialService.validateCredential(bearer);
    if (!credResult.ok) {
      return { ok: false, status: credResult.status || 401, error: credResult.error || 'invalid node credential' };
    }

    const node = credResult.node;
    const bodyNodeId = req.body && req.body.node_id ? String(req.body.node_id).trim() : null;
    const queryNodeId = req.query && req.query.node_id ? String(req.query.node_id).trim() : null;
    const declaredNodeId = bodyNodeId || queryNodeId;

    if (declaredNodeId && declaredNodeId !== node.id) {
      logger.warn(`Node identity spoofing attempted: credential for ${node.id} attempted to act as ${declaredNodeId}`);
      return { ok: false, status: 403, error: 'forbidden: credential belongs to another node' };
    }

    req.node = node;
    return { ok: true, node, token: bearer };
  }

  // 2. Shared Registration Token fallback
  const expected = process.env.SOVEREIGN_REGISTRATION_TOKEN;
  if (!expected) {
    if (config.IS_PRODUCTION) {
      return { ok: false, status: 401, error: 'node credential required (Authorization: Bearer <token>)' };
    }
    logger.warn('SOVEREIGN_REGISTRATION_TOKEN is not set - node control request permitted in dev.');
    return { ok: true, legacy: true };
  }

  if (!bearer) {
    return { ok: false, status: 401, error: 'node credential or enrolment token required' };
  }

  const a = Buffer.from(String(bearer), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'invalid enrolment token' };
  }

  return { ok: true, legacy: true };
}

function checkRegistrationToken(req) {
  return checkNodeAuth(req);
}

/** Run a query against the PostgreSQL database. */
async function runQuery(pgSql, pgParams = []) {
  const pool = getPgPool();
  const res = await pool.query(pgSql, pgParams);
  return res.rows;
}

// POST /v4/control/challenge
router.post('/challenge', validateRequest('ChallengeRequest'), async (req, res) => {
  try {
    const challenge = await ControlPlaneKeyService.createChallenge();
    return res.json({
      nonce: challenge.nonce,
      cp_public_key: challenge.cp_public_key,
      expires_at: challenge.expires_at
    });
  } catch (err) {
    logger.error(`[GO-BRIDGE] Challenge generation failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /v4/control/register
// Normalize endpoints field: Go sends {} when empty (omitempty quirk), schema requires array
const normalizeRegisterBody = (req, _res, next) => {
  if (req.body && req.body.endpoints !== undefined && !Array.isArray(req.body.endpoints)) {
    req.body.endpoints = [];
  }
  next();
};

router.post('/register', normalizeRegisterBody, validateRequest('RegisterRequest'), async (req, res) => {
  try {
    const publicKeyHex = String(req.body.public_key_hex || '').trim();
    if (!PUBLIC_KEY_RE.test(publicKeyHex)) {
      // A registration without a usable public key has no stable identity. The old
      // handler substituted a random string here and stored the result anyway.
      return res.status(400).json({ error: 'public_key_hex must be 64 hex characters' });
    }

    const nodeId = deriveNodeId(publicKeyHex);
    let ownerId = null;

    // Check if node exists already (needed for owner check & role check)
    const existing = await runQuery(
      'SELECT overlay_ipv4, overlay_ipv6, role, ip_class, country_code, latitude, longitude, user_id FROM nodes WHERE id = $1',
      [nodeId]
    );

    // Node Identity v2: Pre-auth key & Proof of possession
    if (req.body.proof || req.body.nonce || req.body.preauth_key) {
      const nonce = String(req.body.nonce || '').trim();
      const proof = String(req.body.proof || '').trim();
      const preauthKey = String(req.body.preauth_key || '').trim();

      if (!nonce || !proof) {
        return res.status(401).json({ error: 'nonce and proof are required for proof of possession' });
      }
      if (!preauthKey) {
        return res.status(401).json({ error: 'preauth_key is required' });
      }

      // 1. Consume challenge nonce (single-use anti-replay)
      const consumed = await ControlPlaneKeyService.consumeChallenge(nonce);
      if (!consumed) {
        return res.status(401).json({ error: 'invalid or expired challenge nonce' });
      }

      // 2. Verify proof of possession
      const validProof = ControlPlaneKeyService.verifyProof(publicKeyHex, nonce, proof);
      if (!validProof) {
        return res.status(401).json({ error: 'invalid proof of possession' });
      }

      // 3. Validate pre-auth key
      const requestedRole = String(req.body.role || 'CLIENT_ORIGIN');
      const preauthResult = await PreAuthKeyService.validateAndConsumePreAuthKey(preauthKey, requestedRole);
      if (!preauthResult.ok) {
        return res.status(preauthResult.status || 401).json({ error: preauthResult.error });
      }

      ownerId = preauthResult.key.owner_id;

      // 4. Invariance: if node already exists, owner must match
      if (existing.length > 0 && existing[0].user_id && existing[0].user_id !== ownerId) {
        return res.status(403).json({ error: 'pre-auth key owner does not match existing node owner' });
      }
    } else {
      // Legacy fallback
      const auth = await checkNodeAuth(req);
      if (!auth.ok) {
        return res.status(auth.status).json({ error: auth.error });
      }
      ownerId = await resolveOwnerId();
    }

    const role = String(req.body.role || 'CLIENT_ORIGIN');
    const capability = req.body.capability || {};
    const countryCode = String(capability.country_code || 'US')
      .slice(0, 2)
      .toUpperCase();
    // UNKNOWN, not RESIDENTIAL. Nothing classifies a node's uplink, and a node that
    // does not declare one is not evidence of a domestic line.
    const ipClass = String(capability.ip_class || 'UNKNOWN');
    const city = String(capability.city || '')
      .trim()
      .slice(0, 128);
    // City and coordinates are what the operator typed into the node's configuration.
    // Nothing verifies them, so they are stored as declared and reported as such.
    const declared = parseDeclaredCoordinates(capability);
    if (declared.error) {
      return res.status(400).json({ error: declared.error });
    }
    const asn = Number.isFinite(capability.asn) ? capability.asn : 0;
    const endpoints = Array.isArray(req.body.endpoints) ? req.body.endpoints : [];

    const name = `Go-Node-${publicKeyHex.slice(0, 8)}`;

    // Re-registration must return the addresses the node already holds rather than
    // allocating new ones, otherwise every restart burns an address and orphans the
    // previous lease.
    let overlayIpv4;
    let overlayIpv6;

    if (existing.length > 0) {
      overlayIpv4 = existing[0].overlay_ipv4;
      overlayIpv6 = existing[0].overlay_ipv6;
    } else {
      const vip = await allocateNextVip(getPgPool());
      overlayIpv4 = vip.overlayIpv4;
      overlayIpv6 = vip.overlayIpv6;
    }

    const endpointsJson = JSON.stringify(endpoints);

    // On conflict only is_healthy, endpoints and updated_at are written.
    //
    // Registration is authenticated by one fleet-wide token and a public key is not
    // a secret, so re-registering somebody else's key used to rewrite that node's
    // role -- to EXIT_BRIDGE, which puts it on the exit path -- and its country,
    // which is what geofencing decides on. Until WP-103 makes a node prove
    // possession of its key, those three columns are set at first enrolment and
    // changed only through the authenticated console API. Endpoints are different:
    // they change whenever the node moves, and a wrong one costs reachability
    // rather than policy.
    const mismatch =
      existing.length > 0 ? describeMismatch(existing[0], { role, ipClass, countryCode, declared }) : null;

    const pool = getPgPool();
    await pool.query(
      `INSERT INTO nodes (
         id, user_id, name, role, ip_class, country_code, city, asn,
         is_healthy, public_key, overlay_ipv4, overlay_ipv6, endpoints
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, $10, $11, $12::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         is_healthy = TRUE,
         endpoints = EXCLUDED.endpoints,
         updated_at = NOW()`,
      [
        nodeId,
        ownerId,
        name,
        role,
        ipClass,
        countryCode,
        city,
        asn,
        publicKeyHex,
        overlayIpv4,
        overlayIpv6,
        endpointsJson
      ]
    );

    // The declared position is written only while the row has none, which is the
    // same rule the country follows: a re-registration cannot move an enrolled node.
    // A node enrolled before it could declare a position gets one the first time it
    // does; a different value later is recorded by describeMismatch and not applied.
    if (declared.latitude !== null) {
      await runQuery(
        `UPDATE nodes SET
           latitude = $1,
           longitude = $2,
           city = CASE WHEN city IS NULL OR city = '' THEN $3 ELSE city END,
           metadata = metadata || '{"location_source":"declared"}'::jsonb
         WHERE id = $4 AND latitude IS NULL AND longitude IS NULL`,
        [declared.latitude, declared.longitude, city, nodeId],
        `UPDATE nodes SET
           latitude = ?,
           longitude = ?,
           city = CASE WHEN city IS NULL OR city = '' THEN ? ELSE city END,
           metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.location_source', 'declared')
         WHERE id = ? AND latitude IS NULL AND longitude IS NULL`,
        [declared.latitude, declared.longitude, city, nodeId]
      );
    }

    // Recorded rather than refused: the node is told nothing and keeps running with
    // the attributes the control plane holds, so a node with a stale configuration
    // still enrols, while an attempt to move a node onto the exit path leaves a
    // trace. Written after the upsert, so a failed write does not leave an event
    // describing a change that did not happen.
    if (mismatch) {
      await logAuditEvent({
        eventType: 'node.reregister_mismatch',
        severity: 'warn',
        targetId: nodeId,
        targetType: 'node',
        message: `Re-registration of ${nodeId} asked for ${mismatch.changed.join(', ')} different from the stored value; the stored values were kept`,
        ipAddress: req.ip,
        metadata: mismatch
      });
    }

    // Rules expand to one entry per peer, so the compiled policy changes when the
    // fleet changes, not only when the rules do. Missing this is the subtle failure:
    // rules stay identical while the peers they expand to do not.
    if (existing.length === 0) {
      await AclEngine.bumpEpoch('acl');
    }

    const cred = await NodeCredentialService.mintCredential(nodeId);

    logger.info(`[GO-BRIDGE] Registered ${nodeId} (${role}) with overlay ${overlayIpv4} / ${overlayIpv6}`);

    // Field names and shape must match control.RegisterResponse exactly.
    return res.json({
      assigned_node_id: nodeId,
      overlay_ipv4: overlayIpv4,
      overlay_ipv6: overlayIpv6,
      relays: [],
      lease_expiry_utc: Math.floor(Date.now() / 1000) + 86400,
      network_psk_hex: '',
      // Real epochs, not zero. The node stores these and compares later heartbeats
      // against them; returning 0 here made `hbResp.PolicyEpoch > policyEpoch`
      // permanently false, so a running node never learned that an ACL rule had
      // changed. Policy delivery worked at enrolment and never again.
      policy_epoch: await AclEngine.getEpoch('acl'),
      route_epoch: await AclEngine.getEpoch('routes'),
      credential: cred.credential,
      credential_expires_at: cred.expiresAt
    });
  } catch (err) {
    logger.error(`[GO-BRIDGE] Registration failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /v4/control/heartbeat
router.post('/heartbeat', normalizeRegisterBody, validateRequest('HeartbeatRequest'), async (req, res) => {
  try {
    const auth = await checkNodeAuth(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

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
    // Capped at a minute: a larger value is a broken clock or a forged body, not a
    // round trip, and it would drag every average that reads this column.
    const rttMs = clampNumber(req.body.rtt_ms, 0, 60000, 0);

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

    // The attestation the node sends with every beat. It was decoded off the wire and
    // then dropped on the floor, which is why posture_checks on every row still held
    // the schema's fabricated default. Null for anything the node did not measure;
    // null for the whole document when it sent no attestation, so a beat without one
    // leaves the stored posture alone rather than blanking it.
    const posture = buildPostureDocument(req.body.posture);

    // Buffered rather than written straight through: at 100,000 nodes beating every
    // 15 seconds this endpoint alone would be 6,667 UPDATEs per second against a
    // table with 11 indexes. See services/HeartbeatBuffer.js.
    //
    // latency_ms carries the round trip the node measured on its previous heartbeat.
    // An earlier handler filled this column with `floor(random() * 50 + 10)`, so the
    // console showed an invented figure for every node; it was then left unwritten
    // until the node could measure something real, which pkg/control/client.go now
    // does. A node that has not measured one yet sends 0 and the column stays empty.
    const buffered = await HeartbeatBuffer.record(nodeId, {
      txBytes,
      rxBytes,
      cpuPct,
      memMb,
      batteryPct,
      rttMs,
      posture
    });

    if (!buffered) {
      // Valkey unavailable: fall back to writing through, so a cache outage costs
      // throughput rather than telemetry. COALESCE keeps the stored posture when this
      // beat carried no attestation.
      const postureJson = posture === null ? null : JSON.stringify(posture);

      await runQuery(
        `UPDATE nodes SET
         tx_bytes = tx_bytes + $1,
         rx_bytes = rx_bytes + $2,
         cpu_usage_pct = $3,
         memory_usage_pct = $4,
         battery_pct = $5,
         latency_ms = $6,
         posture_checks = COALESCE($7::jsonb, posture_checks),
         is_healthy = TRUE,
         last_heartbeat = NOW(),
         updated_at = NOW()
       WHERE id = $8`,
        [txBytes, rxBytes, cpuPct, memMb, batteryPct, rttMs, postureJson, nodeId],
        `UPDATE nodes SET
         tx_bytes = tx_bytes + ?,
         rx_bytes = rx_bytes + ?,
         cpu_usage_pct = ?,
         memory_usage_pct = ?,
         battery_pct = ?,
         latency_ms = ?,
         posture_checks = COALESCE(?, posture_checks),
         is_healthy = 1,
         last_heartbeat = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
        [txBytes, rxBytes, cpuPct, memMb, batteryPct, rttMs, postureJson, nodeId]
      );
    }

    // Endpoint intake. Nothing told a node where a peer actually is: the registration
    // accepted an endpoint list and then nothing ever updated it, so a node that moved
    // was unreachable until it re-enrolled. The node now reports its candidates on
    // every beat, and the control plane validates them before any other node is told
    // to dial them.
    //
    // A rejected candidate is logged with its reason rather than silently dropped, and
    // it never fails the heartbeat: telemetry from a node with one bad address is
    // still telemetry.
    const endpointResult = await NetmapService.recordEndpoints(nodeId, req.body.endpoints);
    if (endpointResult.rejected.length > 0 || endpointResult.truncated) {
      const reasons = endpointResult.rejected.map((r) => `${r.entry} (${r.reason})`).join(', ');
      logger.warn(
        `[GO-BRIDGE] ${nodeId} reported ${endpointResult.rejected.length} unusable endpoint(s)` +
          `${endpointResult.truncated ? ` and more than ${NetmapService.MAX_ENDPOINTS}` : ''}` +
          `${reasons ? `: ${reasons}` : ''}`
      );
    }

    const quarantined = Boolean(known[0].is_quarantined);
    const quarantineReason = known[0].quarantine_reason || '';

    let rotatedCred = null;
    if (auth.token && auth.node && auth.node.credentialId) {
      const rot = await NodeCredentialService.checkAndRotateCredential(auth.node.credentialId, nodeId);
      if (rot.rotated) {
        rotatedCred = rot;
      }
    }

    const responsePayload = {
      acknowledged: true,
      force_rekey: false,
      drain_and_exit: false,
      // The only channel that reaches a running node. It was always empty, so
      // revoking a peering agreement changed a database row and left the tunnel up.
      revoked_keys: await RevocationEngine.activeRevocations(),
      is_quarantined: quarantined,
      quarantine_reason: quarantineReason,
      // This is the only channel that tells a running node its policy is stale.
      policy_epoch: await AclEngine.getEpoch('acl'),
      route_epoch: await AclEngine.getEpoch('routes'),
      // The one number a node with the data plane on compares against what it holds.
      // It replaces both epochs above on the node side; they stay on the wire for a
      // node running without the data plane.
      netmap_version: await NetmapService.getVersion()
    };

    if (rotatedCred) {
      responsePayload.new_credential = rotatedCred.new_credential;
      responsePayload.credential_expires_at = rotatedCred.credential_expires_at;
    }

    return res.json(responsePayload);
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
router.post('/discover', validateRequest('DiscoverRequest'), async (req, res) => {
  try {
    const auth = await checkNodeAuth(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const targetCountry = String(req.body.target_country || '')
      .slice(0, 2)
      .toUpperCase();
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

    const rows = await runQuery(pgSql, [...params, limit]);

    // The nodes table holds hex from Go nodes and base64 from console-minted keys.
    // The wire field is public_key_hex, so the base64 form must be converted or the
    // node receives a key it cannot decode.
    const bridges = rows
      .map((row) => ({ ...row, public_key_hex: normalisePublicKeyHex(row.public_key) }))
      .filter((row) => row.public_key_hex !== null)
      .map((row, index) => ({
        node_id: row.id,
        public_key_hex: row.public_key_hex,
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
router.post('/sync-acls', validateRequest('ACLSyncRequest'), async (req, res) => {
  try {
    const auth = await checkNodeAuth(req);
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
router.post('/sync-routes', validateRequest('RouteSyncRequest'), async (req, res) => {
  try {
    const auth = await checkNodeAuth(req);
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

    const known = await runQuery('SELECT id FROM nodes WHERE id = $1', [nodeId], 'SELECT id FROM nodes WHERE id = ?', [
      nodeId
    ]);

    if (known.length === 0) {
      return res.status(404).json({ error: `unknown node_id ${nodeId}` });
    }

    return res.json({ new_route_epoch: epoch, routes: await RouteEngine.routesFor(nodeId) });
  } catch (err) {
    logger.error(`[GO-BRIDGE] Route sync failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /v4/control/netmap
//
// One complete document per node: this node's overlay addresses, the peers it may
// talk to with their keys and endpoints, the compiled policy its filter enforces, the
// routes it installs, and the keys it must drop. It is what replaces the peer file
// the WP-201 spike read from disk.
//
// The node sends the version it holds. An unchanged version is answered with a flag
// and nothing else: at fleet scale the alternative is every node pulling its whole
// peer set every fifteen seconds.
//
// Authenticated like /v4/control/sync-acls, which is the fleet-wide enrolment token.
// That token does not bind a request to a node, so any node holding it can ask for
// any other node's netmap. This is the same limitation the ACL and route endpoints
// already have and it is WP-103's to close; it is recorded in ADR 0020 rather than
// papered over here.
router.post('/netmap', validateRequest('NetmapRequest'), async (req, res) => {
  try {
    const auth = await checkNodeAuth(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const nodeId = String(req.body.node_id || '').trim();
    if (!nodeId) {
      return res.status(400).json({ error: 'node_id is required' });
    }

    const held = Number(req.body.version) || 0;
    const version = await NetmapService.getVersion();

    if (held === version) {
      return res.json({ version, unchanged: true });
    }

    const netmap = await NetmapService.buildNetmap(nodeId);
    if (!netmap) {
      return res.status(404).json({ error: `unknown node_id ${nodeId}` });
    }

    // Added here rather than in the service so that two builds of the same database
    // state are byte-identical and the determinism can be asserted on the bytes.
    netmap.generated_at_unix = Math.floor(Date.now() / 1000);

    return res.json(netmap);
  } catch (err) {
    logger.error(`[GO-BRIDGE] Netmap build failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// Note: /v4/control/circuit is handled by the discrete onion feature module (WP-107)

/**
 * Compare what a re-registration asks for against what is stored.
 *
 * Returns null when they agree, so an ordinary re-enrolment writes no audit event
 * and the ledger holds only the attempts that wanted something changed.
 */
function describeMismatch(stored, requested) {
  const fields = [
    ['role', stored.role, requested.role],
    ['ip_class', stored.ip_class, requested.ipClass],
    ['country_code', stored.country_code, requested.countryCode]
  ];

  const changed = fields.filter(([, was, asked]) => was !== asked).map(([field]) => field);

  // A node that declares a position when the row already holds one. The columns are
  // single-precision on PostgreSQL, hence the tolerance.
  const declared = requested.declared;
  const moved =
    declared &&
    declared.latitude !== null &&
    stored.latitude !== null &&
    stored.longitude !== null &&
    (Math.abs(Number(stored.latitude) - declared.latitude) > COORDINATE_TOLERANCE ||
      Math.abs(Number(stored.longitude) - declared.longitude) > COORDINATE_TOLERANCE);
  if (moved) changed.push('latitude', 'longitude');

  if (changed.length === 0) return null;

  const storedValues = { role: stored.role, ip_class: stored.ip_class, country_code: stored.country_code };
  const requestedValues = { role: requested.role, ip_class: requested.ipClass, country_code: requested.countryCode };
  if (moved) {
    storedValues.latitude = Number(stored.latitude);
    storedValues.longitude = Number(stored.longitude);
    requestedValues.latitude = declared.latitude;
    requestedValues.longitude = declared.longitude;
  }

  return { changed, stored: storedValues, requested: requestedValues };
}

// Degrees. Larger than the single-precision rounding of the REAL columns, smaller than
// anything a person would type as a different place.
const COORDINATE_TOLERANCE = 0.001;

/**
 * Read the declared latitude and longitude from a registration's capability object.
 *
 * Both absent means the node declared nothing. Anything else must be a pair of JSON
 * numbers inside the geographic range: half a coordinate, a string or an out-of-range
 * value is refused, not stored as something plausible.
 */
function parseDeclaredCoordinates(capability) {
  const lat = capability.latitude;
  const lon = capability.longitude;
  const absent = (v) => v === undefined || v === null;

  if (absent(lat) && absent(lon)) return { latitude: null, longitude: null };
  if (absent(lat) || absent(lon)) {
    return { error: 'latitude and longitude must be declared together' };
  }
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { error: 'latitude and longitude must be numbers' };
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { error: 'latitude must be within [-90, 90] and longitude within [-180, 180]' };
  }
  return { latitude: lat, longitude: lon };
}

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
