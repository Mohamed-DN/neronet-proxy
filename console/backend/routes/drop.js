/**
 * NeroDrop phase 0 (ADR 0033): metadata and tickets for end-to-end encrypted transfers
 * between members of one organisation.
 *
 * The browser encrypts and decrypts; the ciphertext goes to the organisation's default
 * profile gateway through the console's reverse proxy (/drop-blob/<id>, nginx). This
 * router never receives file bytes, a key, a file name or a link: it ignores every field
 * it does not name, and the audit records only ids, sizes and outcomes.
 */
const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const { resolveUserOrg } = require('../middleware/rbac');
const { logAuditEvent } = require('../utils/audit');
const DropService = require('../services/DropService');

router.use(authenticateToken);
router.use(resolveUserOrg);

const orgOf = (req) => req.user.organization_id || 'org-default';
const refuse = (res, status, code) => res.status(status).json({ error: code, code });

function audit(req, eventType, transfer, extra = {}) {
  return logAuditEvent({
    eventType,
    organizationId: orgOf(req),
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: transfer ? transfer.id : null,
    targetType: transfer ? 'drop_transfer' : 'organization',
    message: transfer ? `NeroDrop ${eventType.slice(5).toLowerCase()} ${transfer.id}` : `NeroDrop ${eventType}`,
    ipAddress: req.ip,
    metadata: transfer
      ? {
          transfer_id: transfer.id,
          sender_user_id: transfer.sender_user_id,
          recipient_user_id: transfer.recipient_user_id,
          gateway_node_id: transfer.gateway_node_id,
          ciphertext_bytes: Number(transfer.ciphertext_bytes),
          one_time: transfer.one_time,
          expires_at: transfer.expires_at,
          ...extra
        }
      : extra
  });
}

router.get('/config', async (req, res, next) => {
  try {
    const org = orgOf(req);
    const [enabled, mailbox, maySend] = await Promise.all([
      DropService.enabled(org),
      DropService.mailbox(org),
      DropService.mayDrop(req.user, org)
    ]);
    res.json({
      enabled,
      available: Boolean(mailbox),
      may_send: maySend && Boolean(mailbox),
      can_manage: DropService.isAdmin(req.user),
      max_bytes: DropService.maxBytes(),
      lifetime_hours: DropService.LIFETIME_HOURS
    });
  } catch (err) {
    next(err);
  }
});

router.put('/policy', requireRole('super-admin', 'admin'), async (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return refuse(res, 400, 'enabled_must_be_boolean');
    await DropService.setEnabled(orgOf(req), enabled);
    await audit(req, 'DROP_POLICY_SET', null, { enabled });
    res.json({ enabled });
  } catch (err) {
    next(err);
  }
});

router.get('/recipients', async (req, res, next) => {
  try {
    if (!(await DropService.mayDrop(req.user, orgOf(req)))) return refuse(res, 403, 'drop_not_permitted');
    res.json({ recipients: await DropService.recipients(orgOf(req)) });
  } catch (err) {
    next(err);
  }
});

