/**
 * The netmap: one complete document per node, versioned.
 *
 * Until now a node could learn its compiled ACL policy and its subnet routes, and
 * nothing else. It was never told that another node existed, where that node was, or
 * which key it speaks WireGuard with, so `pkg/dataplane` had to be handed a peer file
 * written by hand. This service is what replaces that file.
 *
 * Three properties the rest of the design rests on:
 *
 *  - **Complete, not incremental.** A peer the control plane stops sending is a peer
 *    the node must stop talking to, and an incremental feed cannot express that.
 *    `Device.SetPeers` takes the whole set and replaces it in one operation.
 *  - **Compiled, not enumerated.** A peer appears only if the compiled policy permits
 *    traffic between the two nodes in at least one direction. A node never learns of
 *    nodes it cannot reach, so the peer set is not an inventory of the fleet.
 *  - **Deterministic.** Peers are sorted by node id, allowed IPs by address family
 *    then address, endpoints lexicographically, and every object is built with a fixed
 *    key order. Two builds from the same database state serialise to the same bytes,
 *    which is what makes an unchanged version mean unchanged.
 *
 * The version is the `netmap` row of `mesh_epochs`: one global counter, not one per
 * node. A global counter over-signals (a node re-fetches a document that turns out to
 * be identical) and can never under-signal, and under-signalling is the failure that
 * leaves a revoked peer reachable.
 */

const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const { normalisePublicKeyHex } = require('../utils/crypto');
const AclEngine = require('./AclEngine');
const RouteEngine = require('./RouteEngine');
const RevocationEngine = require('./RevocationEngine');

// --- Configured constants ----------------------------------------------------
//
// These are configuration, not measurements: they describe how the operator wants the
// overlay to run, and every node in a deployment gets the same values.

/**
 * Overlay MTU. 1380 rather than the 1420 wireguard-go defaults to, so a DERP frame
 * header still fits inside a 1500 byte path once the relay exists (ADR 0020 section 5).
 * Onion cells stay 1420 bytes as logical units on a TCP stream, which TCP segments;
 * they are not packets and this number does not constrain them.
 */
const OVERLAY_MTU = positiveInt(process.env.SOVEREIGN_OVERLAY_MTU, 1380);

/** The UDP port every node binds for WireGuard. */
const LISTEN_PORT = positiveInt(process.env.SOVEREIGN_WG_LISTEN_PORT, 51820);

/**
 * WireGuard persistent keepalive. Non-zero so a node that ends up behind a NAT keeps
 * its mapping open; on the compose fleet, where every node is on one bridge, it costs
 * one small datagram per peer per interval.
 */
const KEEPALIVE_SECONDS = nonNegativeInt(process.env.SOVEREIGN_NETMAP_KEEPALIVE_SECONDS, 25);

/**
 * How long a node may keep running on a netmap it can no longer refresh. Past this it
 * removes every peer: fail-static up to the bound, fail-closed after it. The default
 * matches ADR 0020.
 */
const MAX_STALENESS_SECONDS = positiveInt(process.env.SOVEREIGN_MAX_NETMAP_STALENESS_SECONDS, 86400);

/**
 * Endpoint changes bump the version at most once per node per window.
 *
 * A node heartbeats every 15 s. An endpoint that flaps between two values would
 * otherwise move the version on every beat and make the whole fleet re-fetch. The
 * endpoints themselves are always stored; only the bump is rate limited.
 */
const ENDPOINT_DEBOUNCE_SECONDS = positiveInt(process.env.SOVEREIGN_ENDPOINT_DEBOUNCE_SECONDS, 30);

/** At most this many endpoints are kept for a node. */
const MAX_ENDPOINTS = 8;

/** An endpoint renders as "ip:port"; anything longer than this is not one. */
const MAX_ENDPOINT_LENGTH = 64;

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

async function query(pgSql, pgParams, sqliteSql, sqliteParams) {
  if (isPostgres()) {
    return (await getPgPool().query(pgSql, pgParams)).rows;
  }

  const db = getDatabase();
  const statement = db.prepare(sqliteSql);
  if (/^\s*select/i.test(sqliteSql)) return statement.all(...sqliteParams);
  statement.run(...sqliteParams);
  return [];
}

// --- Version -----------------------------------------------------------------

/** The version a node compares against what it holds. */
async function getVersion() {
  return AclEngine.getEpoch('netmap');
}

