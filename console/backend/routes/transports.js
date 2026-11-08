const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { resolveUserOrg, requireNotAuditor, requireSuperAdmin } = require('../middleware/rbac');
const TransportPolicyService = require('../services/TransportPolicyService');
const { logAuditEvent } = require('../utils/audit');

/**
 * The relays the installation runs (T0 P1). They are installation-wide: every
 * organisation that allows DERP is offered all enabled relays, so only the platform
 * super-admin manages them. A relay's credential is returned once, at creation or
 * rotation; only its hash is stored.
 */

router.use(authenticateToken);
router.use(resolveUserOrg);
router.use(requireNotAuditor);
router.use(requireSuperAdmin);
// Responses may carry a relay credential; none of them may be cached.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function fail(res, err, next) {
  if (err instanceof TransportPolicyService.RelayError) {
    return res.status(err.status).json({ error: err.message });
  }
  return next(err);
}

// Relays are installation-wide: platform events, not any organisation's. Awaited, so
// a change is answered only once it is in the ledger.
function audit(req, eventType, relayId, message, metadata = {}) {
  return logAuditEvent({
    eventType,
    organizationId: null,
    severity: 'warn',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: relayId,
    targetType: 'transport_relay',
    message,
    ipAddress: req.ip,
    metadata
  });
}

router.get('/relays', async (req, res, next) => {
  try {
    return res.json({ relays: await TransportPolicyService.listRelays() });
  } catch (err) {
    return next(err);
  }
});

router.post('/relays', async (req, res, next) => {
  try {
    const body = req.body || {};
    const { relay, credential } = await TransportPolicyService.createRelay(
      { relay_id: body.relay_id, url: body.url },
      req.user.id
    );
    await audit(
      req,
      'TRANSPORT_RELAY_CREATED',
      relay.relay_id,
      `DERP relay ${relay.relay_id} created at ${relay.url}`,
      {
        url: relay.url
      }
    );
    return res.status(201).json({ relay, credential });
  } catch (err) {
    return fail(res, err, next);
  }
});

router.patch('/relays/:relayId', async (req, res, next) => {
  try {
    const body = req.body || {};
    const relay = await TransportPolicyService.updateRelay(req.params.relayId, {
      url: body.url,
      enabled: body.enabled
    });
    await audit(
      req,
      'TRANSPORT_RELAY_UPDATED',
      relay.relay_id,
      `DERP relay ${relay.relay_id} updated: enabled=${relay.enabled} url=${relay.url}`,
      { url: relay.url, enabled: relay.enabled }
    );
    return res.json({ relay });
  } catch (err) {
    return fail(res, err, next);
  }
});

router.post('/relays/:relayId/rotate-credential', async (req, res, next) => {
  try {
    const { relay, credential } = await TransportPolicyService.rotateRelayCredential(req.params.relayId);
    await audit(
      req,
      'TRANSPORT_RELAY_CREDENTIAL_ROTATED',
      relay.relay_id,
      `DERP relay ${relay.relay_id} credential rotated`
    );
    return res.json({ relay, credential });
  } catch (err) {
    return fail(res, err, next);
  }
});

module.exports = router;
