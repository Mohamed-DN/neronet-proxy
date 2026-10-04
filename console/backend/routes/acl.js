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

// Rules are scoped to an organisation, or to the platform when organization_id is null.
// The platform super-admin sees and manages all of them; anyone else sees the rules
// that apply to their organisation and manages only its own.
const isSuperAdmin = (req) => req.user.role === 'super-admin';
const orgOf = (req) => req.user.organization_id || 'org-default';

function rulesVisibleTo(req) {
  return isSuperAdmin(req) ? AclEngine.listRules() : AclEngine.listRules(orgOf(req));
}

// Open means every peer is permitted: no rule applies and the default policy is open.
async function policyIsOpen(req, rules) {
  if (rules.length > 0) return false;
  if (!isPostgres()) return true;
  const orgRes = await getPgPool().query('SELECT default_policy FROM organizations WHERE id = $1', [orgOf(req)]);
  return orgRes.rows.length > 0 && orgRes.rows[0].default_policy === 'open';
}

const accessTierOf = (req) => req.user.compartment_access || req.user.access_tier || 'standard';

// Organisation roles that read every node of the organisation. A member reads their own.
const READ_ALL_ROLES = new Set(['owner', 'admin', 'network_admin', 'auditor']);

/**
 * The node the caller may read the policy of, or null: unknown, in another
 * organisation, in a hidden compartment below the root tier, or somebody else's when
 * the caller is a plain member. All four read as "no such node", as they do on
 * /api/nodes, so the answer does not say which one it was.
 */
async function readableNode(req, nodeId, { adminView = false } = {}) {
  const res = await getPgPool().query(
    `SELECT n.id, n.user_id, COALESCE(n.organization_id, 'org-default') AS organization_id,
            COALESCE(c.is_hidden, FALSE) AS is_hidden
       FROM nodes n LEFT JOIN compartments c ON c.id = n.compartment_id
      WHERE n.id = $1`,
    [nodeId]
  );
  const node = res.rows[0];
  if (!node) return null;
  if (node.is_hidden && accessTierOf(req) !== 'root') return null;
  if (isSuperAdmin(req)) return node;
  if (node.organization_id !== orgOf(req)) return null;
  // adminView: the caller already passed the ACL administration check.
  if (adminView || READ_ALL_ROLES.has(req.user.org_role)) return node;
  return node.user_id === req.user.id ? node : null;
}

/**
 * A compiled policy names its peers by address. Below the root tier a hidden node is
 * not a peer anyone can see, so its entries are left out: a visible node peered with a
 * hidden compartment would otherwise give the hidden node's address away.
 */
async function withoutHiddenPeers(req, policy) {
  if (!policy || accessTierOf(req) === 'root') return policy;
  const res = await getPgPool().query(
    `SELECT n.overlay_ipv4 FROM nodes n JOIN compartments c ON c.id = n.compartment_id
      WHERE c.is_hidden = TRUE AND COALESCE(n.organization_id, 'org-default') = $1`,
    [policy.organization_id || (await AclEngine.nodeOrganization(policy.node_id))]
  );
  const hidden = new Set(res.rows.map((r) => String(r.overlay_ipv4)));
  if (hidden.size === 0) return policy;
  const keep = (entry) => !hidden.has(String(entry.allowed_peer_vip));
  return {
    ...policy,
    inbound_rules: policy.inbound_rules.filter(keep),
    outbound_rules: policy.outbound_rules.filter(keep)
  };
}

async function findManageableRule(req, id) {
  const rules = await AclEngine.listRules();
  const rule = rules.find((r) => r.id === id);
  if (!rule) return null;
  if (isSuperAdmin(req)) return rule;
  return rule.organization_id === orgOf(req) ? rule : null;
}

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
    const rules = await rulesVisibleTo(req);
    const epoch = await AclEngine.getEpoch('acl');

    return res.status(200).json({
      rules,
      epoch,
      policy_is_open: await policyIsOpen(req, rules),
      count: rules.length
    });
  } catch (err) {
    next(err);
  }
});

// 2. Create ACL rule
router.post('/rules', requireAclAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const organizationId = isSuperAdmin(req) ? body.organization_id || null : orgOf(req);
    const id = await AclEngine.createRule(body, { organizationId });
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
    if (!(await findManageableRule(req, req.params.id))) {
      return res.status(404).json({ error: `no ACL rule ${req.params.id}` });
    }
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
    const existing = await findManageableRule(req, req.params.id);

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

    const remaining = await rulesVisibleTo(req);
    return res.status(200).json({
      deleted: req.params.id,
      epoch: await AclEngine.getEpoch('acl'),
      policy_is_open: await policyIsOpen(req, remaining)
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
      defaultPolicy,
      organizationId: orgId,
      accessTier: accessTierOf(req)
    });

    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 8. The policy a given node will enforce
router.get('/compiled/:nodeId', async (req, res, next) => {
  try {
    const notFound = () => res.status(404).json({ error: `no node ${req.params.nodeId}` });
    if (!(await readableNode(req, req.params.nodeId))) return notFound();

    const policy = await AclEngine.compilePolicyFor(req.params.nodeId);
    if (!policy) return notFound();
    return res.status(200).json(await withoutHiddenPeers(req, policy));
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

    if (!(await readableNode(req, node_id, { adminView: true }))) {
      return res.status(404).json({ error: `no node ${node_id}` });
    }
    const preview = await AclEngine.compilePreview(node_id, candidate_rule);
    if (!preview) {
      return res.status(404).json({ error: `no node ${node_id}` });
    }

    return res.status(200).json(await withoutHiddenPeers(req, preview));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