/** Advance the version so every node re-fetches. */
async function bumpVersion() {
  return AclEngine.bumpNetmap();
}

// --- Endpoint intake ---------------------------------------------------------

function parseIPv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Reject an address a peer could never dial.
 *
 * Loopback and link-local are the two that matter in practice: a node that reports
 * 127.0.0.1 or fe80::… as a candidate is reporting an address that means something
 * different on every machine that reads it, and a peer that tries it either talks to
 * itself or to whatever is on its own link. The unspecified address is rejected for
 * the same reason.
 */
function classifyAddress(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };

  const octets = parseIPv4(raw);
  if (octets) {
    if (octets[0] === 127) return { ok: false, reason: 'loopback' };
    if (octets[0] === 169 && octets[1] === 254) return { ok: false, reason: 'link-local' };
    if (octets.every((o) => o === 0)) return { ok: false, reason: 'unspecified' };
    return { ok: true, family: 4, address: octets.join('.') };
  }

  // IPv6: accepted in its canonical lower-case form only. This is not a full parser
  // and it does not try to be: an address it cannot recognise is rejected rather than
  // stored, because an endpoint the control plane cannot reason about is one it would
  // hand to every peer in the fleet.
  const lower = raw.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(lower) || !lower.includes(':')) {
    return { ok: false, reason: 'malformed' };
  }
  if (lower === '::1') return { ok: false, reason: 'loopback' };
  if (lower === '::') return { ok: false, reason: 'unspecified' };
  // fe80::/10 is fe80: through febf:.
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return { ok: false, reason: 'link-local' };

  return { ok: true, family: 6, address: lower };
}

/** "ip:port", with IPv6 bracketed, which is the form wireguard-go takes. */
function renderEndpoint(family, address, port) {
  return family === 6 ? `[${address}]:${port}` : `${address}:${port}`;
}

/**
 * Validate what a node reported about itself.
 *
 * Returns the endpoints that were kept, in a deterministic order, and one rejection
 * record per entry that was dropped. Nothing throws: a node with one bad candidate
 * still gets its good ones stored, and the rejections are visible to the caller so
 * they can be logged rather than guessed at.
 */
function validateEndpoints(raw) {
  const accepted = [];
  const rejected = [];

  if (!Array.isArray(raw)) {
    return { endpoints: accepted, rejected, truncated: false };
  }

  const seen = new Set();

  for (const entry of raw) {
    // A node may report either the structured form the registration uses or a bare
    // "ip:port" string. Both normalise to the structured form, which is what the
    // nodes.endpoints column and /v4/control/discover already carry.
    let addressText;
    let portValue;
    let protocol = 'udp';
    let isStun = false;

    if (typeof entry === 'string') {
      const text = entry.trim();
      const cut = text.lastIndexOf(':');
      if (cut <= 0) {
        rejected.push({ entry: text.slice(0, MAX_ENDPOINT_LENGTH), reason: 'malformed' });
        continue;
      }
      addressText = text.slice(0, cut).replace(/^\[|\]$/g, '');
      portValue = text.slice(cut + 1);
    } else if (entry && typeof entry === 'object') {
      addressText = entry.ip_address;
      portValue = entry.port;
      if (entry.protocol) protocol = String(entry.protocol).toLowerCase();
      isStun = Boolean(entry.is_stun_discovered);
    } else {
      rejected.push({ entry: String(entry).slice(0, MAX_ENDPOINT_LENGTH), reason: 'malformed' });
      continue;
    }

    const classified = classifyAddress(addressText);
    if (!classified.ok) {
      rejected.push({ entry: String(addressText).slice(0, MAX_ENDPOINT_LENGTH), reason: classified.reason });
      continue;
    }

    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      rejected.push({ entry: `${classified.address}:${portValue}`.slice(0, MAX_ENDPOINT_LENGTH), reason: 'port' });
      continue;
    }

    if (!['udp', 'tcp', 'ws', 'http3'].includes(protocol)) {
      rejected.push({ entry: renderEndpoint(classified.family, classified.address, port), reason: 'protocol' });
      continue;
    }

    const rendered = renderEndpoint(classified.family, classified.address, port);
    if (rendered.length > MAX_ENDPOINT_LENGTH) {
      rejected.push({ entry: rendered.slice(0, MAX_ENDPOINT_LENGTH), reason: 'too long' });
      continue;
    }

    const key = `${protocol}|${rendered}`;
    if (seen.has(key)) continue;
    seen.add(key);

    accepted.push({
      ip_address: classified.address,
      port,
      protocol,
      is_stun_discovered: isStun,
      // Not stored; carried so the caller can order and render without re-parsing.
      _family: classified.family,
      _rendered: rendered
    });
  }

  // Deterministic: STUN-discovered candidates first (they are the ones a peer on
  // another network can actually use), then lexicographic.
  accepted.sort((a, b) => {
    if (a.is_stun_discovered !== b.is_stun_discovered) return a.is_stun_discovered ? -1 : 1;
    return a._rendered.localeCompare(b._rendered);
  });

  const truncated = accepted.length > MAX_ENDPOINTS;
  const kept = accepted.slice(0, MAX_ENDPOINTS);

  return { endpoints: kept, rejected, truncated };
}