router.post('/transfers', async (req, res, next) => {
  try {
    const org = orgOf(req);
    // Only these three fields are read. A name, a type, a hash or a key sent along is
    // dropped here and never reaches the database or the audit.
    const { recipient_id: recipientId, ciphertext_bytes: bytes, one_time: oneTime } = req.body || {};
    if (typeof recipientId !== 'string' || !recipientId) return refuse(res, 400, 'recipient_required');
    if (!Number.isSafeInteger(bytes) || bytes < DropService.MIN_CIPHERTEXT_BYTES)
      return refuse(res, 400, 'invalid_size');
    if (oneTime !== undefined && typeof oneTime !== 'boolean') return refuse(res, 400, 'one_time_must_be_boolean');
    if (!(await DropService.enabled(org))) return refuse(res, 403, 'drop_disabled');
    if (!(await DropService.mayDrop(req.user, org))) return refuse(res, 403, 'drop_not_permitted');
    // Another organisation's member, a suspended account and an unknown id look the same.
    const recipient = await DropService.member(org, recipientId);
    if (!recipient) return refuse(res, 404, 'no_such_recipient');
    if (bytes > DropService.maxBytes()) return refuse(res, 413, 'drop_too_large');
    const gateway = await DropService.mailbox(org);
    if (!gateway) return refuse(res, 409, 'drop_unavailable');
    await DropService.sweep();
    if ((await DropService.openCount(req.user.id)) >= DropService.MAX_OPEN_PER_SENDER) {
      return refuse(res, 429, 'too_many_transfers');
    }
    const transfer = await DropService.create({
      organizationId: org,
      senderId: req.user.id,
      recipientId: recipient.id,
      gatewayId: gateway.id,
      ciphertextBytes: bytes,
      oneTime: oneTime === true
    });
    await audit(req, 'DROP_CREATED', transfer);
    res.status(201).json({
      id: transfer.id,
      short_code: DropService.shortCode(transfer.id),
      expires_at: transfer.expires_at,
      upload: DropService.uploadTicket(transfer, gateway)
    });
  } catch (err) {
    next(err);
  }
});

router.post('/transfers/:id/sent', async (req, res, next) => {
  try {
    const transfer = await DropService.find(orgOf(req), req.params.id, req.user.id, 'sender');
    if (!transfer) return refuse(res, 404, 'no_such_transfer');
    if (new Date(transfer.expires_at) <= new Date()) return refuse(res, 410, 'drop_expired');
    if (transfer.status === 'pending') {
      await DropService.markSent(transfer.id);
      await audit(req, 'DROP_SENT', transfer);
    }
    res.json({ id: transfer.id, status: transfer.status === 'pending' ? 'sent' : transfer.status });
  } catch (err) {
    next(err);
  }
});

router.get('/inbox', async (req, res, next) => {
  try {
    res.json({ transfers: await DropService.list(orgOf(req), req.user.id, 'recipient') });
  } catch (err) {
    next(err);
  }
});

router.get('/outbox', async (req, res, next) => {
  try {
    res.json({ transfers: await DropService.list(orgOf(req), req.user.id, 'sender') });
  } catch (err) {
    next(err);
  }
});

router.post('/transfers/:id/download-ticket', async (req, res, next) => {
  try {
    const org = orgOf(req);
    const transfer = await DropService.find(org, req.params.id, req.user.id, 'recipient');
    if (!transfer) return refuse(res, 404, 'no_such_transfer');
    if (!(await DropService.enabled(org))) return refuse(res, 403, 'drop_disabled');
    if (new Date(transfer.expires_at) <= new Date()) return refuse(res, 410, 'drop_expired');
    if (transfer.status === 'pending') return refuse(res, 409, 'drop_not_ready');
    if (transfer.one_time && transfer.status === 'received') return refuse(res, 410, 'drop_already_received');
    const gateway = await DropService.gatewayOf(transfer);
    if (!gateway) return refuse(res, 410, 'drop_expired');
    const ticket = DropService.downloadTicket(transfer, gateway);
    await audit(req, 'DROP_DOWNLOAD_TICKET', transfer);
    res.json({ ...ticket, ciphertext_bytes: Number(transfer.ciphertext_bytes) });
  } catch (err) {
    next(err);
  }
});

router.post('/transfers/:id/received', async (req, res, next) => {
  try {
    const transfer = await DropService.find(orgOf(req), req.params.id, req.user.id, 'recipient');
    if (!transfer) return refuse(res, 404, 'no_such_transfer');
    if (transfer.status === 'pending') return refuse(res, 409, 'drop_not_ready');
    if (transfer.status !== 'received') {
      await DropService.markReceived(transfer.id);
      await audit(req, 'DROP_RECEIVED', transfer);
    }
    res.json({ id: transfer.id, status: 'received' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
