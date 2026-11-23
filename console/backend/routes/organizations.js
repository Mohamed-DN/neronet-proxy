const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { resolveUserOrg, requireRole, requireOrgRole, requireNotAuditor } = require('../middleware/rbac');
const OrgService = require('../services/OrgService');
const TransportPolicyService = require('../services/TransportPolicyService');
const AccessMethodService = require('../services/AccessMethodService');
const ConnectionOrderService = require('../services/ConnectionOrderService');
const { logAuditEvent } = require('../utils/audit');

router.use(authenticateToken);
router.use(resolveUserOrg);
router.use(requireNotAuditor);

// 1. List Organizations
router.get('/', async (req, res, next) => {
  try {
    const orgs = await OrgService.listOrganizations(req.user.id, req.user.role);
    return res.status(200).json({ organizations: orgs });
  } catch (err) {
    next(err);
  }
});

// 2. Create Organization (super-admin only)
router.post('/', requireRole('super-admin'), async (req, res, next) => {
  try {
    const { name, slug, default_policy, max_netmap_staleness_seconds } = req.body || {};
    if (!name) {
      return res.status(400).json({ error: 'Organization name is required' });
    }

    const org = await OrgService.createOrganization(
      { name, slug, default_policy, max_netmap_staleness_seconds },
      req.user
    );

    return res.status(201).json({ organization: org });
  } catch (err) {
    next(err);
  }
});

// 3. Get Organization Detail
router.get('/:id', async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const org = await OrgService.getOrganization(req.params.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    return res.status(200).json({ organization: org });
  } catch (err) {
    next(err);
  }
});

// 4. Update Organization (super-admin or org owner/admin)
router.put('/:id', requireOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const updated = await OrgService.updateOrganization(req.params.id, req.body || {}, req.user);
    if (!updated) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    return res.status(200).json({ organization: updated });
  } catch (err) {
    next(err);
  }
});

// Transport policy of an organisation (T0 P1). Bounded by the installation ceiling,
// which only the operator sets; the response reports both and their intersection.
router.get('/:id/transports', async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const policy = await TransportPolicyService.getOrganisationPolicy(req.params.id);
    if (!policy) return res.status(404).json({ error: 'Organization not found' });
    return res.status(200).json(policy);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/transports', requireOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const policy = await TransportPolicyService.setOrganisationPolicy(
      req.params.id,
      (req.body || {}).allowed_transports
    );
    // The organisation the service changed, not the one the request named.
    await logAuditEvent({
      eventType: 'TRANSPORT_ORG_POLICY_UPDATED',
      organizationId: policy.organization_id,
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: policy.organization_id,
      targetType: 'organization',
      message: `Transport policy of ${policy.organization_id} set to ${policy.allowed_transports.join(',') || '(none)'}; effective ${policy.effective_transports.join(',') || '(none)'}`,
      ipAddress: req.ip,
      metadata: policy
    });
    return res.status(200).json(policy);
  } catch (err) {
    if (err instanceof TransportPolicyService.RelayError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// Access methods of the organisation's profile devices (ADR 0036). The answer carries the
// switches only; the AmneziaWG parameters never leave the server through this route.
router.get('/:id/access-methods', async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const settings = await AccessMethodService.getSettings(req.params.id);
    if (!settings) return res.status(404).json({ error: 'Organization not found' });
    return res.status(200).json(settings);
  } catch (err) {
    next(err);
  }
});

function accessMethodFail(res, err, next) {
  if (err instanceof AccessMethodService.AccessMethodError) {
    return res.status(err.status).json({ error: err.code, code: err.code, message: err.message });
  }
  return next(err);
}

// The audit entries name the switches and counts, never a parameter.
router.put('/:id/access-methods', requireOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    // ADR 0037: switching a method off must not leave a device with no way to connect, and the
    // devices whose profile was made for it must be named and confirmed first.
    const plan = await ConnectionOrderService.planAllowedChange(req.params.id, req.body);
    if (plan && plan.strands_total > 0) {
      return res.status(409).json({
        error: 'would_strand_devices',
        code: 'would_strand_devices',
        message: 'Some devices would have no way to connect',
        devices: plan.strands,
        total: plan.strands_total
      });
    }
    if (plan && plan.reimport_total > 0 && req.body.confirm_reimport !== true) {
      return res.status(409).json({
        error: 'reimport_confirmation_required',
        code: 'reimport_confirmation_required',
        message: 'Some devices must download their profile again',
        reimport: plan.reimport,
        total: plan.reimport_total
      });
    }
    const result = await AccessMethodService.setSettings(req.params.id, req.body);
    if (!result) return res.status(404).json({ error: 'Organization not found' });
    await logAuditEvent({
      eventType: 'ACCESS_METHODS_UPDATED',
      organizationId: result.organization_id,
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: result.organization_id,
      targetType: 'organization',
      message: `Access methods of ${result.organization_id} set to ${result.allowed_access_methods.join(',')}${result.generated ? '; AmneziaWG parameters generated' : ''}${result.vless_generated ? '; REALITY parameters generated' : ''}`,
      ipAddress: req.ip,
      metadata: {
        allowed_access_methods: result.allowed_access_methods,
        parameters_generated: result.generated,
        reality_generated: result.vless_generated,
        devices_to_reimport: plan ? plan.reimport_total : 0
      }
    });
    const { generated: _generated, vless_generated: _vlessGenerated, ...view } = result;
    return res.status(200).json({ ...view, plan });
  } catch (err) {
    return accessMethodFail(res, err, next);
  }
});

