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

    const circuit = await CircuitEngine.buildCircuit({
      requesterNodeId: String(req.body.node_id || '').trim() || null,
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
