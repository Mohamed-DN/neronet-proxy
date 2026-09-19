const express = require('express');
const { readPageParams, pageEnvelope } = require('../utils/pagination');
const { requireNodeOwnership } = require('../middleware/ownership');
const router = express.Router();
const crypto = require('crypto');
const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const { authenticateToken } = require('../middleware/auth');
const { logAuditEvent } = require('../utils/audit');
const { allocateNextVip, generateCurve25519Keypair } = require('../utils/crypto');
const { broadcastNodeEvent } = require('../services/TopologySync');

router.use(authenticateToken);

function parseJsonField(val, defaultVal = {}) {
  if (!val) return defaultVal;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
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
  const posture = parseJsonField(row.posture_checks, {
    compliant: !isQuarantined,
    os: 'Linux',
    disk_encrypted: true
  });
  const metadata = parseJsonField(row.metadata, {});

  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    public_key: row.public_key,
    overlay_ipv4: row.overlay_ipv4,
    overlay_ipv6: row.overlay_ipv6,
    role: row.role,
    ip_class: row.ip_class,
    country_code: row.country_code,
    city: row.city || '',
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
    metadata,
    last_heartbeat: row.last_heartbeat,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// 1. List Nodes (Scoped by Super-Admin vs Regular User)
router.get('/', async (req, res, next) => {
  try {
    const { limit, offset } = readPageParams(req);
    const scoped = req.user.role !== 'super-admin';

    // ORDER BY created_at alone is not a stable sort: rows sharing a timestamp can
    // come back in any order between pages, so a client paging through the fleet
    // would see some nodes twice and miss others. The primary key breaks the tie.
    let rows = [];
    let total = 0;

    if (isPostgres()) {
      const pool = getPgPool();
      if (scoped) {
        const countRes = await pool.query('SELECT count(*)::int AS n FROM nodes WHERE user_id = $1', [req.user.id]);
        total = countRes.rows[0].n;
        const result = await pool.query(
          'SELECT * FROM nodes WHERE user_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3',
          [req.user.id, limit, offset]
        );
        rows = result.rows;
      } else {
        const countRes = await pool.query('SELECT count(*)::int AS n FROM nodes');
        total = countRes.rows[0].n;
        const result = await pool.query('SELECT * FROM nodes ORDER BY created_at ASC, id ASC LIMIT $1 OFFSET $2', [
          limit,
          offset
        ]);
        rows = result.rows;
      }
    } else {
      const db = getDatabase();
      if (scoped) {
        total = db.prepare('SELECT count(*) AS n FROM nodes WHERE user_id = ?').get(req.user.id).n;
        rows = db
          .prepare('SELECT * FROM nodes WHERE user_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?')
          .all(req.user.id, limit, offset);
      } else {
        total = db.prepare('SELECT count(*) AS n FROM nodes').get().n;
        rows = db.prepare('SELECT * FROM nodes ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?').all(limit, offset);
      }
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

    // Quota check for regular users
    if (req.user.role !== 'super-admin') {
      // Node count is no longer capped per user. NeroNet has no paid tiers, and a
      // per-account limit was a commercial boundary rather than a technical one: the
      // overlay pool holds 4.19 million addresses and enrolment is rate limited, so
      // the infrastructure protections that matter are elsewhere.
    }

    let finalPubKey = public_key;
    if (!finalPubKey) {
      const kp = generateCurve25519Keypair();
      finalPubKey = kp.publicKeyBase64;
    }

    const VALID_ROLES = ['CLIENT_ORIGIN', 'EXIT_BRIDGE', 'HYBRID', 'RELAY'];
    const VALID_IP_CLASSES = ['RESIDENTIAL', 'MOBILE_5G', 'DATACENTER', 'UNKNOWN'];

    const nodeRole = role && VALID_ROLES.includes(role) ? role : 'CLIENT_ORIGIN';
    const nodeIpClass = ip_class && VALID_IP_CLASSES.includes(ip_class) ? ip_class : 'RESIDENTIAL';
    const nodeCountry = country_code || 'US';
    const onionRouting = onion_routing_enabled !== undefined ? Boolean(onion_routing_enabled) : Number(onion_hops) > 0;
    const hops = onionRouting ? (Number(onion_hops) > 0 ? Number(onion_hops) : 3) : 0;
    const killSwitch = Boolean(kill_switch_enabled);
    const endpointsArray = Array.isArray(endpoints) ? endpoints : [];
    const nodeId = `svrn-node-${crypto.randomBytes(4).toString('hex')}`;

    let createdNode = null;

    if (isPostgres()) {
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
          id, user_id, name, public_key, overlay_ipv4, overlay_ipv6,
          role, ip_class, country_code, city, asn, endpoints,
          onion_routing_enabled, onion_hops, kill_switch_enabled, is_healthy, is_quarantined, latency_ms,
          longitude, latitude, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12::jsonb,
          $13, $14, $15, TRUE, FALSE, 15.0,
          $16, $17, $18::jsonb
        )
      `,
        [
          nodeId,
          req.user.id,
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

      const nodeRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [nodeId]);
      createdNode = formatNode(nodeRes.rows[0]);
    } else {
      const db = getDatabase();
      const existingKey = db.prepare('SELECT id FROM nodes WHERE public_key = ?').get(finalPubKey);
      if (existingKey) {
        return res.status(409).json({ error: 'Public key already registered' });
      }

      const { overlayIpv4, overlayIpv6 } = await allocateNextVip(db);

      db.prepare(
        `
        INSERT INTO nodes (
          id, user_id, name, public_key, overlay_ipv4, overlay_ipv6,
          role, ip_class, country_code, city, asn, endpoints,
          onion_routing_enabled, onion_hops, kill_switch_enabled, is_healthy, is_quarantined, latency_ms
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, 1, 0, 15.0
        )
      `
      ).run(
        nodeId,
        req.user.id,
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
        onionRouting ? 1 : 0,
        hops,
        killSwitch ? 1 : 0
      );

      createdNode = formatNode(db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId));
    }

    logAuditEvent({
      eventType: 'NODE_REGISTER',
      severity: 'info',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: nodeId,
      targetType: 'node',
      message: `Node ${name} registered`,
      ipAddress: req.ip
    });

    // Broadcast real-time topology sync event
    await broadcastNodeEvent('NODE_REGISTER', createdNode, req.user);

    return res.status(201).json({ node: createdNode });
  } catch (err) {
    next(err);
  }
});

// 3. Get Node By ID
router.get('/:id', async (req, res, next) => {
  try {
    let node = null;
    if (isPostgres()) {
      const pool = getPgPool();
      const resNode = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
      node = resNode.rows[0] || null;
    } else {
      const db = getDatabase();
      node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id) || null;
    }

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    if (req.user.role !== 'super-admin' && node.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access forbidden' });
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

    let existing = null;
    if (isPostgres()) {
      const pool = getPgPool();
      const nodeRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
      existing = nodeRes.rows[0] || null;
    } else {
      const db = getDatabase();
      existing = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id) || null;
    }

    if (!existing) {
      return res.status(404).json({ error: 'Node not found' });
    }
    if (req.user.role !== 'super-admin' && existing.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access forbidden' });
    }

    let updatedNode = null;

    if (isPostgres()) {
      const pool = getPgPool();
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
      updatedNode = formatNode(resUp.rows[0]);
    } else {
      const db = getDatabase();
      const updates = [];
      const params = [];

      if (req.body.name) {
        updates.push('name = ?');
        params.push(req.body.name);
      }
      if (req.body.latency_ms !== undefined) {
        updates.push('latency_ms = ?');
        params.push(Number(req.body.latency_ms));
      }
      if (req.body.is_healthy !== undefined) {
        updates.push('is_healthy = ?');
        params.push(req.body.is_healthy ? 1 : 0);
      }
      if (req.body.role) {
        updates.push('role = ?');
        params.push(req.body.role);
      }
      if (req.body.kill_switch_enabled !== undefined) {
        updates.push('kill_switch_enabled = ?');
        params.push(req.body.kill_switch_enabled ? 1 : 0);
      }
      if (req.body.onion_routing_enabled !== undefined) {
        const on = req.body.onion_routing_enabled ? 1 : 0;
        updates.push('onion_routing_enabled = ?');
        params.push(on);
        updates.push('onion_hops = ?');
        params.push(on ? 3 : 0);
      } else if (req.body.onion_hops !== undefined) {
        const hops = Number(req.body.onion_hops);
        updates.push('onion_routing_enabled = ?');
        params.push(hops > 0 ? 1 : 0);
        updates.push('onion_hops = ?');
        params.push(hops);
      }
      if (req.body.status) {
        if (req.body.status === 'quarantined') {
          updates.push('is_quarantined = 1, is_healthy = 0');
        } else if (req.body.status === 'active') {
          updates.push('is_quarantined = 0, is_healthy = 1');
        }
      }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        params.push(req.params.id);
        db.prepare(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }

      updatedNode = formatNode(db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id));
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
    let node = null;
    if (isPostgres()) {
      const pool = getPgPool();
      const nodeRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
      node = nodeRes.rows[0] || null;
      if (!node) {
        return res.status(404).json({ error: 'Node not found' });
      }
      if (req.user.role !== 'super-admin' && node.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access forbidden' });
      }

      await pool.query('DELETE FROM nodes WHERE id = $1', [req.params.id]);
    } else {
      const db = getDatabase();
      node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
      if (!node) {
        return res.status(404).json({ error: 'Node not found' });
      }
      if (req.user.role !== 'super-admin' && node.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access forbidden' });
      }

      db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
    }

    logAuditEvent({
      eventType: 'NODE_REVOKE',
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: req.params.id,
      targetType: 'node',
      message: `Node ${node.name} (${req.params.id}) revoked`,
      ipAddress: req.ip
    });

    await broadcastNodeEvent('NODE_DELETE', { id: req.params.id, name: node.name, user_id: node.user_id }, req.user);

    return res.status(200).json({ success: true, message: 'Node revoked successfully' });
  } catch (err) {
    next(err);
  }
});

// 6. Node Heartbeat
// Without this any tenant could write fabricated telemetry onto another's device.
router.post('/:id/heartbeat', requireNodeOwnership, async (req, res, next) => {
  try {
    const { latency_ms, rx_bytes, tx_bytes, cpu_usage_pct, memory_usage_pct, battery_pct } = req.body || {};

    if (isPostgres()) {
      const pool = getPgPool();
      const nodeRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
      if (nodeRes.rows.length === 0) {
        return res.status(404).json({ error: 'Node not found' });
      }

      await pool.query(
        `
        UPDATE nodes SET
          last_heartbeat = NOW(),
          latency_ms = COALESCE($1, latency_ms),
          rx_bytes = COALESCE($2, rx_bytes),
          tx_bytes = COALESCE($3, tx_bytes),
          cpu_usage_pct = COALESCE($4, cpu_usage_pct),
          memory_usage_pct = COALESCE($5, memory_usage_pct),
          battery_pct = COALESCE($6, battery_pct),
          is_healthy = TRUE,
          updated_at = NOW()
        WHERE id = $7
      `,
        [
          latency_ms !== undefined ? Number(latency_ms) : null,
          rx_bytes !== undefined ? Number(rx_bytes) : null,
          tx_bytes !== undefined ? Number(tx_bytes) : null,
          cpu_usage_pct !== undefined ? Number(cpu_usage_pct) : null,
          memory_usage_pct !== undefined ? Number(memory_usage_pct) : null,
          battery_pct !== undefined ? Number(battery_pct) : null,
          req.params.id
        ]
      );
    } else {
      const db = getDatabase();
      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
      if (!node) {
        return res.status(404).json({ error: 'Node not found' });
      }

      db.prepare(
        `
        UPDATE nodes SET
          last_heartbeat = datetime('now'),
          latency_ms = COALESCE(?, latency_ms),
          rx_bytes = COALESCE(?, rx_bytes),
          tx_bytes = COALESCE(?, tx_bytes),
          cpu_usage_pct = COALESCE(?, cpu_usage_pct),
          memory_usage_pct = COALESCE(?, memory_usage_pct),
          battery_pct = COALESCE(?, battery_pct),
          is_healthy = 1,
          updated_at = datetime('now')
        WHERE id = ?
      `
      ).run(
        latency_ms !== undefined ? latency_ms : null,
        rx_bytes !== undefined ? rx_bytes : null,
        tx_bytes !== undefined ? tx_bytes : null,
        cpu_usage_pct !== undefined ? cpu_usage_pct : null,
        memory_usage_pct !== undefined ? memory_usage_pct : null,
        battery_pct !== undefined ? battery_pct : null,
        req.params.id
      );
    }

    return res.status(200).json({ success: true, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// 7. Node Actions: ping, set_exit, quarantine, lift_quarantine, toggle_onion, set_onion
router.post('/:id/action', async (req, res, next) => {
  try {
    let node = null;
    if (isPostgres()) {
      const pool = getPgPool();
      const nodeRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
      node = nodeRes.rows[0] || null;
    } else {
      const db = getDatabase();
      node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id) || null;
    }

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    if (req.user.role !== 'super-admin' && node.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access forbidden' });
    }

    const { action } = req.body || {};
    if (!action) {
      return res.status(400).json({ error: 'Missing action parameter' });
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
      if (isPostgres()) {
        const pool = getPgPool();
        await pool.query("UPDATE nodes SET role = 'EXIT_BRIDGE', updated_at = NOW() WHERE id = $1", [node.id]);
      } else {
        const db = getDatabase();
        db.prepare("UPDATE nodes SET role = 'EXIT_BRIDGE', updated_at = datetime('now') WHERE id = ?").run(node.id);
      }

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
      let updatedRow = null;

      if (isPostgres()) {
        const pool = getPgPool();
        await pool.query(
          'UPDATE nodes SET onion_routing_enabled = $1, onion_hops = $2, updated_at = NOW() WHERE id = $3',
          [newVal, hops, node.id]
        );
        const resUp = await pool.query('SELECT * FROM nodes WHERE id = $1', [node.id]);
        updatedRow = resUp.rows[0];
      } else {
        const db = getDatabase();
        db.prepare(
          "UPDATE nodes SET onion_routing_enabled = ?, onion_hops = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(newVal ? 1 : 0, hops, node.id);
        updatedRow = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.id);
      }

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

      if (isPostgres()) {
        const pool = getPgPool();
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
      } else {
        const db = getDatabase();
        db.prepare(
          `
          UPDATE nodes SET
            is_quarantined = 1,
            is_healthy = 0,
            quarantine_reason = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `
        ).run(reason, node.id);
      }

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
      if (isPostgres()) {
        const pool = getPgPool();
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
      } else {
        const db = getDatabase();
        db.prepare(
          `
          UPDATE nodes SET
            is_quarantined = 0,
            is_healthy = 1,
            quarantine_reason = NULL,
            updated_at = datetime('now')
          WHERE id = ?
        `
        ).run(node.id);
      }

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

    return res.status(400).json({ error: `Unsupported action '${action}'` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
