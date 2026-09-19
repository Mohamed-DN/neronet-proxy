const express = require('express');
const router = express.Router();
const WebRtcSignalingEngine = require('../services/WebRtcSignalingEngine');
const { authenticateToken } = require('../middleware/auth');
const { gatewayAuthAddressLimiter, gatewayAuthDomainLimiter } = require('../middleware/rateLimit');

// 1. Custom Domain Public Auth Gateway (Public endpoint with OTP verification)
//
// Unauthenticated, and it verifies a static secret, so the limiters are the only
// thing between a caller and that secret. They run before the handler so that
// attempts which fail -- including the 404 for a domain that does not exist -- are
// counted: an enumeration is made entirely of requests that fail.
router.post(
  '/custom-domains/:domain/auth-gateway',
  gatewayAuthAddressLimiter,
  gatewayAuthDomainLimiter,
  async (req, res, next) => {
    try {
      const { domain } = req.params;
      const { otp_code } = req.body || {};
      const result = await WebRtcSignalingEngine.authenticateGateway(domain, otp_code);
      return res.status(200).json(result);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

// Authenticated Endpoints
router.use(authenticateToken);

// 2. List Cloud PC Instances
router.get('/', async (req, res, next) => {
  try {
    const cloud_pcs = await WebRtcSignalingEngine.listInstances(req.user);
    return res.status(200).json({ cloud_pcs, total: cloud_pcs.length });
  } catch (err) {
    next(err);
  }
});

// 3. Provision Cloud PC Instance
router.post('/', async (req, res, next) => {
  try {
    const { name, device_id } = req.body || {};
    if (!name || !device_id) {
      return res.status(400).json({ error: 'Missing required cloud PC fields (name, device_id)' });
    }

    const cloud_pc = await WebRtcSignalingEngine.provisionInstance({
      ...req.body,
      actor: req.user
    });
    return res.status(201).json({ cloud_pc });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// 4. Project Device (Generate WebRTC Signaling & ICE Credentials)
router.post('/:id/project', async (req, res, next) => {
  try {
    const result = await WebRtcSignalingEngine.projectDevice(req.params.id, req.user);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// 5. Teardown WebRTC Session
router.post('/:id/teardown', async (req, res, next) => {
  try {
    const result = await WebRtcSignalingEngine.teardownSession(req.params.id, req.user);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// 6. List Custom Domains
router.get('/custom-domains', async (req, res, next) => {
  try {
    const custom_domains = await WebRtcSignalingEngine.listCustomDomains(req.user);
    return res.status(200).json({ custom_domains, total: custom_domains.length });
  } catch (err) {
    next(err);
  }
});

// 7. Register Custom Domain
router.post('/custom-domains', async (req, res, next) => {
  try {
    const { domain, cloud_pc_id } = req.body || {};
    if (!domain || !cloud_pc_id) {
      return res.status(400).json({ error: 'Missing domain or cloud_pc_id' });
    }

    const custom_domain = await WebRtcSignalingEngine.registerCustomDomain({
      domain,
      cloud_pc_id,
      actor: req.user
    });
    return res.status(201).json({ custom_domain });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