/**
 * A comparison key that does not depend on how the database gave the value back.
 *
 * PostgreSQL stores this column as jsonb, which normalises key order, so comparing
 * JSON.stringify of the stored value against JSON.stringify of the new one reported a
 * change on every single heartbeat -- the content was identical and the key order was
 * not. On the six-node fleet that moved the netmap version twice every fifteen
 * seconds and made every node re-fetch a document it already had.
 */
function endpointKey(list) {
  return list.map((e) => `${e.ip_address}|${e.port}|${e.protocol}|${e.is_stun_discovered ? 1 : 0}`).join(',');
}

function storedShape(endpoints) {
  return endpoints.map((e) => ({
    ip_address: e.ip_address,
    port: e.port,
    protocol: e.protocol,
    is_stun_discovered: e.is_stun_discovered
  }));
}

function parseJsonColumn(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch (err) {
    return fallback;
  }
}

/**
 * Store the endpoints a node reported and, when they changed, advance the version.
 *
 * The write happens whatever the debounce decides: a node that moves must be findable
 * at its new address as soon as anything else bumps the version. What the debounce
 * holds back is only the bump, which is what costs the fleet a re-fetch.
 */
async function recordEndpoints(nodeId, reported, now = new Date()) {
  const { endpoints, rejected, truncated } = validateEndpoints(reported);

  const rows = await query(
    'SELECT endpoints, endpoints_bumped_at FROM nodes WHERE id = $1',
    [nodeId],
    'SELECT endpoints, endpoints_bumped_at FROM nodes WHERE id = ?',
    [nodeId]
  );

  if (rows.length === 0) {
    return { stored: false, changed: false, bumped: false, rejected, truncated };
  }

  const stored = storedShape(endpoints);
  const previous = storedShape(validateEndpoints(parseJsonColumn(rows[0].endpoints, [])).endpoints);
  const changed = endpointKey(previous) !== endpointKey(stored);

  if (!changed) {
    return { stored: true, changed: false, bumped: false, rejected, truncated };
  }

  const lastBump = rows[0].endpoints_bumped_at ? new Date(rows[0].endpoints_bumped_at) : null;
  const sinceBumpMs = lastBump && !Number.isNaN(lastBump.getTime()) ? now.getTime() - lastBump.getTime() : Infinity;
  const bump = sinceBumpMs >= ENDPOINT_DEBOUNCE_SECONDS * 1000;

  const json = JSON.stringify(stored);

  if (bump) {
    await query(
      'UPDATE nodes SET endpoints = $1::jsonb, endpoints_bumped_at = $2, updated_at = NOW() WHERE id = $3',
      [json, now.toISOString(), nodeId],
      "UPDATE nodes SET endpoints = ?, endpoints_bumped_at = ?, updated_at = datetime('now') WHERE id = ?",
      [json, now.toISOString(), nodeId]
    );
    await bumpVersion();
  } else {
    await query(
      'UPDATE nodes SET endpoints = $1::jsonb, updated_at = NOW() WHERE id = $2',
      [json, nodeId],
      "UPDATE nodes SET endpoints = ?, updated_at = datetime('now') WHERE id = ?",
      [json, nodeId]
    );
  }

  return { stored: true, changed: true, bumped: bump, rejected, truncated };
}

// --- Building the document ---------------------------------------------------

const CONCRETE_PROTOCOLS = ['TCP', 'UDP', 'ICMP'];

function expandProtocol(protocol) {
  const name = String(protocol || 'ALL').toUpperCase();
  return name === 'ALL' ? CONCRETE_PROTOCOLS : [name];
}

