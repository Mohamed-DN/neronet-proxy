/**
 * Subnet route storage and delivery.
 *
 * A route says "this subnet is reachable through these peers". Nodes could never
 * learn that, because /v4/control/sync-routes did not exist -- pkg/routes models
 * failover across several gateways and none of it was reachable from a deployment.
 *
 * The wire format is dictated by Go: routes.NetworkRoute carries a *net.IPNet, which
 * has no custom JSON marshalling, so it serialises as {"IP": "...", "Mask": "..."}
 * with the mask base64-encoded. Emitting a CIDR string there would decode to a nil
 * network on the node and silently install nothing. Verified by round-tripping the
 * real struct through encoding/json.
 */

const crypto = require('crypto');

const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const { bumpEpoch, getEpoch } = require('./AclEngine');

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

/** Split "10.100.0.0/24" into the network address and prefix length. */
function parseCidrParts(cidr) {
  const [addr, bitsText] = String(cidr || '').trim().split('/');
  const octets = String(addr).split('.').map(Number);

  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return null;
  }

  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;

  return { octets, bits };
}

/**
 * Encode a CIDR the way Go's encoding/json represents a *net.IPNet.
 *
 * The network address is masked first. Go's net.ParseCIDR returns the masked network,
 * so a route stored as 10.100.0.5/24 must be delivered as 10.100.0.0/24; sending the
 * host address would produce a network the node cannot match against.
 */
function cidrToGoIPNet(cidr) {
  const parsed = parseCidrParts(cidr);
  if (!parsed) return null;

  const { octets, bits } = parsed;

  const mask = [0, 0, 0, 0].map((_, i) => {
    const remaining = bits - i * 8;
    if (remaining >= 8) return 255;
    if (remaining <= 0) return 0;
    return (255 << (8 - remaining)) & 255;
  });

  const network = octets.map((octet, i) => octet & mask[i]);

  return {
    IP: network.join('.'),
    Mask: Buffer.from(mask).toString('base64')
  };
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

async function listRoutes() {
  return query(
    'SELECT * FROM network_routes WHERE enabled = TRUE ORDER BY network_id ASC, id ASC',
    [],
    'SELECT * FROM network_routes WHERE enabled = 1 ORDER BY network_id ASC, id ASC',
    []
  );
}

async function createRoute(route) {
  const id = route.id || `route-${crypto.randomBytes(6).toString('hex')}`;

  if (!cidrToGoIPNet(route.network_cidr)) {
    const err = new Error(`invalid CIDR: ${route.network_cidr}`);
    err.status = 400;
    throw err;
  }

  const values = [
    id,
    route.network_id || 'default',
    route.description || '',
    route.network_cidr,
    route.masquerade === false ? 0 : 1,
    (route.failover_mode || 'ACTIVE_PASSIVE').toUpperCase(),
    JSON.stringify(route.routing_peers || []),
    JSON.stringify(route.groups || [])
  ];

  await query(
    `INSERT INTO network_routes (id, network_id, description, network_cidr, masquerade, failover_mode, routing_peers, groups)
     VALUES ($1, $2, $3, $4, $5::boolean, $6, $7::jsonb, $8::jsonb)`,
    values,
    `INSERT INTO network_routes (id, network_id, description, network_cidr, masquerade, failover_mode, routing_peers, groups)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    values
  );

  await bumpEpoch('routes');
  return id;
}

async function deleteRoute(id) {
  await query('DELETE FROM network_routes WHERE id = $1', [id], 'DELETE FROM network_routes WHERE id = ?', [id]);
  return bumpEpoch('routes');
}

/**
 * Build the route set a node should install.
 *
 * A node is not given a route it is itself the gateway for: installing it would send
 * the gateway's own traffic for that subnet back into the overlay instead of out of
 * the local interface.
 *
 * Peer health is resolved at delivery time from the nodes table rather than from
 * whatever was stored when the route was created, so failover reflects the fleet as
 * it is now.
 */
async function routesFor(nodeId) {
  const rows = await listRoutes();
  if (rows.length === 0) return [];

  const nodes = await query(
    'SELECT id, is_healthy, is_quarantined, latency_ms, last_heartbeat FROM nodes',
    [],
    'SELECT id, is_healthy, is_quarantined, latency_ms, last_heartbeat FROM nodes',
    []
  );

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const delivered = [];

  for (const row of rows) {
    const network = cidrToGoIPNet(row.network_cidr);
    if (!network) continue;

    const specs = parseJsonColumn(row.routing_peers, []);

    const peers = specs
      .map((spec, index) => {
        const node = byId.get(spec.node_id);
        if (!node) return null;

        return {
          node_id: spec.node_id,
          priority: Number(spec.priority) || index + 1,
          is_healthy: Boolean(node.is_healthy) && !node.is_quarantined,
          last_probe_at: node.last_heartbeat
            ? new Date(node.last_heartbeat).toISOString()
            : '0001-01-01T00:00:00Z',
          latency_rtt_ms: Number(node.latency_ms) || 0,
          fail_count: 0
        };
      })
      .filter(Boolean);

    // A route whose gateways have all gone is not a route. Delivering it would have
    // the node blackhole the subnet rather than fall back to its normal path.
    if (peers.length === 0 || peers.every((p) => !p.is_healthy)) continue;

    // The node is one of this route's gateways: it must not install it.
    if (specs.some((spec) => spec.node_id === nodeId)) continue;

    delivered.push({
      id: row.id,
      network_id: row.network_id,
      description: row.description || '',
      network_cidr: network,
      masquerade: Boolean(row.masquerade),
      failover_mode: row.failover_mode || 'ACTIVE_PASSIVE',
      routing_peers: peers.sort((a, b) => a.priority - b.priority),
      groups: parseJsonColumn(row.groups, []),
      enabled: true,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : '0001-01-01T00:00:00Z',
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : '0001-01-01T00:00:00Z'
    });
  }

  return delivered;
}

module.exports = {
  cidrToGoIPNet,
  listRoutes,
  createRoute,
  deleteRoute,
  routesFor,
  getEpoch
};
