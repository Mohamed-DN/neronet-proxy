const express = require('express');
const router = express.Router();
const CircuitEngine = require('./CircuitEngine');
const { validateRequest } = require('../../middleware/contractValidator');
const { checkNodeAuth } = require('../../middleware/nodeAuth');
const logger = require('../../utils/logger');

router.post('/circuit', validateRequest('CircuitRequest'), async (req, res) => {
  try {
    const auth = await checkNodeAuth(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const requesterId = String(req.body.node_id || '').trim() || (auth.node ? auth.node.id : null);
    let orgId = auth.node?.organization_id;
    if (!orgId && requesterId) {
      const { getPgPool } = require('../../db/index');
      const pool = getPgPool();
      const nodeRes = await pool.query('SELECT organization_id FROM nodes WHERE id = $1', [requesterId]);
      if (nodeRes.rows.length > 0) {
        orgId = nodeRes.rows[0].organization_id;
      }
    }
    orgId = orgId || 'org-default';

    const ModuleLoader = require('../../services/ModuleLoader');
    const isEnabled = await ModuleLoader.isModuleEnabledForOrg(orgId, 'onion');
    if (!isEnabled) {
      return res.status(403).json({ error: 'onion routing is disabled for this organization' });
    }

    const circuit = await CircuitEngine.buildCircuit({
      requesterNodeId: requesterId,
      targetCountry: req.body.target_country,
      hopCount: req.body.hop_count
    });

    return res.json(circuit);
  } catch (err) {
    if (err instanceof CircuitEngine.CircuitError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error(`[ONION] Circuit build failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