/** Ports in `ranges` that no interval in `denied` already covers. */
function hasUncoveredPort(ranges, denied) {
  for (const range of ranges) {
    let remaining = [[Number(range.start) || 0, Number.isFinite(Number(range.end)) ? Number(range.end) : 65535]];

    for (const [dStart, dEnd] of denied) {
      const next = [];
      for (const [start, end] of remaining) {
        if (dEnd < start || dStart > end) {
          next.push([start, end]);
          continue;
        }
        if (dStart > start) next.push([start, dStart - 1]);
        if (dEnd < end) next.push([dEnd + 1, end]);
      }
      remaining = next;
      if (remaining.length === 0) break;
    }

    if (remaining.length > 0) return true;
  }
  return false;
}

/**
 * Peers the compiled policy permits traffic with, in at least one direction.
 *
 * This has to reproduce how `pkg/acl` reads the same list, which is first match wins
 * in order. A peer named only by DROP entries is forbidden and must not appear in the
 * netmap at all -- the node would otherwise hold its key and its endpoint for traffic
 * it may not send. A peer denied on one port and allowed on the rest is permitted, so
 * the check is not "does an ACCEPT exist" but "does an ACCEPT survive the DROPs that
 * precede it".
 *
 * Getting this wrong in the permissive direction is the failure that matters: it hands
 * a node the key of a peer the operator forbade.
 */
function permittedPeerVIPs(policy) {
  const permitted = new Set();
  if (!policy) return permitted;

  for (const direction of [policy.inbound_rules || [], policy.outbound_rules || []]) {
    // Per peer, per concrete protocol, the port intervals an earlier DROP has taken.
    const denied = new Map();

    for (const rule of direction) {
      const vip = rule.allowed_peer_vip ? String(rule.allowed_peer_vip) : null;
      if (!vip) continue;

      const ranges =
        Array.isArray(rule.port_ranges) && rule.port_ranges.length > 0 ? rule.port_ranges : [{ start: 0, end: 65535 }];
      const protocols = expandProtocol(rule.protocol);
      const accept = String(rule.action || '').toUpperCase() === 'ACCEPT';

      for (const protocol of protocols) {
        const key = `${vip}|${protocol}`;
        const taken = denied.get(key) || [];

        if (accept) {
          if (hasUncoveredPort(ranges, taken)) permitted.add(vip);
          continue;
        }

        for (const range of ranges) {
          taken.push([Number(range.start) || 0, Number.isFinite(Number(range.end)) ? Number(range.end) : 65535]);
        }
        denied.set(key, taken);
      }
    }
  }

  return permitted;
}

/** Turn Go's {IP, Mask} encoding of a *net.IPNet back into a CIDR string. */
function goIPNetToCidr(network) {
  if (!network || typeof network.IP !== 'string' || typeof network.Mask !== 'string') return null;

  const mask = Buffer.from(network.Mask, 'base64');
  let bits = 0;
  for (const byte of mask) {
    for (let i = 7; i >= 0; i--) {
      if ((byte >> i) & 1) bits++;
      else return `${network.IP}/${bits}`;
    }
  }
  return `${network.IP}/${bits}`;
}

/**
 * Sort allowed IPs by family then by address, so the same set always serialises the
 * same way. Sorting the strings alone would put "100.64.0.10/32" before
 * "100.64.0.2/32", which is stable but reads as an error in a report.
 */
function sortAllowedIPs(list) {
  return list.slice().sort((a, b) => {
    const [aAddr] = a.split('/');
    const [bAddr] = b.split('/');
    const aV4 = parseIPv4(aAddr);
    const bV4 = parseIPv4(bAddr);
    if (aV4 && !bV4) return -1;
    if (!aV4 && bV4) return 1;
    if (aV4 && bV4) {
      for (let i = 0; i < 4; i++) {
        if (aV4[i] !== bV4[i]) return aV4[i] - bV4[i];
      }
      return a.localeCompare(b);
    }
    return a.localeCompare(b);
  });
}

/**
 * Build the netmap for one node.
 *
 * Returns null when the node is unknown. The document carries no timestamp: the
 * caller adds `generated_at_unix`, so that two builds from the same database state
 * serialise to identical bytes and the determinism can be asserted on the bytes
 * rather than on a field-by-field comparison that could miss one.
 */
