const express = require('express');
const router = express.Router();
const AclEngine = require('../services/AclEngine');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { logAuditEvent } = require('../utils/audit');

const requireSuperAdmin = requireRole('super-admin');

router.use(authenticateToken);

/**
 * ACL rule administration.
 *
 * The engine, the acl_rules table and the per-node compilation have all existed and
 * been delivered to the fleet on every heartbeat. Nothing exposed them over HTTP,
 * so the console's ACL page held its rules in a JavaScript array in the browser:
 * a rule written there was gone on reload and never reached a node. This connects
 * the page to the engine that enforces it.
 *
 * Policy is fleet-wide, so writes are restricted to super-admins. A tenant able to
 * add a rule could open a path between devices that are not theirs.
 */

router.get('/rules', async (req, res, next) => {
  try {
    const rules = await AclEngine.listRules();
    const epoch = await AclEngine.getEpoch('acl');

    return res.status(200).json({
      rules,
      epoch,
      // pkg/acl is default-deny, and the control plane compiles allow-all while the
      // table is empty. An operator reading this page needs to know which of the
      // two states the mesh is in.
      policy_is_open: rules.length === 0,
      count: rules.length
    });
  } catch (err) {
    next(err);
  }
});

router.post('/rules', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = await AclEngine.createRule(req.body || {});
    const rules = await AclEngine.listRules();
    const created = rules.find(r => r.id === id) || { id };

    await logAuditEvent({
      eventType: 'ACL_RULE_CREATED',
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: id,
      targetType: 'acl_rule',
      message: `ACL rule ${id} created: ${created.source_cidr} -> ${created.destination_cidr} ${created.action}`,
      ipAddress: req.ip
    });

    // The epoch is what makes nodes re-sync; returning it lets the caller confirm
    // the change is on its way out rather than assuming it.
    return res.status(201).json({
      rule: created,
      epoch: await AclEngine.getEpoch('acl')
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/rules/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const rules = await AclEngine.listRules();
    const existing = rules.find(r => r.id === req.params.id);

    if (!existing) {
      return res.status(404).json({ error: `no ACL rule ${req.params.id}` });
    }

    await AclEngine.deleteRule(req.params.id);

    await logAuditEvent({
      eventType: 'ACL_RULE_DELETED',
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: req.params.id,
      targetType: 'acl_rule',
      message: `ACL rule ${req.params.id} deleted`,
      ipAddress: req.ip
    });

    const remaining = await AclEngine.listRules();
    return res.status(200).json({
      deleted: req.params.id,
      epoch: await AclEngine.getEpoch('acl'),
      // Deleting the last rule reopens the mesh. That is a consequential change and
      // the caller is told, rather than discovering it from the topology view.
      policy_is_open: remaining.length === 0
    });
  } catch (err) {
    next(err);
  }
});

/** The policy a given node will enforce, for verifying a rule landed. */
router.get('/compiled/:nodeId', requireSuperAdmin, async (req, res, next) => {
  try {
    const policy = await AclEngine.compilePolicyFor(req.params.nodeId);
    if (!policy) {
      return res.status(404).json({ error: `no node ${req.params.nodeId}` });
    }
    return res.status(200).json(policy);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
