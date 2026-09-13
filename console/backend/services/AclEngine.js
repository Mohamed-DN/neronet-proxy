/**
 * Zero-trust ACL compilation and delivery.
 *
 * Rules are authored against CIDRs, which is how an operator thinks. pkg/acl enforces
 * against an exact peer address -- CompiledFilterRule.AllowedPeerVIP, compared with
 * net.IP.Equal -- which is how a packet filter has to work. The control plane bridges
 * the two by expanding every rule into one entry per matching peer before delivery.
 *
 * That expansion is what "compiled" means in CompiledPeerPolicy, and it has a
 * consequence worth stating: the policy a node holds changes when the fleet changes,
 * not only when the rules do. Adding a node must bump the epoch.
 */

const crypto = require('crypto');

const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const logger = require('../utils/logger');

// --- IPv4 CIDR helpers -------------------------------------------------------

function ipToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value;
}

/** Parse "10.0.0.0/8" into a range. Accepts a bare address as a /32. */
function parseCidr(cidr) {
  const text = String(cidr || '').trim();
  if (!text || text === 'any' || text === '*') {
    return { first: 0, last: 4294967295 };
  }

  const [addr, bitsText] = text.split('/');
  const base = ipToInt(addr);
  if (base === null) return null;

  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;

  const size = bits === 0 ? 4294967296 : 2 ** (32 - bits);
  const first = Math.floor(base / size) * size;

  return { first, last: first + size - 1 };
}

function cidrContains(cidr, ip) {
  const range = parseCidr(cidr);
  const value = ipToInt(ip);
  if (!range || value === null) return false;
  return value >= range.first && value <= range.last;
}

// --- Storage -----------------------------------------------------------------

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

async function getEpoch(name) {
  const rows = await query(
    'SELECT epoch FROM mesh_epochs WHERE name = $1',
    [name],
    'SELECT epoch FROM mesh_epochs WHERE name = ?',
    [name]
  );
  return rows.length > 0 ? Number(rows[0].epoch) : 1;
}

/**
 * Advance an epoch so nodes re-fetch.
 *
 * Call this whenever the compiled result could differ: a rule changed, or the set of
 * nodes changed. Missing the second case is the subtle failure -- rules stay
 * identical while the peers they expand to do not.
 */
async function bumpEpoch(name) {
  await query(
    'UPDATE mesh_epochs SET epoch = epoch + 1, updated_at = NOW() WHERE name = $1',
    [name],
    'UPDATE mesh_epochs SET epoch = epoch + 1, updated_at = CURRENT_TIMESTAMP WHERE name = ?',
    [name]
  );
  return getEpoch(name);
}

async function listRules() {
  return query(
    'SELECT * FROM acl_rules WHERE enabled = TRUE ORDER BY priority ASC, id ASC',
    [],
    'SELECT * FROM acl_rules WHERE enabled = 1 ORDER BY priority ASC, id ASC',
    []
  );
}

async function createRule(rule) {
  const id = rule.id || `acl-${crypto.randomBytes(6).toString('hex')}`;

  const values = [
    id,
    Number(rule.priority) || 100,
    rule.source_cidr || '0.0.0.0/0',
    rule.destination_cidr || '0.0.0.0/0',
    (rule.protocol || 'ALL').toUpperCase(),
    Number(rule.port_start) || 0,
    Number.isFinite(Number(rule.port_end)) ? Number(rule.port_end) : 65535,
    (rule.action || 'ACCEPT').toUpperCase(),
    rule.description || ''
  ];

  for (const cidr of [values[2], values[3]]) {
    if (!parseCidr(cidr)) {
      const err = new Error(`invalid CIDR: ${cidr}`);
      err.status = 400;
      throw err;
    }
  }

  await query(
    `INSERT INTO acl_rules (id, priority, source_cidr, destination_cidr, protocol, port_start, port_end, action, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    values,
    `INSERT INTO acl_rules (id, priority, source_cidr, destination_cidr, protocol, port_start, port_end, action, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values
  );

  await bumpEpoch('acl');
  return id;
}

async function deleteRule(id) {
  await query('DELETE FROM acl_rules WHERE id = $1', [id], 'DELETE FROM acl_rules WHERE id = ?', [id]);
  return bumpEpoch('acl');
}

// --- Compilation -------------------------------------------------------------

/**
 * Compile the policy a single node should enforce.
 *
 * Returns null when the node is unknown.
 *
 * When no rules are configured the result permits every mesh peer. This is a
 * deliberate choice and the alternative is worse: pkg/acl defaults to deny, so an
 * empty rule set delivered to a fleet would black-hole all traffic the moment ACL
 * delivery was switched on. A mesh with no policy written is open, and becomes
 * closed when the first rule is written -- which is also how Tailscale behaves.
 */
async function compilePolicyFor(nodeId) {
  const selfRows = await query(
    'SELECT id, overlay_ipv4 FROM nodes WHERE id = $1',
    [nodeId],
    'SELECT id, overlay_ipv4 FROM nodes WHERE id = ?',
    [nodeId]
  );

  if (selfRows.length === 0) return null;

  const self = selfRows[0];

  const peers = await query(
    'SELECT id, overlay_ipv4 FROM nodes WHERE id <> $1 AND is_quarantined = FALSE',
    [nodeId],
    'SELECT id, overlay_ipv4 FROM nodes WHERE id <> ? AND is_quarantined = 0',
    [nodeId]
  );

  const rules = await listRules();
  const epoch = await getEpoch('acl');

  if (rules.length === 0) {
    return {
      node_id: self.id,
      overlay_ipv4: self.overlay_ipv4,
      inbound_rules: peers.map((p) => allowAll(p.overlay_ipv4)),
      outbound_rules: peers.map((p) => allowAll(p.overlay_ipv4)),
      epoch
    };
  }

  const outbound = [];
  const inbound = [];

  for (const rule of rules) {
    const portRanges = [{ start: Number(rule.port_start) || 0, end: Number(rule.port_end) || 65535 }];

    for (const peer of peers) {
      // Outbound: this node is the source, the peer is the destination.
      if (cidrContains(rule.source_cidr, self.overlay_ipv4) && cidrContains(rule.destination_cidr, peer.overlay_ipv4)) {
        outbound.push({
          allowed_peer_vip: peer.overlay_ipv4,
          protocol: rule.protocol,
          port_ranges: portRanges,
          action: rule.action,
          is_directional: true
        });
      }

      // Inbound: the peer is the source, this node is the destination.
      if (cidrContains(rule.source_cidr, peer.overlay_ipv4) && cidrContains(rule.destination_cidr, self.overlay_ipv4)) {
        inbound.push({
          allowed_peer_vip: peer.overlay_ipv4,
          protocol: rule.protocol,
          port_ranges: portRanges,
          action: rule.action,
          is_directional: true
        });
      }
    }
  }

  return {
    node_id: self.id,
    overlay_ipv4: self.overlay_ipv4,
    inbound_rules: inbound,
    outbound_rules: outbound,
    epoch
  };
}

function allowAll(peerVip) {
  return {
    allowed_peer_vip: peerVip,
    protocol: 'ALL',
    port_ranges: [{ start: 0, end: 65535 }],
    action: 'ACCEPT',
    is_directional: false
  };
}

module.exports = {
  parseCidr,
  cidrContains,
  getEpoch,
  bumpEpoch,
  listRules,
  createRule,
  deleteRule,
  compilePolicyFor
};
