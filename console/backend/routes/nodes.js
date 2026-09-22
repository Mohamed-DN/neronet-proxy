const express = require('express');
const { readPageParams, pageEnvelope } = require('../utils/pagination');
const router = express.Router();
const crypto = require('crypto');
const { getPgPool } = require('../db/index');
const { authenticateToken } = require('../middleware/auth');
const { logAuditEvent } = require('../utils/audit');
const { allocateNextVip, generateCurve25519Keypair } = require('../utils/crypto');
const { broadcastNodeEvent } = require('../services/TopologySync');
const { derivePostureStatus } = require('../utils/posture');
const { bumpNetmap } = require('../services/AclEngine');
const NodeCredentialService = require('../services/NodeCredentialService');
const RevocationEngine = require('../services/RevocationEngine');
const { resolveUserOrg } = require('../middleware/rbac');

router.use(authenticateToken);
router.use(resolveUserOrg);

function parseJsonField(val, defaultVal = {}) {
  if (!val) return defaultVal;
  if (typeof val === 'object' && val !== null) return val;
  try {
    const parsed = JSON.parse(val);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
    return defaultVal;
  } catch (e) {
    return defaultVal;
  }
}

function formatNode(row) {
  if (!row) return null;
  const isQuarantined = Boolean(row.is_quarantined);
  const isExit = row.role === 'EXIT_BRIDGE';
  const onionEnabled = Boolean(row.onion_routing_enabled);
  const killSwitch = Boolean(row.kill_switch_enabled);

  const endpoints = parseJsonField(row.endpoints, []);
  const posture = parseJsonField(row.posture_checks, {});
  const metadata = parseJsonField(row.metadata, {});

  return {
    id: row.id,
    user_id: row.user_id,
    organization_id: row.organization_id || 'org-default',
    compartment_id: row.compartment_id || null,
    name: row.name,
    public_key: row.public_key,
    overlay_ipv4: row.overlay_ipv4,
    overlay_ipv6: row.overlay_ipv6,
    role: row.role,
    ip_class: row.ip_class,
    country_code: row.country_code,
    city: row.city || '',
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    location_source: metadata.location_source === 'declared' ? 'declared' : null,
    asn: Number(row.asn) || 0,
    endpoints: Array.isArray(endpoints) ? endpoints : [],
    onion_routing_enabled: onionEnabled,
    onion_hops: onionEnabled ? (row.onion_hops > 0 ? row.onion_hops : 3) : 0,
    kill_switch_enabled: killSwitch,
    is_healthy: Boolean(row.is_healthy),
    is_quarantined: isQuarantined,
    quarantine_reason: row.quarantine_reason || null,
    is_exit_node: isExit,
    risk_score: Number(row.risk_score) || 0,
    status: isQuarantined ? 'quarantined' : row.is_healthy ? 'active' : 'degraded',
    latency_ms: Number(row.latency_ms) || 15.0,
    jitter_ms: 1.0,
    tx_bytes: Number(row.tx_bytes) || 0,
    rx_bytes: Number(row.rx_bytes) || 0,
    cpu_usage_pct: Number(row.cpu_usage_pct) || 0.0,
    memory_usage_pct: Number(row.memory_usage_pct) || 0.0,
    battery_pct: row.battery_pct !== undefined ? Number(row.battery_pct) : 100.0,
    posture,
    posture_checks: posture,
    posture_status: derivePostureStatus(posture),
    metadata,
    transport: row.transport || 'wireguard',
    stealth_config: typeof row.stealth_config === 'string' ? JSON.parse(row.stealth_config) : (row.stealth_config || null),
    daita_mode: row.daita_mode || 'off',
    dns_name: row.dns_name || null,
    last_heartbeat: row.last_heartbeat,
    last_seen_at: row.last_seen_at || row.last_heartbeat || row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/**
 * Validates whether the user can access/modify a node according to RBAC and tenant isolation.
 * Cross-tenant access returns 404 (eliminating existence oracle leaks).
 * Auditors receive 403 on mutating requests.
 */
function verifyNodeAccess(node, user, isMutating = false) {
  if (!node) return { error: 404, message: 'Node not found' };

  if (user.role === 'super-admin') {
    return { ok: true };
  }

  const userOrgId = user.organization_id || 'org-default';
  const nodeOrgId = node.organization_id || 'org-default';

  // Cross-tenant access MUST return 404, never 403 (prevent existence oracle)
  if (nodeOrgId !== userOrgId) {
    return { error: 404, message: 'Node not found' };
  }

  const orgRole = user.org_role || user.role || 'member';

  // Auditor / viewer is strictly read-only
  if (isMutating && (orgRole === 'auditor' || orgRole === 'viewer')) {
    return { error: 403, message: 'Forbidden: read-only role cannot mutate node' };
  }

  const isPrivileged = ['owner', 'admin', 'network_admin'].includes(orgRole);
  if (isPrivileged) {
    return { ok: true };
  }

  // Auditor can read
  if (!isMutating && (orgRole === 'auditor' || orgRole === 'viewer')) {
    return { ok: true };
  }

  // Regular member can only access their own node
  if (node.user_id === user.id) {
    return { ok: true };
  }

  return { error: 404, message: 'Node not found' };
}

// 1. List Nodes (Scoped by Super-Admin, Organization, vs Regular Member)
router.get('/', async (req, res, next) => {
  try {
    const { limit, offset } = readPageParams(req);
    const pool = getPgPool();
    const isSuperAdmin = req.user.role === 'super-admin';
    const orgRole = req.user.org_role || req.user.role;
    const isOrgPrivileged = ['owner', 'admin', 'network_admin', 'auditor'].includes(orgRole);

    let rows = [];
    let total = 0;
    const accessTier = req.user.compartment_access || req.user.access_tier || 'standard';
    const hiddenClause = accessTier === 'root' ? '' : ' AND (c.is_hidden IS NULL OR c.is_hidden = FALSE)';

    if (isSuperAdmin && !req.query.org_id) {
      const countRes = await pool.query(
        `SELECT count(*)::int AS n FROM nodes n LEFT JOIN compartments c ON n.compartment_id = c.id WHERE 1=1 ${hiddenClause}`
      );
      total = countRes.rows[0].n;
      const result = await pool.query(
        `SELECT n.* FROM nodes n LEFT JOIN compartments c ON n.compartment_id = c.id WHERE 1=1 ${hiddenClause} ORDER BY n.created_at ASC, n.id ASC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      rows = result.rows;
    } else if (isOrgPrivileged || isSuperAdmin) {
      const orgId = isSuperAdmin ? req.query.org_id : req.user.organization_id || 'org-default';
      const countRes = await pool.query(
        `SELECT count(*)::int AS n FROM nodes n LEFT JOIN compartments c ON n.compartment_id = c.id WHERE n.organization_id = $1 ${hiddenClause}`,
        [orgId]
      );
      total = countRes.rows[0].n;
      const result = await pool.query(
        `SELECT n.* FROM nodes n LEFT JOIN compartments c ON n.compartment_id = c.id WHERE n.organization_id = $1 ${hiddenClause} ORDER BY n.created_at ASC, n.id ASC LIMIT $2 OFFSET $3`,
        [orgId, limit, offset]
      );
      rows = result.rows;
    } else {
      const countRes = await pool.query(
        `SELECT count(*)::int AS n FROM nodes n LEFT JOIN compartments c ON n.compartment_id = c.id WHERE n.user_id = $1 ${hiddenClause}`,
        [req.user.id]
      );
      total = countRes.rows[0].n;
      const result = await pool.query(
        `SELECT n.* FROM nodes n LEFT JOIN compartments c ON n.compartment_id = c.id WHERE n.user_id = $1 ${hiddenClause} ORDER BY n.created_at ASC, n.id ASC LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset]
      );
      rows = result.rows;
    }

    const nodes = rows.map(formatNode);
    return res.status(200).json({ nodes, ...pageEnvelope({ items: nodes, total, limit, offset }) });
  } catch (err) {
    next(err);
  }
});

// 2. Create Node (with VIP allocation, PostGIS point, and kill_switch_enabled)
router.post('/', async (req, res, next) => {
  try {
    const orgRole = req.user.org_role || req.user.role;
    if (orgRole === 'auditor' || orgRole === 'viewer') {
      return res.status(403).json({ error: 'Forbidden: read-only role cannot create nodes' });
    }

    const {
      name,
      role,
      country_code,
      public_key,
      ip_class,
      city,
      asn,
      onion_routing_enabled,
      onion_hops,
      kill_switch_enabled,
      endpoints,
      latitude,
      longitude,
      metadata
    } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Missing node name' });
    }

    let finalPubKey = public_key;
    if (!finalPubKey) {
      const kp = generateCurve25519Keypair();
      finalPubKey = kp.publicKeyBase64;
    }

    const VALID_ROLES = ['CLIENT_ORIGIN', 'EXIT_BRIDGE', 'HYBRID', 'RELAY'];
    const VALID_IP_CLASSES = ['RESIDENTIAL', 'MOBILE_5G', 'DATACENTER', 'UNKNOWN'];

    const nodeRole = role && VALID_ROLES.includes(role) ? role : 'CLIENT_ORIGIN';
    const nodeIpClass = ip_class && VALID_IP_CLASSES.includes(ip_class) ? ip_class : 'UNKNOWN';
    const nodeCountry = country_code || 'US';
    const onionRouting = onion_routing_enabled !== undefined ? Boolean(onion_routing_enabled) : Number(onion_hops) > 0;
    const hops = onionRouting ? (Number(onion_hops) > 0 ? Number(onion_hops) : 3) : 0;
    const killSwitch = Boolean(kill_switch_enabled);
    const endpointsArray = Array.isArray(endpoints) ? endpoints : [];
    const nodeId = `svrn-node-${crypto.randomBytes(4).toString('hex')}`;
    const orgId = req.user.organization_id || 'org-default';

    const pool = getPgPool();
    const existingKey = await pool.query('SELECT id FROM nodes WHERE public_key = $1', [finalPubKey]);
    if (existingKey.rows.length > 0) {
      return res.status(409).json({ error: 'Public key already registered' });
    }

    const { overlayIpv4, overlayIpv6 } = await allocateNextVip(pool);

    const lat = latitude !== undefined ? parseFloat(latitude) : nodeCountry === 'US' ? 38.9072 : 50.1109;
    const lon = longitude !== undefined ? parseFloat(longitude) : nodeCountry === 'US' ? -77.0369 : 8.6821;

    await pool.query(
      `
      INSERT INTO nodes (
        id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6,
        role, ip_class, country_code, city, asn, endpoints,
        onion_routing_enabled, onion_hops, kill_switch_enabled, is_healthy, is_quarantined, latency_ms,
        longitude, latitude, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13::jsonb,
        $14, $15, $16, TRUE, FALSE, 15.0,
        $17, $18, $19::jsonb
      )
    `,
      [
        nodeId,
        req.user.id,
        orgId,
        name.trim(),
        finalPubKey,
        overlayIpv4,
        overlayIpv6,
        nodeRole,
        nodeIpClass,
        nodeCountry,
        city || '',
        asn || 0,
        JSON.stringify(endpointsArray),
        onionRouting,
        hops,
        killSwitch,
        lon,
        lat,
        JSON.stringify(metadata || {})
      ]
    );

    const createdRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [nodeId]);
    const createdNode = formatNode(createdRes.rows[0]);

    // An added node has to appear in peer maps immediately.
    await bumpNetmap();

    logAuditEvent({
      eventType: 'NODE_CREATE',
      severity: 'info',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: nodeId,
      targetType: 'node',
      message: `Node ${createdNode.name} (${nodeId}) created by ${req.user.username} in org ${orgId}`,
      ipAddress: req.ip
    });

    await broadcastNodeEvent('NODE_REGISTER', createdNode, req.user);

    return res.status(201).json({ node: createdNode });
  } catch (err) {
    next(err);
  }
});