// Who switching the two optional methods would affect; writes nothing.
router.post('/:id/access-methods/preview', requireOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const plan = await ConnectionOrderService.planAllowedChange(req.params.id, req.body);
    if (!plan) return res.status(400).json({ error: 'invalid_access_methods', code: 'invalid_access_methods' });
    res.set('Cache-Control', 'no-store');
    return res.status(200).json(plan);
  } catch (err) {
    return accessMethodFail(res, err, next);
  }
});

router.post('/:id/access-methods/regenerate', requireOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    const method = req.body && req.body.method !== undefined ? req.body.method : 'amneziawg';
    const result = await AccessMethodService.regenerateParams(req.params.id, method);
    if (!result) return res.status(404).json({ error: 'Organization not found' });
    await logAuditEvent({
      eventType: method === 'vless-reality' ? 'ACCESS_METHODS_VLESS_REGENERATED' : 'ACCESS_METHODS_AWG_REGENERATED',
      organizationId: result.organization_id,
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: result.organization_id,
      targetType: 'organization',
      message: `${method === 'vless-reality' ? 'REALITY' : 'AmneziaWG'} parameters of ${result.organization_id} regenerated; ${result.devices_to_redo} device(s) must import their profile again`,
      ipAddress: req.ip,
      metadata: { devices_to_redo: result.devices_to_redo }
    });
    return res.status(200).json(result);
  } catch (err) {
    return accessMethodFail(res, err, next);
  }
});

// 5. Delete Organization (super-admin or org owner)
router.delete('/:id', requireOrgRole('owner'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const success = await OrgService.deleteOrganization(req.params.id, req.user);
    if (!success) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    return res.status(200).json({ success: true, message: 'Organization deleted' });
  } catch (err) {
    next(err);
  }
});

// 6. List Organization Members
router.get('/:id/members', requireOrgRole('owner', 'admin', 'network_admin', 'auditor'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const members = await OrgService.listMembers(req.params.id);
    return res.status(200).json({ members });
  } catch (err) {
    next(err);
  }
});

// 7. Add Member to Organization (super-admin or org owner/admin)
router.post('/:id/members', requireOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const { user_id, role } = req.body || {};
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    // Making someone owner is an owner's decision, as a role change through PUT is.
    // Admins could otherwise add themselves again with role owner.
    const newRole = role || 'member';
    if (newRole === 'owner' && req.user.role !== 'super-admin' && req.user.org_role !== 'owner') {
      return res.status(403).json({ error: 'Forbidden: only an owner can add an owner' });
    }

    const membership = await OrgService.addMember(req.params.id, user_id, newRole, req.user);
    if (!membership) {
      return res.status(409).json({ error: 'Already a member; change the role with PUT' });
    }
    return res.status(201).json({ membership });
  } catch (err) {
    next(err);
  }
});

// 8. Update Member Role (super-admin or org owner)
router.put('/:id/members/:userId', requireOrgRole('owner'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const { role } = req.body || {};
    if (!role) {
      return res.status(400).json({ error: 'role is required' });
    }

    const updated = await OrgService.updateMemberRole(req.params.id, req.params.userId, role, req.user);
    if (!updated) {
      return res.status(404).json({ error: 'Member not found' });
    }

    return res.status(200).json({ membership: updated });
  } catch (err) {
    if (err.message && err.message.includes('last owner')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// 9. Remove Member from Organization
router.delete('/:id/members/:userId', requireOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const removed = await OrgService.removeMember(req.params.id, req.params.userId, req.user);
    if (!removed) {
      return res.status(404).json({ error: 'Member not found' });
    }

    return res.status(200).json({ success: true, message: 'Member removed' });
  } catch (err) {
    if (err.message && err.message.includes('last owner')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// 10. List Organization Modules
router.get('/:id/modules', async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const modules = await OrgService.getOrgModules(req.params.id);
    return res.status(200).json({ modules });
  } catch (err) {
    next(err);
  }
});

// 11. Update Organization Module Status (super-admin or org owner)
router.put('/:id/modules/:moduleId', requireOrgRole('owner'), async (req, res, next) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.organization_id !== req.params.id) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const { enabled } = req.body || {};
    if (enabled === undefined) {
      return res.status(400).json({ error: 'enabled boolean is required' });
    }

    await OrgService.setOrgModule(req.params.id, req.params.moduleId, Boolean(enabled), req.user);
    return res.status(200).json({ success: true, module_id: req.params.moduleId, enabled: Boolean(enabled) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