async function buildNetmap(nodeId) {
  const selfRows = await query(
    `SELECT id, overlay_ipv4, overlay_ipv6, is_quarantined FROM nodes WHERE id = $1`,
    [nodeId],
    `SELECT id, overlay_ipv4, overlay_ipv6, is_quarantined FROM nodes WHERE id = ?`,
    [nodeId]
  );

  if (selfRows.length === 0) return null;
  const self = selfRows[0];

  const [version, policy, revokedKeys] = await Promise.all([
    getVersion(),
    AclEngine.compilePolicyFor(nodeId),
    RevocationEngine.activeRevocations()
  ]);

  const routeList = await RouteEngine.routesFor(nodeId);

  const revoked = new Set(revokedKeys.map((k) => String(k).toLowerCase()));
  const permitted = permittedPeerVIPs(policy);

  // A quarantined node is isolated in both directions. Its peers already drop it --
  // it is gone from their netmaps and from their compiled policy -- and sending it a
  // peer set would leave it holding keys and endpoints for a fleet that will not
  // answer it.
  const candidates = self.is_quarantined
    ? []
    : await query(
        `SELECT id, public_key, overlay_ipv4, overlay_ipv6, endpoints
           FROM nodes
          WHERE id <> $1 AND is_quarantined = FALSE AND is_healthy = TRUE`,
        [nodeId],
        `SELECT id, public_key, overlay_ipv4, overlay_ipv6, endpoints
           FROM nodes
          WHERE id <> ? AND is_quarantined = 0 AND is_healthy = 1`,
        [nodeId]
      );

  const peers = [];
  // A subnet belongs to exactly one peer's allowed IPs. wireguard-go routes a prefix
  // to whichever peer claims it, so two peers claiming the same subnet is a silent
  // coin flip; the route's own priority order decides instead.
  const claimedSubnets = new Set();

  for (const row of candidates.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (!permitted.has(String(row.overlay_ipv4))) continue;

    const keyHex = normalisePublicKeyHex(row.public_key);
    // A node whose stored key cannot be decoded cannot be a WireGuard peer. Sending
    // it would make SetPeers reject the whole document and leave the previous peer
    // set in place, which is a worse failure than one unreachable node.
    if (!keyHex) continue;
    if (revoked.has(keyHex.toLowerCase())) continue;

    const allowed = [];
    if (row.overlay_ipv4) allowed.push(`${row.overlay_ipv4}/32`);
    if (row.overlay_ipv6) allowed.push(`${row.overlay_ipv6}/128`);

    for (const route of routeList) {
      const cidr = goIPNetToCidr(route.network_cidr);
      if (!cidr || claimedSubnets.has(cidr)) continue;
      const gateway = route.routing_peers.find((p) => p.is_healthy);
      if (!gateway || gateway.node_id !== row.id) continue;
      claimedSubnets.add(cidr);
      allowed.push(cidr);
    }

    const endpoints = validateEndpoints(parseJsonColumn(row.endpoints, []))
      .endpoints.filter((e) => e.protocol === 'udp')
      .map((e) => e._rendered);

    peers.push({
      node_id: row.id,
      public_key_hex: keyHex.toLowerCase(),
      allowed_ips: sortAllowedIPs(allowed),
      endpoints,
      // No column records a DERP region for a node and nothing measures one. Null
      // says so; an invented "eu-central" would send every node to one relay.
      derp_region: null,
      keepalive_seconds: KEEPALIVE_SECONDS
    });
  }

  return {
    version,
    unchanged: false,
    self: {
      overlay_ipv4: self.overlay_ipv4,
      overlay_ipv6: self.overlay_ipv6,
      mtu: OVERLAY_MTU,
      listen_port: LISTEN_PORT
    },
    peers,
    acl: policy,
    routes: routeList,
    revoked_keys: revokedKeys.slice().sort(),
    max_staleness_seconds: MAX_STALENESS_SECONDS
  };
}

module.exports = {
  OVERLAY_MTU,
  LISTEN_PORT,
  KEEPALIVE_SECONDS,
  MAX_STALENESS_SECONDS,
  ENDPOINT_DEBOUNCE_SECONDS,
  MAX_ENDPOINTS,
  MAX_ENDPOINT_LENGTH,
  getVersion,
  bumpVersion,
  validateEndpoints,
  recordEndpoints,
  buildNetmap,
  goIPNetToCidr
};