// 3. Get Node By ID
router.get('/:id', async (req, res, next) => {
  try {
    const pool = getPgPool();
    const resNode = await pool.query(
      `SELECT n.*, c.is_hidden
       FROM nodes n
       LEFT JOIN compartments c ON n.compartment_id = c.id
       WHERE n.id = $1`,
      [req.params.id]
    );
    const node = resNode.rows[0] || null;

    if (node && node.is_hidden) {
      const accessTier = req.user.compartment_access || req.user.access_tier || 'standard';
      if (accessTier !== 'root') {
        return res.status(404).json({ error: 'Node not found' });
      }
    }

    const access = verifyNodeAccess(node, req.user, false);
    if (!access.ok) {
      return res.status(access.error).json({ error: access.message });
    }
    return res.status(200).json({ node: formatNode(node) });
  } catch (err) {
    next(err);
  }
});

// 4. Update Node
router.put('/:id', async (req, res, next) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: 'Missing update body' });
    }

    const pool = getPgPool();
    const nodeRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
    const existing = nodeRes.rows[0] || null;

    const access = verifyNodeAccess(existing, req.user, true);
    if (!access.ok) {
      return res.status(access.error).json({ error: access.message });
    }

    const updates = [];
    const params = [];
    let pIdx = 1;

    if (req.body.name) {
      updates.push(`name = $${pIdx++}`);
      params.push(req.body.name);
    }
    if (req.body.latency_ms !== undefined) {
      updates.push(`latency_ms = $${pIdx++}`);
      params.push(Number(req.body.latency_ms));
    }
    if (req.body.is_healthy !== undefined) {
      updates.push(`is_healthy = $${pIdx++}`);
      params.push(Boolean(req.body.is_healthy));
    }
    if (req.body.role) {
      updates.push(`role = $${pIdx++}`);
      params.push(req.body.role);
    }
    if (req.body.kill_switch_enabled !== undefined) {
      updates.push(`kill_switch_enabled = $${pIdx++}`);
      params.push(Boolean(req.body.kill_switch_enabled));
    }
    if (req.body.onion_routing_enabled !== undefined) {
      const on = Boolean(req.body.onion_routing_enabled);
      updates.push(`onion_routing_enabled = $${pIdx++}`);
      params.push(on);
      updates.push(`onion_hops = $${pIdx++}`);
      params.push(on ? 3 : 0);
    } else if (req.body.onion_hops !== undefined) {
      const hops = Number(req.body.onion_hops);
      updates.push(`onion_routing_enabled = $${pIdx++}`);
      params.push(hops > 0);
      updates.push(`onion_hops = $${pIdx++}`);
      params.push(hops);
    }
    if (req.body.status) {
      if (req.body.status === 'quarantined') {
        updates.push('is_quarantined = TRUE, is_healthy = FALSE');
      } else if (req.body.status === 'active') {
        updates.push('is_quarantined = FALSE, is_healthy = TRUE');
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      params.push(req.params.id);
      await pool.query(`UPDATE nodes SET ${updates.join(', ')} WHERE id = $${pIdx}`, params);
    }

    const resUp = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
    const updatedNode = formatNode(resUp.rows[0]);

    if (req.body.status !== undefined || req.body.is_healthy !== undefined) {
      await bumpNetmap();
    }

    await broadcastNodeEvent('NODE_UPDATE', updatedNode, req.user);

    return res.status(200).json({ node: updatedNode });
  } catch (err) {
    next(err);
  }
});

