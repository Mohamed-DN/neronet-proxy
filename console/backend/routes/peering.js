const express = require('express');
const router = express.Router();
const PeeringEngine = require('../services/PeeringEngine');
const { authenticateToken, requireRole } = require('../middleware/auth');

const requireSuperAdmin = requireRole('super-admin');

router.use(authenticateToken);

// 1. Create / Initiate Peering Request (Super-Admin only)
router.post('/request', requireSuperAdmin, async (req, res, next) => {
  try {
    const { initiator_endpoint } = req.body || {};
    if (!initiator_endpoint) {
      return res.status(400).json({ error: 'Missing initiator_endpoint' });
    }

    const agreement = await PeeringEngine.createPeeringRequest({
      ...req.body,
      actor: req.user
    });
    return res.status(201).json({ peering_agreement: agreement });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// 2. Accept Incoming Peering Agreement (Super-Admin only)
router.post('/accept', requireSuperAdmin, async (req, res, next) => {
  try {
    const { peering_token, expected_fingerprint } = req.body || {};
    if (!peering_token) {
      return res.status(400).json({ error: 'Missing peering_token payload' });
    }

    const agreement = await PeeringEngine.acceptPeeringAgreement(
      peering_token,
      req.user,
      expected_fingerprint
    );
    return res.status(200).json({ success: true, peering_agreement: agreement });
  } catch (err) {
    if (err.status) {
      // 428 carries the fingerprint the operator has to confirm out of band.
      const body = { error: err.message };
      if (err.fingerprint) body.fingerprint = err.fingerprint;
      return res.status(err.status).json(body);
    }
    next(err);
  }
});

// 3. List All Peering Agreements
router.get('/', requireSuperAdmin, async (req, res, next) => {
  try {
    const agreements = await PeeringEngine.listPeeringAgreements();
    return res.status(200).json({ peering_agreements: agreements, total: agreements.length });
  } catch (err) {
    next(err);
  }
});

router.get('/agreements', requireSuperAdmin, async (req, res, next) => {
  try {
    const agreements = await PeeringEngine.listPeeringAgreements();
    return res.status(200).json({ peering_agreements: agreements, total: agreements.length });
  } catch (err) {
    next(err);
  }
});

// 4. List Peered Nodes Tagged for 3D Topology
router.get('/nodes', async (req, res, next) => {
  try {
    const peered_nodes = await PeeringEngine.getPeeredNodes();
    return res.status(200).json({ peered_nodes, total: peered_nodes.length });
  } catch (err) {
    next(err);
  }
});

// 5. Get Peering Agreement By ID
async function handleGetPeeringAgreement(req, res, next) {
  try {
    const agreement = await PeeringEngine.getPeeringAgreementById(req.params.id);
    if (!agreement) {
      return res.status(404).json({ error: 'Peering agreement not found' });
    }
    return res.status(200).json({ peering_agreement: agreement });
  } catch (err) {
    next(err);
  }
}

router.get('/:id', requireSuperAdmin, handleGetPeeringAgreement);
router.get('/agreements/:id', requireSuperAdmin, handleGetPeeringAgreement);

// 6. Revoke Peering Agreement (Super-Admin only)
router.delete('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const result = await PeeringEngine.revokePeeringAgreement(req.params.id, req.user);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

router.delete('/agreements/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const result = await PeeringEngine.revokePeeringAgreement(req.params.id, req.user);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
