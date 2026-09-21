/**
 * Pre-Auth Keys Management API.
 *
 * Implements ADR 0017 (Node Identity v2) & ADR 0019 (Organizations & RBAC):
 * - POST /api/preauth-keys: Mint a new pre-auth key with enrolment string
 * - GET /api/preauth-keys: List pre-auth keys
 * - DELETE /api/preauth-keys/:id: Revoke a pre-auth key
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { resolveUserOrg, requireNotAuditor } = require('../middleware/rbac');
const { createPreAuthKey, listPreAuthKeys, revokePreAuthKey } = require('../services/PreAuthKeyService');
const { getControlPlaneFingerprint } = require('../services/ControlPlaneKeyService');
const { logAuditEvent } = require('../utils/audit');
const logger = require('../utils/logger');

const router = express.Router();

router.use(authenticateToken);
router.use(resolveUserOrg);
router.use(requireNotAuditor);

// 1. Create Pre-Auth Key
router.post('/', async (req, res) => {
  try {
    const { allowed_role, is_reusable, max_uses, expires_in_hours } = req.body || {};

    const key = await createPreAuthKey({
      ownerId: req.user.id,
      organizationId: req.user.organization_id || 'org-default',
      allowedRole: allowed_role || null,
      isReusable: Boolean(is_reusable),
      maxUses: max_uses ? Number(max_uses) : null,
      expiresInHours: expires_in_hours ? Number(expires_in_hours) : 24
    });

    const cpFingerprint = getControlPlaneFingerprint();
    const enrolmentString = `nnk1:${key.secret}:${cpFingerprint}`;

    await logAuditEvent({
      eventType: 'preauth_key.created',
      severity: 'info',
      userId: req.user.id,
      targetId: key.id,
      targetType: 'preauth_key',
      message: `Created pre-auth key ${key.key_prefix} (org: ${key.organization_id})`,
      ipAddress: req.ip
    });

    return res.status(201).json({
      ...key,
      control_plane_fingerprint: cpFingerprint,
      enrolment_string: enrolmentString
    });
  } catch (err) {
    logger.error(`Failed to create pre-auth key: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 2. List Pre-Auth Keys
router.get('/', async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === 'super-admin';
    const keys = await listPreAuthKeys(req.user.id, isSuperAdmin, req.user.organization_id);
    return res.json({ keys });
  } catch (err) {
    logger.error(`Failed to list pre-auth keys: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// 3. Revoke Pre-Auth Key
router.delete('/:id', async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === 'super-admin';
    const success = await revokePreAuthKey(req.params.id, req.user.id, isSuperAdmin, req.user.organization_id);

    if (!success) {
      return res.status(404).json({ error: 'pre-auth key not found or already revoked' });
    }

    await logAuditEvent({
      eventType: 'preauth_key.revoked',
      severity: 'warn',
      userId: req.user.id,
      targetId: req.params.id,
      targetType: 'preauth_key',
      message: `Revoked pre-auth key ${req.params.id}`,
      ipAddress: req.ip
    });

    return res.json({ success: true, id: req.params.id });
  } catch (err) {
    logger.error(`Failed to revoke pre-auth key: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
