const express = require('express');
const { requireNodeOwnership } = require('../middleware/ownership');
const router = express.Router();
const RiskEngine = require('../services/RiskEngine');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// 1. Ingest Node Telemetry (via /api/risk/telemetry or /api/nodes/:id/telemetry)
router.post('/telemetry', async (req, res, next) => {
  try {
    const { node_id } = req.body;
    if (!node_id) {
      return res.status(400).json({ error: 'Missing node_id in telemetry payload' });
    }
    const result = await RiskEngine.ingestTelemetry(node_id, req.body);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// Also support POST /:id/telemetry when mounted on /api/nodes or /api/risk
router.post('/:id/telemetry', async (req, res, next) => {
  try {
    const nodeId = req.params.id;
    const result = await RiskEngine.ingestTelemetry(nodeId, req.body);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

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

// 4. Remediate / Attest Node Risk Score
router.post('/attest/:id', async (req, res, next) => {
  try {
    const nodeId = req.params.id;
    const node = await RiskEngine.getNodeById(nodeId);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    if (req.user.role !== 'super-admin' && node.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access forbidden: unauthorized risk attestation' });
    }

    const result = await RiskEngine.attestNode(nodeId, req.user);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// 5. Get Risk Details for Specific Node
async function handleGetNodeRisk(req, res, next) {
  try {
    const node = await RiskEngine.getNodeById(req.params.id);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    const score = Number(node.risk_score) || 0;
    const color = score < 40 ? 'green' : (score <= 75 ? 'yellow' : 'red');
    return res.status(200).json({
      node_id: node.id,
      name: node.name,
      risk_score: score,
      is_quarantined: Boolean(node.is_quarantined),
      quarantine_reason: node.quarantine_reason,
      status: node.is_quarantined ? 'quarantined' : (node.is_healthy ? 'active' : 'degraded'),
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
