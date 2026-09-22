const express = require('express');
const router = express.Router();
const { getPgPool } = require('../db/index');
const { authenticateToken } = require('../middleware/auth');
const { resolveUserOrg } = require('../middleware/rbac');
const { readFleetState, readPostureCounts, LIVENESS_WINDOW_SECONDS } = require('../services/MetricsCollector');
const { COUNTRY_NAMES } = require('../utils/countries');
const AclEngine = require('../services/AclEngine');

router.use(authenticateToken);
router.use(resolveUserOrg);

// 1. Overview Statistics
//
// Every figure here is read from the fleet. The previous version returned constants
// for throughput (88.4 / 64.1 MB/s) and for the health score (98.4) regardless of
// what the nodes were doing, including when none of them were running, so the
// console reported a healthy loaded network against an empty database.
async function overviewHandler(req, res, next) {
  try {
    const accessTier = req.user?.compartment_access || req.user?.access_tier || 'standard';
    const state = await readFleetState(accessTier);

    // Two consecutive samples give a rate. With fewer than two the rate is unknown,
    // and unknown is reported as null rather than as a plausible-looking number:
    // the console renders null as a dash, which is the honest thing to show.
    const rates = await deriveThroughput();

    // The Overview used to derive a "compliant" count as active minus quarantined,
    // which is a liveness figure wearing a compliance label. These three are counted
    // from what each node actually attested.
    const posture = await readPostureCounts(accessTier);

    return res.status(200).json({
      active_nodes: state.liveNodes,
      total_nodes: state.enrolledNodes,
      quarantined_nodes: state.quarantinedNodes,
      connected_users: state.activeUsers,
      active_users: state.activeUsers,
      total_bandwidth_rx_mb_s: rates.rxMbPerSec,
      total_bandwidth_tx_mb_s: rates.txMbPerSec,
      total_bandwidth_bytes: state.rxBytes + state.txBytes,
      total_rx_bytes: state.rxBytes,
      total_tx_bytes: state.txBytes,
      country_distribution: await countryDistribution(accessTier),
      posture_verified_compliant_nodes: posture.verified_compliant,
      posture_unverified_nodes: posture.unverified,
      posture_non_compliant_nodes: posture.non_compliant,
      // null when no node reported a measured CPU value. Nothing samples CPU on a
      // node yet, so this is null on every current deployment; 0 would read as an
      // idle fleet.
      avg_cpu_pct: state.cpuPct,
      avg_memory_pct: state.memPct,
      system_health: `${state.healthScore}%`,
      network_health_score: state.healthScore,
      liveness_window_seconds: LIVENESS_WINDOW_SECONDS
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Turns the two most recent cumulative samples into a rate.
 *
 * Returns nulls when there is not enough history, and when the counters have gone
 * backwards. Counters decrease when a node restarts and resets its own counter, or
 * when a node leaves the fleet; treating that as negative traffic would draw a
 * downward spike that never happened.
 */
async function deriveThroughput() {
  const unknown = { rxMbPerSec: null, txMbPerSec: null };
  const pool = getPgPool();
  const q = await pool.query(
    'SELECT timestamp, total_bandwidth_rx, total_bandwidth_tx FROM system_metrics ORDER BY timestamp DESC LIMIT 2'
  );
  const rows = q.rows;

  if (rows.length < 2) {
    return unknown;
  }

  const [latest, prior] = rows;
  const seconds = (new Date(latest.timestamp) - new Date(prior.timestamp)) / 1000;
  if (!(seconds > 0)) {
    return unknown;
  }

  const rxDelta = Number(latest.total_bandwidth_rx) - Number(prior.total_bandwidth_rx);
  const txDelta = Number(latest.total_bandwidth_tx) - Number(prior.total_bandwidth_tx);
  if (rxDelta < 0 || txDelta < 0) {
    return unknown;
  }

  const toMbPerSec = (bytes) => Number((bytes / (1024 * 1024) / seconds).toFixed(2));
  return { rxMbPerSec: toMbPerSec(rxDelta), txMbPerSec: toMbPerSec(txDelta) };
}

async function countryDistribution(accessTier = 'standard') {
  const dist = {};
  const pool = getPgPool();
  const hiddenClause =
    accessTier === 'root'
      ? ''
      : ' LEFT JOIN compartments c ON nodes.compartment_id = c.id WHERE (c.is_hidden IS NULL OR c.is_hidden = FALSE)';
  const q = await pool.query(`SELECT country_code, count(*) AS count FROM nodes ${hiddenClause} GROUP BY country_code`);
  for (const r of q.rows) dist[r.country_code] = parseInt(r.count, 10);
  return dist;
}

router.get('/', overviewHandler);
router.get('/overview', overviewHandler);

// 2. Bandwidth Timeseries
//
// Returns the samples the collector recorded. When there are none it returns an
// empty series rather than a synthetic ramp, so a fresh deployment shows that it
// has no history yet instead of a day of traffic that never happened.
// Ranges the console's selector offers. Anything else falls back to 24 hours rather
// than letting a caller ask for an unbounded scan of the table.
const RANGE_HOURS = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };

async function timeseriesHandler(req, res, next) {
  try {
    const hours = RANGE_HOURS[req.query.range] || 24;

    const pool = getPgPool();
    const q = await pool.query(
      `SELECT timestamp, total_bandwidth_rx, total_bandwidth_tx, active_nodes,
              cpu_usage_pct, memory_usage_mb, network_health_score
       FROM system_metrics
       WHERE timestamp > now() - make_interval(hours => $1)
       ORDER BY timestamp ASC`,
      [hours]
    );
    const metrics = q.rows;

    // The stored counters are cumulative. The chart wants a rate, so each point is
    // the difference from the point before it; the first sample has no predecessor
    // and is therefore the baseline rather than a data point.
    const series = [];
    for (let i = 1; i < metrics.length; i++) {
      const prev = metrics[i - 1];
      const cur = metrics[i];
      const seconds = (new Date(cur.timestamp) - new Date(prev.timestamp)) / 1000;
      if (!(seconds > 0)) continue;

      const rxDelta = Number(cur.total_bandwidth_rx) - Number(prev.total_bandwidth_rx);
      const txDelta = Number(cur.total_bandwidth_tx) - Number(prev.total_bandwidth_tx);
      const rate = (bytes) => (bytes < 0 ? 0 : Number((bytes / (1024 * 1024) / seconds).toFixed(3)));

      series.push({
        timestamp: cur.timestamp,
        time: new Date(cur.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        rx: rate(rxDelta),
        tx: rate(txDelta),
        rx_bytes: Number(cur.total_bandwidth_rx),
        tx_bytes: Number(cur.total_bandwidth_tx),
        active_nodes: cur.active_nodes,
        cpu_usage_pct: cur.cpu_usage_pct,
        memory_usage_mb: cur.memory_usage_mb,
        health_score: cur.network_health_score
      });
    }

    if (req.path === '/bandwidth') {
      return res.status(200).json({ bandwidth_series: series });
    }
    return res.status(200).json(series);
  } catch (err) {
    next(err);
  }
}

router.get('/bandwidth', timeseriesHandler);
router.get('/timeseries', timeseriesHandler);

// 3. Geographic Distribution
//
// Built from the nodes that exist. The previous version walked a fixed list of six
// countries and reported at least one node in each, so the console showed presence
// in the United Kingdom and Canada on a fleet that had never had a node in either.
async function geoMatrixHandler(req, res, next) {
  try {
    const pool = getPgPool();
    const accessTier = req.user?.compartment_access || req.user?.access_tier || 'standard';
    const hiddenClause =
      accessTier === 'root'
        ? ''
        : ' LEFT JOIN compartments c ON nodes.compartment_id = c.id WHERE (c.is_hidden IS NULL OR c.is_hidden = FALSE)';

    const sql = `
      SELECT
        country_code,
        count(*) AS nodes,
        count(*) FILTER (WHERE role = 'RELAY') AS relays,
        count(*) FILTER (WHERE role = 'EXIT_BRIDGE') AS exits,
        count(*) FILTER (WHERE last_heartbeat > now() - make_interval(secs => $1)) AS live,
        avg(latency_ms) FILTER (WHERE latency_ms > 0) AS avg_latency
      FROM nodes
      ${hiddenClause}
      GROUP BY country_code
      ORDER BY count(*) DESC, country_code ASC`;

    const q = await pool.query(sql, [LIVENESS_WINDOW_SECONDS]);
    const rows = q.rows;

    const matrix = rows.map((r) => {
      const nodes = Number(r.nodes);
      const live = Number(r.live);
      const latency =
        r.avg_latency === null || r.avg_latency === undefined ? null : Number(Number(r.avg_latency).toFixed(1));

      return {
        country: COUNTRY_NAMES[r.country_code] || r.country_code,
        code: r.country_code,
        nodes,
        live,
        relays: Number(r.relays),
        exits: Number(r.exits),
        // Null means no node in this country has reported a measurement yet, which
        // is different from a measurement of zero.
        avg_latency: latency,
        status: live === 0 ? 'Offline' : live < nodes ? 'Degraded' : 'Online'
      };
    });

    return res.status(200).json(matrix);
  } catch (err) {
    next(err);
  }
}

router.get('/geo', geoMatrixHandler);
router.get('/geo-matrix', geoMatrixHandler);

// 4. Topology (Global vs User-Scoped)
async function topologyHandler(req, res, next) {
  try {
    let visibleNodes = [];
    const pool = getPgPool();
    const accessTier = req.user.compartment_access || req.user.access_tier || 'standard';
    const hiddenClause = accessTier === 'root' ? '' : ' AND (c.is_hidden IS NULL OR c.is_hidden = FALSE)';

    const isSuperAdmin = req.user.role === 'super-admin';
    const orgRole = req.user.org_role || req.user.role;
    const isOrgPrivileged = ['owner', 'admin', 'network_admin', 'auditor'].includes(orgRole);

    if (isSuperAdmin && !req.query.org_id) {
      const qRes = await pool.query(
        `SELECT n.id, n.name, n.role, n.country_code, n.overlay_ipv4, n.is_healthy, n.latency_ms
         FROM nodes n
         LEFT JOIN compartments c ON n.compartment_id = c.id
         WHERE 1=1 ${hiddenClause}
         ORDER BY n.created_at ASC`
      );
      visibleNodes = qRes.rows;
    } else if (isOrgPrivileged || isSuperAdmin) {
      const orgId = isSuperAdmin ? req.query.org_id : req.user.organization_id || 'org-default';
      const qRes = await pool.query(
        `SELECT n.id, n.name, n.role, n.country_code, n.overlay_ipv4, n.is_healthy, n.latency_ms
         FROM nodes n
         LEFT JOIN compartments c ON n.compartment_id = c.id
         WHERE n.organization_id = $1 ${hiddenClause}
         ORDER BY n.created_at ASC`,
        [orgId]
      );
      visibleNodes = qRes.rows;
    } else {
      const qRes = await pool.query(
        `SELECT n.id, n.name, n.role, n.country_code, n.overlay_ipv4, n.is_healthy, n.latency_ms
         FROM nodes n
         LEFT JOIN compartments c ON n.compartment_id = c.id
         WHERE n.user_id = $1 ${hiddenClause}
         ORDER BY n.created_at ASC`,
        [req.user.id]
      );
      visibleNodes = qRes.rows;
    }

    const nodes = visibleNodes.map((n) => ({
      id: n.id,
      name: n.name,
      role: n.role,
      country: n.country_code || 'US',
      overlay_ipv4: n.overlay_ipv4,
      is_healthy: Boolean(n.is_healthy),
      // Zero means the node has not reported a round trip yet. It used to be
      // replaced with 15.0, which read as a measurement.
      latency_ms: Number(n.latency_ms) > 0 ? Number(n.latency_ms) : null
    }));

    // Links are the paths the policy permits, compiled by the same engine that
    // hands each node its ACLs, so the view and the enforcement cannot disagree.
    //
    // What was here before was a full mesh of the first ten nodes with an rtt_ms of
    // (a.latency + b.latency) / 2 — the mean of two nodes' round trips to the
    // control plane, which is not the round trip between them and was labelled as
    // if it were. Nodes do not probe each other, so no per-link latency is reported.
    const { links, policyIsOpen } = await compileTopologyLinks(nodes);

    return res.status(200).json({
      nodes,
      links,
      total_nodes: nodes.length,
      // True when no ACL rule exists. pkg/acl is default-deny, so the control plane
      // compiles allow-all in that case: the mesh is open until the first rule is
      // written, and the console should say so rather than presenting a full mesh
      // as a configured one.
      policy_is_open: policyIsOpen,
      mesh_scope: req.user.role === 'super-admin' ? 'global' : 'user_isolated'
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Derives the edges of the topology from the compiled ACL policy.
 *
 * One compile per node is the same work the control plane does when a node syncs,
 * and it is bounded by the number of nodes the caller can see. An edge is added
 * once per unordered pair: A permitted to reach B and B permitted to reach A is one
 * line on screen, not two.
 */
async function compileTopologyLinks(nodes) {
  const byVip = new Map();
  for (const n of nodes) {
    if (n.overlay_ipv4) byVip.set(n.overlay_ipv4, n.id);
  }

  const seen = new Set();
  const links = [];
  let policyIsOpen = false;

  for (const node of nodes) {
    const policy = await AclEngine.compilePolicyFor(node.id);
    if (!policy) continue;

    // An allow-all compilation is marked by non-directional rules, which is what
    // AclEngine emits when the rule table is empty.
    if (policy.outbound_rules.some((r) => r.is_directional === false)) {
      policyIsOpen = true;
    }

    for (const rule of policy.outbound_rules) {
      if (rule.action !== 'ACCEPT') continue;

      const peerId = byVip.get(rule.allowed_peer_vip);
      if (!peerId || peerId === node.id) continue;

      const key = node.id < peerId ? `${node.id}|${peerId}` : `${peerId}|${node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      links.push({ source: node.id, target: peerId, protocol: rule.protocol });
    }
  }

  return { links, policyIsOpen };
}

router.get('/topology', topologyHandler);

// 5. Audit Logs / Events
async function auditLogsHandler(req, res, next) {
  try {
    // Was a hardcoded 100 with the caller's ?limit ignored, so a console asking for
    // more silently got a truncated ledger and no indication it had been cut.
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);

    let rows = [];
    const pool = getPgPool();
    if (req.user.role === 'super-admin') {
      const qRes = await pool.query('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT $1', [limit]);
      rows = qRes.rows;
    } else {
      const qRes = await pool.query(
        'SELECT * FROM audit_events WHERE actor_user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [req.user.id, limit]
      );
      rows = qRes.rows;
    }

    const logs = rows.map((r) => ({
      id: `audit-${r.id.toString().padStart(4, '0')}`,
      timestamp: r.created_at,
      // The console reads created_at and actor_username, the column names. Both
      // were renamed on the way out and only the renamed forms were sent, so the
      // date and actor columns rendered empty.
      created_at: r.created_at,
      actor: r.actor_username || 'system',
      actor_username: r.actor_username || 'system',
      actor_user_id: r.actor_user_id,
      action: r.event_type,
      event_type: r.event_type,
      resource: r.target_id || r.target_type || 'system',
      severity: r.severity,
      status: r.severity === 'error' ? 'failed' : 'success',
      message: r.message,
      ip_address: r.ip_address,
      // r.metadata does not exist; the column is metadata_json. Reading the wrong
      // name first meant the fallback did the work and a JSON string was never
      // parsed, so details arrived as text where an object was expected.
      details: parseDetails(r.metadata_json)
    }));

    return res.status(200).json({ audit_logs: logs, total: logs.length });
  } catch (err) {
    next(err);
  }
}

function parseDetails(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    // Keep it rather than losing it: an audit record's metadata is evidence.
    return { unparsed: String(value) };
  }
}

router.get('/audit-logs', auditLogsHandler);
router.get('/events', auditLogsHandler);
router.get('/logs', auditLogsHandler);

// WP-301: Cryptographic Chain Verification Endpoint
router.get('/verify', async (req, res, next) => {
  try {
    const { AuditChainService } = require('../services/AuditChainService');
    const fromSeq = req.query.from ? Number(req.query.from) : 1;
    const toSeq = req.query.to ? Number(req.query.to) : null;

    const report = await AuditChainService.verifyChain({
      fromSequence: fromSeq,
      toSequence: toSeq
    });

    return res.status(200).json({ verification: report });
  } catch (err) {
    next(err);
  }
});

// WP-301: Checkpoints Endpoints
router.post('/checkpoints', async (req, res, next) => {
  try {
    const { AuditChainService } = require('../services/AuditChainService');
    const checkpoint = await AuditChainService.createCheckpoint();
    return res.status(201).json({ checkpoint });
  } catch (err) {
    next(err);
  }
});

router.get('/checkpoints', async (req, res, next) => {
  try {
    const { AuditChainService } = require('../services/AuditChainService');
    const pool = getPgPool();
    const qRes = await pool.query('SELECT * FROM audit_checkpoints ORDER BY created_at DESC LIMIT 50');
    return res.status(200).json({
      checkpoints: qRes.rows,
      public_key: Buffer.from(AuditChainService.getPublicKey()).toString('base64')
    });
  } catch (err) {
    next(err);
  }
});

// WP-301: SIEM Destinations
router.get('/siem', async (req, res, next) => {
  try {
    const pool = getPgPool();
    const qRes = await pool.query('SELECT * FROM audit_siem_destinations ORDER BY created_at DESC');
    return res.status(200).json({ destinations: qRes.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/siem', async (req, res, next) => {
  try {
    const { id, name, protocol, endpoint, format = 'rfc5424' } = req.body || {};
    if (!name || !protocol || !endpoint) {
      return res.status(400).json({ error: 'name, protocol, and endpoint are required' });
    }
    const destId = id || `siem-${Date.now()}`;
    const pool = getPgPool();
    const qRes = await pool.query(
      `INSERT INTO audit_siem_destinations (id, name, protocol, endpoint, format, enabled)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING *`,
      [destId, name, protocol, endpoint, format]
    );
    return res.status(201).json({ destination: qRes.rows[0] });
  } catch (err) {
    next(err);
  }
});

// WP-306: Disaster Recovery Backup Proof Endpoints
router.get('/recovery-proof/latest', async (req, res, next) => {
  try {
    const { BackupRecoveryProofService } = require('../services/BackupRecoveryProofService');
    const pool = getPgPool();
    const latest = await BackupRecoveryProofService.getLatestProof(pool);
    return res.status(200).json({ proof: latest });
  } catch (err) {
    next(err);
  }
});

router.post('/recovery-proof/verify', async (req, res, next) => {
  try {
    if (req.user?.role !== 'super-admin') {
      return res.status(403).json({ error: 'Forbidden: only super-admin can trigger disaster recovery verification' });
    }

    const { targetDbUrl, targetDbName = 'ephemeral_recovery' } = req.body || {};
    const { BackupRecoveryProofService } = require('../services/BackupRecoveryProofService');
    const { Pool } = require('pg');
    const pool = getPgPool();

    let targetPool = pool;
    let customTarget = false;
    if (targetDbUrl) {
      targetPool = new Pool({ connectionString: targetDbUrl });
      customTarget = true;
    }

    try {
      const proof = await BackupRecoveryProofService.verifyRestoredDatabase({
        sourcePool: pool,
        targetPool,
        sourceDbName: 'primary',
        targetDbName,
        actorUserId: req.user.id
      });
      return res.status(201).json({ proof });
    } finally {
      if (customTarget) {
        await targetPool.end().catch(() => {});
      }
    }
  } catch (err) {
    next(err);
  }
});

// WP-307: High Availability Distributed Leadership Status
router.get('/ha-leader', (req, res) => {
  const { getDistributedLeaderService } = require('../services/DistributedLeaderService');
  const leaderService = getDistributedLeaderService();
  return res.status(200).json({ leader: leaderService.getStatus() });
});

module.exports = router;

