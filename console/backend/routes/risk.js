const express = require('express');
const { requireNodeOwnership } = require('../middleware/ownership');
const router = express.Router();
const RiskEngine = require('../services/RiskEngine');
const { authenticateToken } = require('../middleware/auth');
const { isPostgres, getPgPool, getDatabase } = require('../db/index');

router.use(authenticateToken);

// 2. List All Node Risk Scores
router.get('/scores', async (req, res, next) => {
  try {
    const risk_scores = await RiskEngine.getAllRiskScores();
    return res.status(200).json({ risk_scores });
  } catch (err) {
    next(err);
  }
});

// 3. Behavioral Risk Dashboard Summary
router.get('/dashboard', async (req, res, next) => {
  try {
    const dashboard = await RiskEngine.getRiskDashboard();
    return res.status(200).json(dashboard);
  } catch (err) {
    next(err);
  }
});

// 3b. Summary, events and leaderboard.
//
// The console called /risk/summary, /risk/events and /risk/leaderboard; none of the
// three existed. Each 404 fell through to a client-side fixture, so the risk page
// showed a distribution of 14 low / 2 medium / 2 high and an average of 21.4 on any
// fleet, including an empty one. They are served here from the same engine that
// backs /dashboard.
router.get('/summary', async (req, res, next) => {
  try {
    const d = await RiskEngine.getRiskDashboard();
    const anomalies = await countRecentAnomalies();

    return res.status(200).json({
      distribution: {
        low: d.low_risk_nodes,
        medium: d.medium_risk_nodes,
        high: d.high_risk_nodes
      },
      average_risk_score: d.average_risk_score,
      total_nodes: d.total_nodes,
      quarantined_nodes: d.quarantined_nodes,
      active_anomalies_count: anomalies
    });
  } catch (err) {
    next(err);
  }
});

router.get('/events', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const events = await recentRiskEvents(limit);
    return res.status(200).json({ events });
  } catch (err) {
    next(err);
  }
});

// Highest scores first. A node at zero is not on a leaderboard of risk, so the
// list is filtered rather than padded to a fixed length.
router.get('/leaderboard', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const d = await RiskEngine.getRiskDashboard();

    const ranked = d.nodes
      .filter((n) => Number(n.risk_score) > 0)
      .sort((a, b) => Number(b.risk_score) - Number(a.risk_score))
      .slice(0, limit);

    return res.status(200).json({ leaderboard: ranked });
  } catch (err) {
    next(err);
  }
});

/**
 * Security events recorded in the last 24 hours that bear on node risk.
 *
 * Read from the audit ledger, which is where these are actually written; there is
 * no separate risk event table, and inventing one to hold a copy would give two
 * records of the same fact that could disagree.
 */
// Exactly the types the code emits. A type listed here that nothing writes makes
// the filter look thorough while matching nothing.
const RISK_EVENT_TYPES = [
  'NODE_QUARANTINED',
  'NODE_QUARANTINE',
  'NODE_LIFT_QUARANTINE',
  'IMPOSSIBLE_TRAVEL_DETECTED',
  'POSTURE_VIOLATION',
  'GEO_DRIFT_DETECTED',
  'NODE_ATTESTED',
  'RISK_ATTESTATION'
];

async function recentRiskEvents(limit) {
  const rows = await runRiskQuery(
    `SELECT id, event_type, actor_username, target_id, severity, message, created_at
       FROM audit_events
      WHERE event_type = ANY($1)
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC
      LIMIT $2`,
    [RISK_EVENT_TYPES, limit],
    `SELECT id, event_type, actor_username, target_id, severity, message, created_at
       FROM audit_events
      WHERE event_type IN (${RISK_EVENT_TYPES.map(() => '?').join(',')})
        AND created_at > datetime('now', '-24 hours')
      ORDER BY created_at DESC
      LIMIT ?`,
    [...RISK_EVENT_TYPES, limit]
  );

  return rows.map((r) => ({
    id: r.id,
    event_type: r.event_type,
    node_id: r.target_id,
    actor: r.actor_username,
    severity: (r.severity || 'info').toUpperCase(),
    details: r.message,
    created_at: r.created_at
  }));
}

async function countRecentAnomalies() {
  const rows = await recentRiskEvents(500);
  return rows.length;
}

async function runRiskQuery(pgSql, pgParams, sqliteSql, sqliteParams) {
  if (isPostgres()) {
    const result = await getPgPool().query(pgSql, pgParams);
    return result.rows;
  }
  return getDatabase()
    .prepare(sqliteSql)
    .all(...sqliteParams);
}

// 5. Get Risk Details for Specific Node
async function handleGetNodeRisk(req, res, next) {
  try {
    const node = await RiskEngine.getNodeById(req.params.id);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    const score = Number(node.risk_score) || 0;
    const color = score < 40 ? 'green' : score <= 75 ? 'yellow' : 'red';
    return res.status(200).json({
      node_id: node.id,
      name: node.name,
      risk_score: score,
      is_quarantined: Boolean(node.is_quarantined),
      quarantine_reason: node.quarantine_reason,
      status: node.is_quarantined ? 'quarantined' : node.is_healthy ? 'active' : 'degraded',
      color
    });
  } catch (err) {
    next(err);
  }
}

// Risk score, name and quarantine reason are tenant data: without this any
// authenticated user could read them for any node in the system.
router.get('/:id/risk', requireNodeOwnership, handleGetNodeRisk);
router.get('/:id', requireNodeOwnership, handleGetNodeRisk);

module.exports = router;
