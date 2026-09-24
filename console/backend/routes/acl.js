const express = require('express');
const router = express.Router();
const AclEngine = require('../services/AclEngine');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { resolveUserOrg } = require('../middleware/rbac');
const { logAuditEvent } = require('../utils/audit');
const { isPostgres, getPgPool } = require('../db/index');

const requireAclAdmin = requireRole('super-admin', 'admin');

router.use(authenticateToken);
router.use(resolveUserOrg);

/**
 * ACL rule administration and visual zero-trust policy engine.
 *
 * Exposes full CRUD for readable CIDR-based access control rules,
 * node policy compilation, live packet simulation, and organization
 * default policy (open vs zero-trust default-deny) management.
 */

// 1. List ACL rules & mesh status
router.get('/rules', async (req, res, next) => {
  try {
    const rules = await AclEngine.listRules();
    const epoch = await AclEngine.getEpoch('acl');

    return res.status(200).json({
      rules,
      epoch,
      policy_is_open: rules.length === 0,
      count: rules.length
    });
  } catch (err) {
    next(err);
  }
});

// 2. Create ACL rule
router.post('/rules', requireAclAdmin, async (req, res, next) => {
  try {
    const id = await AclEngine.createRule(req.body || {});
    const rules = await AclEngine.listRules();
    const created = rules.find((r) => r.id === id) || { id };

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

    return res.status(201).json({
      rule: created,
      epoch: await AclEngine.getEpoch('acl')
    });
  } catch (err) {
    next(err);
  }
});

// 3. Update ACL rule
router.put('/rules/:id', requireAclAdmin, async (req, res, next) => {
  try {
    const updated = await AclEngine.updateRule(req.params.id, req.body || {});
    if (!updated) {
      return res.status(404).json({ error: `no ACL rule ${req.params.id}` });
    }

    await logAuditEvent({
      eventType: 'ACL_RULE_UPDATED',
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: req.params.id,
      targetType: 'acl_rule',
      message: `ACL rule ${req.params.id} updated: ${updated.source_cidr} -> ${updated.destination_cidr} ${updated.action}`,
      ipAddress: req.ip
    });

    return res.status(200).json({
      rule: updated,
      epoch: await AclEngine.getEpoch('acl')
    });
  } catch (err) {
    next(err);
  }
});

// 4. Delete ACL rule
router.delete('/rules/:id', requireAclAdmin, async (req, res, next) => {
  try {
    const rules = await AclEngine.listRules();
    const existing = rules.find((r) => r.id === req.params.id);

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
      policy_is_open: remaining.length === 0
    });
  } catch (err) {
    next(err);
  }
});

// 5. Get organization default policy
router.get('/default-policy', async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    let defaultPolicy = 'deny';
    let orgName = 'Default Organization';

    if (isPostgres()) {
      const pool = getPgPool();
      const orgRes = await pool.query('SELECT id, name, default_policy FROM organizations WHERE id = $1', [orgId]);
      if (orgRes.rows.length > 0) {
        defaultPolicy = orgRes.rows[0].default_policy || 'deny';
        orgName = orgRes.rows[0].name;
      }
    }

    return res.status(200).json({
      organization_id: orgId,
      organization_name: orgName,
      default_policy: defaultPolicy
    });
  } catch (err) {
    next(err);
  }
});

// 6. Update organization default policy
router.put('/default-policy', requireAclAdmin, async (req, res, next) => {
  try {
    const { default_policy } = req.body || {};
    if (!default_policy || !['open', 'deny'].includes(default_policy)) {
      return res.status(400).json({ error: 'default_policy must be either "open" or "deny"' });
    }

    const orgId = req.user.organization_id || 'org-default';

    if (isPostgres()) {
      const pool = getPgPool();
      await pool.query('UPDATE organizations SET default_policy = $1, updated_at = NOW() WHERE id = $2', [
        default_policy,
        orgId
      ]);
    }

    await AclEngine.bumpEpoch('acl');

    await logAuditEvent({
      eventType: 'ACL_DEFAULT_POLICY_CHANGED',
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: orgId,
      targetType: 'organization',
      message: `Organization ${orgId} default policy changed to ${default_policy}`,
      ipAddress: req.ip
    });

    return res.status(200).json({
      organization_id: orgId,
      default_policy,
      epoch: await AclEngine.getEpoch('acl')
    });
  } catch (err) {
    next(err);
  }
});

// 7. Live packet policy simulation
router.post('/simulate', async (req, res, next) => {
  try {
    const { source_ip, destination_ip, protocol, port } = req.body || {};
    if (!source_ip || !destination_ip) {
      return res.status(400).json({ error: 'source_ip and destination_ip are required' });
    }

    const orgId = req.user.organization_id || 'org-default';
    let defaultPolicy = 'deny';
    if (isPostgres()) {
      const pool = getPgPool();
      const orgRes = await pool.query('SELECT default_policy FROM organizations WHERE id = $1', [orgId]);
      if (orgRes.rows.length > 0) {
        defaultPolicy = orgRes.rows[0].default_policy || 'deny';
      }
    }

    const result = await AclEngine.simulatePacket({
      source_ip,
      destination_ip,
      protocol: protocol || 'ALL',
      port: port !== undefined ? Number(port) : 0,
      defaultPolicy
    });

    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 8. The policy a given node will enforce
router.get('/compiled/:nodeId', async (req, res, next) => {
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

// 9. Preview compiled policy with a draft/candidate rule
router.post('/preview', requireAclAdmin, async (req, res, next) => {
  try {
    const { node_id, candidate_rule } = req.body || {};
    if (!node_id) {
      return res.status(400).json({ error: 'node_id is required' });
    }

    const preview = await AclEngine.compilePreview(node_id, candidate_rule);
    if (!preview) {
      return res.status(404).json({ error: `no node ${node_id}` });
    }

    return res.status(200).json(preview);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
