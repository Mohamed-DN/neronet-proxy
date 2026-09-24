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
    value = value * 256 + octet;
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

  // The netmap is derived from the compiled policy and the route set, so anything
  // that moves either of those moves it too. Doing this here rather than at each
  // call site is deliberate: there are five of them across three services, and a
  // netmap version that fails to advance leaves a revoked peer reachable. An extra
  // bump costs one re-fetch of a document the node finds identical.
  if (name !== 'netmap') {
    await bumpEpoch('netmap');
  }

  return getEpoch(name);
}

/**
 * Advance the netmap version alone.
 *
 * For the changes that do not touch a rule or a route: quarantine, health, and a
 * node's reported endpoints.
 */
async function bumpNetmap() {
  return bumpEpoch('netmap');
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

  // Ordered because the compiled policy is now part of the netmap, and the netmap has
  // to serialise to the same bytes for the same inputs: an unordered scan is free to
  // return the rows in a different sequence on the same data.
  const peers = await query(
    'SELECT id, overlay_ipv4 FROM nodes WHERE id <> $1 AND is_quarantined = FALSE ORDER BY id ASC',
    [nodeId],
    'SELECT id, overlay_ipv4 FROM nodes WHERE id <> ? AND is_quarantined = 0 ORDER BY id ASC',
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


async function updateRule(id, updates = {}) {
  const existingRows = await query(
    'SELECT * FROM acl_rules WHERE id = $1',
    [id],
    'SELECT * FROM acl_rules WHERE id = ?',
    [id]
  );
  if (!existingRows || existingRows.length === 0) return null;
  const existing = existingRows[0];

  const priority = updates.priority !== undefined ? Number(updates.priority) : Number(existing.priority);
  const source_cidr = updates.source_cidr !== undefined ? updates.source_cidr : existing.source_cidr;
  const destination_cidr = updates.destination_cidr !== undefined ? updates.destination_cidr : existing.destination_cidr;
  const protocol = (updates.protocol !== undefined ? updates.protocol : existing.protocol).toUpperCase();
  const port_start = updates.port_start !== undefined ? Number(updates.port_start) : Number(existing.port_start);
  const port_end = updates.port_end !== undefined ? Number(updates.port_end) : Number(existing.port_end);
  const action = (updates.action !== undefined ? updates.action : existing.action).toUpperCase();
  const description = updates.description !== undefined ? updates.description : existing.description;
  const enabled = updates.enabled !== undefined ? Boolean(updates.enabled) : Boolean(existing.enabled);

  for (const cidr of [source_cidr, destination_cidr]) {
    if (!parseCidr(cidr)) {
      const err = new Error(`invalid CIDR: ${cidr}`);
      err.status = 400;
      throw err;
    }
  }

  await query(
    `UPDATE acl_rules SET priority = $1, source_cidr = $2, destination_cidr = $3, protocol = $4,
     port_start = $5, port_end = $6, action = $7, description = $8, enabled = $9, updated_at = NOW() WHERE id = $10`,
    [priority, source_cidr, destination_cidr, protocol, port_start, port_end, action, description, enabled, id],
    `UPDATE acl_rules SET priority = ?, source_cidr = ?, destination_cidr = ?, protocol = ?,
     port_start = ?, port_end = ?, action = ?, description = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [priority, source_cidr, destination_cidr, protocol, port_start, port_end, action, description, enabled ? 1 : 0, id]
  );

  await bumpEpoch('acl');
  const updatedRows = await query(
    'SELECT * FROM acl_rules WHERE id = $1',
    [id],
    'SELECT * FROM acl_rules WHERE id = ?',
    [id]
  );
  return updatedRows[0] || null;
}

/**
 * Simulate packet evaluation against current ACL rules and mesh default policy.
 */
async function simulatePacket({ source_ip, destination_ip, protocol = 'ALL', port = 0, defaultPolicy = 'deny' }) {
  const rules = await listRules();
  const proto = String(protocol).toUpperCase();
  const portNum = Number(port) || 0;

  for (const rule of rules) {
    if (!rule.enabled) continue;

    // Check CIDRs
    const srcMatch = cidrContains(rule.source_cidr, source_ip);
    const dstMatch = cidrContains(rule.destination_cidr, destination_ip);
    if (!srcMatch || !dstMatch) continue;

    // Check protocol
    const ruleProto = (rule.protocol || 'ALL').toUpperCase();
    if (ruleProto !== 'ALL' && proto !== 'ALL' && ruleProto !== proto) continue;

    // Check port range
    const pStart = Number(rule.port_start) || 0;
    const pEnd = Number.isFinite(Number(rule.port_end)) ? Number(rule.port_end) : 65535;
    if (portNum < pStart || portNum > pEnd) continue;

    // Match!
    return {
      verdict: rule.action,
      matched_rule: {
        id: rule.id,
        priority: rule.priority,
        source_cidr: rule.source_cidr,
        destination_cidr: rule.destination_cidr,
        protocol: rule.protocol,
        port_start: rule.port_start,
        port_end: rule.port_end,
        action: rule.action,
        description: rule.description
      },
      reason: `Matched rule #${rule.priority} (${rule.id}): ${rule.action} ${rule.protocol} from ${rule.source_cidr} to ${rule.destination_cidr}`,
      packet: {
        source_ip,
        destination_ip,
        protocol: proto,
        port: portNum
      }
    };
  }

  // No rule matched
  const isMeshOpen = rules.length === 0 || defaultPolicy === 'open';
  const verdict = isMeshOpen ? 'ACCEPT' : 'DROP';
  return {
    verdict,
    matched_rule: null,
    reason: rules.length === 0
      ? 'No rules configured — mesh is currently open by default'
      : defaultPolicy === 'open'
        ? 'No rule matched — organization default policy is OPEN (Permit)'
        : 'No rule matched — Zero-Trust organization default policy is DENY (Drop)',
    packet: {
      source_ip,
      destination_ip,
      protocol: proto,
      port: portNum
    }
  };
}

/**
 * Preview compiled policy for a node given an optional candidate rule.
 */
async function compilePreview(nodeId, candidateRule = null) {
  const selfRows = await query(
    'SELECT id, overlay_ipv4 FROM nodes WHERE id = $1',
    [nodeId],
    'SELECT id, overlay_ipv4 FROM nodes WHERE id = ?',
    [nodeId]
  );

  if (selfRows.length === 0) return null;
  const self = selfRows[0];

  const peers = await query(
    'SELECT id, overlay_ipv4 FROM nodes WHERE id <> $1 AND is_quarantined = FALSE ORDER BY id ASC',
    [nodeId],
    'SELECT id, overlay_ipv4 FROM nodes WHERE id <> ? AND is_quarantined = 0 ORDER BY id ASC',
    [nodeId]
  );

  let rules = await listRules();

  if (candidateRule) {
    const normalized = {
      id: candidateRule.id || 'candidate-preview',
      priority: Number(candidateRule.priority) || 100,
      source_cidr: candidateRule.source_cidr || '0.0.0.0/0',
      destination_cidr: candidateRule.destination_cidr || '0.0.0.0/0',
      protocol: (candidateRule.protocol || 'ALL').toUpperCase(),
      port_start: Number(candidateRule.port_start) || 0,
      port_end: Number.isFinite(Number(candidateRule.port_end)) ? Number(candidateRule.port_end) : 65535,
      action: (candidateRule.action || 'ACCEPT').toUpperCase(),
      enabled: candidateRule.enabled !== undefined ? Boolean(candidateRule.enabled) : true,
      description: candidateRule.description || 'Candidate preview rule'
    };

    rules = rules.filter(r => r.id !== normalized.id);
    if (normalized.enabled) {
      rules.push(normalized);
    }
    rules.sort((a, b) => (Number(a.priority) || 100) - (Number(b.priority) || 100));
  }

  const epoch = await getEpoch('acl');

  if (rules.length === 0) {
    return {
      node_id: self.id,
      overlay_ipv4: self.overlay_ipv4,
      inbound_rules: peers.map((p) => allowAll(p.overlay_ipv4)),
      outbound_rules: peers.map((p) => allowAll(p.overlay_ipv4)),
      epoch,
      is_preview: true
    };
  }

  const outbound = [];
  const inbound = [];

  for (const rule of rules) {
    const portRanges = [{ start: Number(rule.port_start) || 0, end: Number(rule.port_end) || 65535 }];

    for (const peer of peers) {
      if (cidrContains(rule.source_cidr, self.overlay_ipv4) && cidrContains(rule.destination_cidr, peer.overlay_ipv4)) {
        outbound.push({
          allowed_peer_vip: peer.overlay_ipv4,
          protocol: rule.protocol,
          port_ranges: portRanges,
          action: rule.action,
          is_directional: true,
          rule_id: rule.id
        });
      }

      if (cidrContains(rule.source_cidr, peer.overlay_ipv4) && cidrContains(rule.destination_cidr, self.overlay_ipv4)) {
        inbound.push({
          allowed_peer_vip: peer.overlay_ipv4,
          protocol: rule.protocol,
          port_ranges: portRanges,
          action: rule.action,
          is_directional: true,
          rule_id: rule.id
        });
      }
    }
  }

  return {
    node_id: self.id,
    overlay_ipv4: self.overlay_ipv4,
    inbound_rules: inbound,
    outbound_rules: outbound,
    epoch,
    is_preview: true
  };
}

module.exports = {
  parseCidr,
  cidrContains,
  getEpoch,
  bumpEpoch,
  bumpNetmap,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  compilePolicyFor,
  compilePreview,
  simulatePacket
};
