'use strict';

/**
 * Connection order by scope (ADR 0037). One router, one path per scope:
 *
 *   GET|PUT /api/connection-order/organization      owner or admin writes
 *   GET|PUT /api/connection-order/lines/:id         owner, admin or network_admin writes
 *   GET|PUT /api/connection-order/devices/:id       an administrator, or the device's owner when
 *                                                   members may choose and nothing is locked
 *   GET|PUT /api/connection-order/me                the caller, when members may choose
 *   POST    /api/connection-order/preview           who would lose connectivity; writes nothing
 *
 * A write that would leave a device with no method its gateway runs answers 409. Every write is
 * audited with before and after (methods and flags only).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { resolveUserOrg, requireOrgRole, requireNotAuditor } = require('../middleware/rbac');
const ConnectionOrderService = require('../services/ConnectionOrderService');
const { logAuditEvent } = require('../utils/audit');

const router = express.Router();
router.use(authenticateToken);
router.use(resolveUserOrg);
router.use(requireNotAuditor);

const orgOf = (req) => req.user.organization_id || 'org-default';
const roleOf = (req) => req.user.org_role || req.user.role;
const isAdmin = (req) => req.user.role === 'super-admin' || ['owner', 'admin'].includes(roleOf(req));
const actorOf = (req) => ({ id: req.user.id, isAdmin: isAdmin(req) });

function fail(res, err, next) {
  if (err instanceof ConnectionOrderService.ConnectionOrderError) {
    return res.status(err.status).json({ error: err.code, code: err.code, message: err.message, ...err.extra });
  }
  return next(err);
}

async function audit(req, { scope, targetId, targetType, result, message }) {
  await logAuditEvent({
    eventType: 'CONNECTION_ORDER_UPDATED',
    organizationId: orgOf(req),
    severity: 'warn',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId,
    targetType,
    message,
    ipAddress: req.ip,
    metadata: {
      scope,
      before: result.before,
      after: result.after,
      devices_to_reimport: result.plan.reimport_total
    }
  });
}

router.get('/organization', async (req, res, next) => {
  try {
    const view = await ConnectionOrderService.getOrganization(orgOf(req));
    if (!view) return res.status(404).json({ error: 'Organization not found' });
    res.set('Cache-Control', 'no-store');
    return res.json(view);
  } catch (err) {
    return next(err);
  }
});

router.put('/organization', requireOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    const result = await ConnectionOrderService.setOrganization(orgOf(req), req.body);
    if (!result) return res.status(404).json({ error: 'Organization not found' });
    await audit(req, {
      scope: 'organization',
      targetId: orgOf(req),
      targetType: 'organization',
      result,
      message: `Connection order of ${orgOf(req)} set to ${(result.after.order || ['automatic']).join(',')}${result.after.forced ? ' (first only)' : ''}`
    });
    return res.json({ ...result.view, plan: result.plan });
  } catch (err) {
    return fail(res, err, next);
  }
});

router.get('/lines/:id', async (req, res, next) => {
  try {
    const view = await ConnectionOrderService.getLine(orgOf(req), req.params.id);
    if (!view) return res.status(404).json({ error: 'no_such_line', code: 'no_such_line' });
    res.set('Cache-Control', 'no-store');
    return res.json(view);
  } catch (err) {
    return next(err);
  }
});

router.put('/lines/:id', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const result = await ConnectionOrderService.setLine(orgOf(req), req.params.id, req.body);
    if (!result) return res.status(404).json({ error: 'no_such_line', code: 'no_such_line' });
    await audit(req, {
      scope: 'line',
      targetId: req.params.id,
      targetType: 'compartment',
      result,
      message: `Connection order of line ${req.params.id} set to ${(result.after.order || ['inherit']).join(',')}${result.after.forced ? ' (first only)' : ''}`
    });
    return res.json({ ...result.view, plan: result.plan });
  } catch (err) {
    return fail(res, err, next);
  }
});

// A device is visible to administrators and to its owner; to anyone else it does not exist.
async function visibleDevice(req) {
  const found = await ConnectionOrderService.getDevice(orgOf(req), req.params.id);
  if (!found) return null;
  if (!isAdmin(req) && found.ownerId !== req.user.id) return null;
  return found;
}

router.get('/devices/:id', async (req, res, next) => {
  try {
    const found = await visibleDevice(req);
    if (!found) return res.status(404).json({ error: 'no_such_device', code: 'no_such_device' });
    const can = isAdmin(req)
      ? true
      : found.view.members_may_choose && !found.view.own.locked && !found.lineLocked;
    res.set('Cache-Control', 'no-store');
    return res.json({ ...found.view, can_edit: can, can_lock: isAdmin(req) });
  } catch (err) {
    return next(err);
  }
});

router.put('/devices/:id', async (req, res, next) => {
  try {
    if (!(await visibleDevice(req))) return res.status(404).json({ error: 'no_such_device', code: 'no_such_device' });
    const result = await ConnectionOrderService.setDevice(orgOf(req), req.params.id, req.body, actorOf(req));
    if (!result) return res.status(404).json({ error: 'no_such_device', code: 'no_such_device' });
    await audit(req, {
      scope: 'device',
      targetId: req.params.id,
      targetType: 'node',
      result,
      message: `Connection order of device ${req.params.id} set to ${(result.after.order || ['inherit']).join(',')}${result.after.forced ? ' (first only)' : ''}`
    });
    return res.json({ ...result.view, plan: result.plan });
  } catch (err) {
    return fail(res, err, next);
  }
});

router.get('/me', async (req, res, next) => {
  try {
    const view = await ConnectionOrderService.getPerson(orgOf(req), req.user.id);
    if (!view) return res.status(404).json({ error: 'Organization not found' });
    res.set('Cache-Control', 'no-store');
    return res.json(view);
  } catch (err) {
    return next(err);
  }
});

router.put('/me', async (req, res, next) => {
  try {
    const result = await ConnectionOrderService.setPerson(orgOf(req), req.user.id, req.body);
    if (!result) return res.status(404).json({ error: 'Organization not found' });
    await audit(req, {
      scope: 'person',
      targetId: req.user.id,
      targetType: 'user',
      result,
      message: `Connection order of ${req.user.id} set to ${(result.after.order || ['inherit']).join(',')}${result.after.forced ? ' (first only)' : ''}`
    });
    return res.json({ ...result.view, plan: result.plan });
  } catch (err) {
    return fail(res, err, next);
  }
});

// Body: { scope: 'organization' | 'line' | 'device', id?, settings: { order, forced, ... } }.
router.post('/preview', async (req, res, next) => {
  try {
    const { scope, id, settings } = req.body || {};
    if (!['organization', 'line', 'device'].includes(scope)) {
      return res.status(400).json({ error: 'invalid_scope', code: 'invalid_scope' });
    }
    const role = roleOf(req);
    if (scope === 'organization' && !(isAdmin(req))) {
      return res.status(403).json({ error: 'Forbidden: insufficient organizational role permissions' });
    }
    if (scope === 'line' && !(isAdmin(req) || role === 'network_admin')) {
      return res.status(403).json({ error: 'Forbidden: insufficient organizational role permissions' });
    }
    if (scope === 'device' && !isAdmin(req)) {
      req.params = { id };
      if (!(await visibleDevice(req))) return res.status(404).json({ error: 'no_such_device', code: 'no_such_device' });
    }
    const result = await ConnectionOrderService.preview(orgOf(req), scope, id, settings, actorOf(req));
    if (!result) return res.status(404).json({ error: 'not_found', code: 'not_found' });
    res.set('Cache-Control', 'no-store');
    return res.json(result);
  } catch (err) {
    return fail(res, err, next);
  }
});

module.exports = router;