// 5. Delete / Revoke Node
router.delete('/:id', async (req, res, next) => {
  try {
    const pool = getPgPool();
    const nodeRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
    const node = nodeRes.rows[0] || null;

    const access = verifyNodeAccess(node, req.user, true);
    if (!access.ok) {
      return res.status(access.error).json({ error: access.message });
    }

    // 1. Write public key to revoked_keys table and bump the policy epoch.
    //    Every peer receives the revocation on its next heartbeat (≤20 s) and
    //    removes the key from its WireGuard peer list and compiled ACL.
    await RevocationEngine.revokeNodeKeys([req.params.id], {
      reason: 'node_revoked',
      actorId: req.user.id
    });

    // 2. Remove the node record — the key is already blacklisted.
    await pool.query('DELETE FROM nodes WHERE id = $1', [req.params.id]);
    await NodeCredentialService.revokeNodeCredentials(req.params.id);

    await bumpNetmap();

    logAuditEvent({
      eventType: 'NODE_REVOKE',
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: req.params.id,
      targetType: 'node',
      message: `Node ${node.name} (${req.params.id}) revoked — key propagated to all peers`,
      ipAddress: req.ip
    });

    await broadcastNodeEvent('NODE_DELETE', { id: req.params.id, name: node.name, user_id: node.user_id }, req.user);

    return res.status(200).json({ success: true, message: 'Node revoked successfully' });
  } catch (err) {
    next(err);
  }
});

// 6. Node Actions: ping, set_exit, quarantine, lift_quarantine, toggle_onion, set_onion
router.post('/:id/action', async (req, res, next) => {
  try {
    const pool = getPgPool();
    const nodeRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
    const node = nodeRes.rows[0] || null;

    const { action } = req.body || {};
    if (!action) {
      return res.status(400).json({ error: 'Missing action parameter' });
    }

    // Ping is read-only, other actions are mutating
    const isMutating = action !== 'ping';
    const access = verifyNodeAccess(node, req.user, isMutating);
    if (!access.ok) {
      return res.status(access.error).json({ error: access.message });
    }

    if (action === 'ping') {
      const rtt_ms = Number(node.latency_ms) > 0 ? Number(node.latency_ms) : 14.2;
      const jitter_ms = 1.1;
      logAuditEvent({
        eventType: 'NODE_PING',
        severity: 'info',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: node.id,
        targetType: 'node',
        message: `Node ${node.id} pinged`,
        ipAddress: req.ip,
        metadata: { rtt_ms, jitter_ms }
      });
      return res.status(200).json({
        success: true,
        result: {
          rtt_ms,
          jitter_ms,
          status: node.is_quarantined ? 'quarantined' : 'active'
        }
      });
    }

    if (action === 'set_exit') {
      await pool.query("UPDATE nodes SET role = 'EXIT_BRIDGE', updated_at = NOW() WHERE id = $1", [node.id]);

      logAuditEvent({
        eventType: 'NODE_SET_EXIT',
        severity: 'info',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: node.id,
        targetType: 'node',
        message: `Node ${node.id} designated as EXIT_BRIDGE`,
        ipAddress: req.ip
      });

      await broadcastNodeEvent('NODE_ACTION_SET_EXIT', { id: node.id, role: 'EXIT_BRIDGE' }, req.user);

      return res.status(200).json({
        success: true,
        result: {
          is_exit_node: true,
          status: node.is_quarantined ? 'quarantined' : 'active'
        }
      });
    }

    if (action === 'toggle_onion' || action === 'set_onion') {
      const currentVal = Boolean(node.onion_routing_enabled);
      let newVal;
      if (req.body.params && req.body.params.enabled !== undefined) {
        newVal = Boolean(req.body.params.enabled);
      } else if (req.body.enabled !== undefined) {
        newVal = Boolean(req.body.enabled);
      } else if (req.body.params && req.body.params.onion_hops !== undefined) {
        newVal = Number(req.body.params.onion_hops) > 0;
      } else if (req.body.onion_hops !== undefined) {
        newVal = Number(req.body.onion_hops) > 0;
      } else {
        newVal = !currentVal;
      }

      const hops = newVal ? 3 : 0;
      if (newVal) {
        const ModuleLoader = require('../services/ModuleLoader');
        const orgId = node.organization_id || 'org-default';
        const isEnabled = await ModuleLoader.isModuleEnabledForOrg(orgId, 'onion');
        if (!isEnabled) {
          return res.status(403).json({ error: 'onion routing is disabled for this organization' });
        }
      }

      await pool.query(
        'UPDATE nodes SET onion_routing_enabled = $1, onion_hops = $2, updated_at = NOW() WHERE id = $3',
        [newVal, hops, node.id]
      );
      const resUp = await pool.query('SELECT * FROM nodes WHERE id = $1', [node.id]);
      const updatedRow = resUp.rows[0];

      logAuditEvent({
        eventType: 'NODE_ONION_TOGGLE',
        severity: 'info',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: node.id,
        targetType: 'node',
        message: `Node ${node.id} 3-hop onion obfuscation set to ${newVal}`,
        ipAddress: req.ip,
        metadata: { onion_routing_enabled: newVal, onion_hops: hops }
      });

      const formatted = formatNode(updatedRow);
      await broadcastNodeEvent('NODE_ACTION_ONION', formatted, req.user);

      return res.status(200).json({
        success: true,
        onion_routing_enabled: newVal,
        onion_hops: hops,
        node: formatted,
        result: {
          onion_routing_enabled: newVal,
          onion_hops: hops,
          status: formatted.status
        }
      });
    }

    if (action === 'quarantine') {
      const reason = req.body.reason || req.body.params?.reason || 'Manual security quarantine';

      await pool.query(
        `
        UPDATE nodes SET
          is_quarantined = TRUE,
          is_healthy = FALSE,
          quarantine_reason = $1,
          updated_at = NOW()
        WHERE id = $2
      `,
        [reason, node.id]
      );

      // Revoke the node's credential AND write its WireGuard key to revoked_keys.
      // Every other peer receives the revocation on its next heartbeat (≤20 s)
      // and removes the quarantined node from its WireGuard peer list and ACL.
      await NodeCredentialService.revokeNodeCredentials(node.id);
      await RevocationEngine.revokeNodeKeys([node.id], {
        reason: `quarantine: ${reason}`,
        actorId: req.user.id
      });
      await bumpNetmap();

      logAuditEvent({
        eventType: 'NODE_QUARANTINE',
        severity: 'warn',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: node.id,
        targetType: 'node',
        message: `Node ${node.id} quarantined: ${reason}`,
        ipAddress: req.ip
      });

      await broadcastNodeEvent('NODE_QUARANTINE', { id: node.id, is_quarantined: true, reason }, req.user);

      return res.status(200).json({
        success: true,
        result: {
          is_quarantined: true,
          status: 'quarantined'
        }
      });
    }

    if (action === 'lift_quarantine') {
      await pool.query(
        `
        UPDATE nodes SET
          is_quarantined = FALSE,
          is_healthy = TRUE,
          quarantine_reason = NULL,
          updated_at = NOW()
        WHERE id = $1
      `,
        [node.id]
      );

      await bumpNetmap();

      logAuditEvent({
        eventType: 'NODE_LIFT_QUARANTINE',
        severity: 'info',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: node.id,
        targetType: 'node',
        message: `Quarantine lifted for node ${node.id}`,
        ipAddress: req.ip
      });

      await broadcastNodeEvent('NODE_LIFT_QUARANTINE', { id: node.id, is_quarantined: false }, req.user);

      return res.status(200).json({
        success: true,
        result: {
          is_quarantined: false,
          status: 'active'
        }
      });
    }

    if (action === 'set_transport') {
      const allowedTransports = ['wireguard', 'amneziawg', 'openvpn', 'vless'];
      const transport = req.body.transport || req.body.params?.transport;
      if (!transport || !allowedTransports.includes(transport)) {
        return res.status(400).json({ error: `Invalid transport. Allowed: ${allowedTransports.join(', ')}` });
      }

      const stealth_config = req.body.stealth_config || req.body.params?.stealth_config || null;

      await pool.query(
        `UPDATE nodes SET transport = $1, stealth_config = $2, updated_at = NOW() WHERE id = $3`,
        [transport, stealth_config ? JSON.stringify(stealth_config) : null, node.id]
      );

      await bumpNetmap();

      logAuditEvent({
        eventType: 'NODE_SET_TRANSPORT',
        severity: 'info',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: node.id,
        targetType: 'node',
        message: `Node ${node.id} transport set to ${transport}`,
        ipAddress: req.ip,
        metadata: { transport, stealth_config }
      });

      const updatedRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [node.id]);
      const formatted = formatNode(updatedRes.rows[0]);

      await broadcastNodeEvent('NODE_ACTION_TRANSPORT', formatted, req.user);

      return res.status(200).json({
        success: true,
        transport,
        stealth_config,
        node: formatted
      });
    }

    if (action === 'set_daita') {
      const allowedModes = ['off', 'balanced', 'paranoid'];
      const mode = req.body.daita_mode || req.body.mode || req.body.params?.daita_mode || req.body.params?.mode;
      if (!mode || !allowedModes.includes(mode)) {
        return res.status(400).json({ error: `Invalid daita_mode. Allowed: ${allowedModes.join(', ')}` });
      }

      await pool.query(
        `UPDATE nodes SET daita_mode = $1, updated_at = NOW() WHERE id = $2`,
        [mode, node.id]
      );

      await bumpNetmap();

      logAuditEvent({
        eventType: 'NODE_SET_DAITA',
        severity: 'info',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: node.id,
        targetType: 'node',
        message: `Node ${node.id} DAITA mode set to ${mode}`,
        ipAddress: req.ip,
        metadata: { daita_mode: mode }
      });

      const updatedRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [node.id]);
      const formatted = formatNode(updatedRes.rows[0]);

      await broadcastNodeEvent('NODE_ACTION_DAITA', formatted, req.user);

      return res.status(200).json({
        success: true,
        daita_mode: mode,
        node: formatted
      });
    }

    if (action === 'set_dns_name') {
      const dnsName = req.body.dns_name || req.body.params?.dns_name;
      if (!dnsName || typeof dnsName !== 'string') {
        return res.status(400).json({ error: 'dns_name string is required' });
      }

      await pool.query(
        `UPDATE nodes SET dns_name = $1, updated_at = NOW() WHERE id = $2`,
        [dnsName.toLowerCase().trim(), node.id]
      );

      await bumpNetmap();

      logAuditEvent({
        eventType: 'NODE_SET_DNS_NAME',
        severity: 'info',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: node.id,
        targetType: 'node',
        message: `Node ${node.id} DNS name set to ${dnsName}`,
        ipAddress: req.ip,
        metadata: { dns_name: dnsName }
      });

      const updatedRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [node.id]);
      const formatted = formatNode(updatedRes.rows[0]);

      await broadcastNodeEvent('NODE_ACTION_DNS_NAME', formatted, req.user);

      return res.status(200).json({
        success: true,
        dns_name: dnsName,
        node: formatted
      });
    }

    return res.status(400).json({ error: `Unsupported action '${action}'` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
