const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { resolveUserOrg, requireRole, requireOrgRole, requireNotAuditor } = require('../middleware/rbac');
const OrgService = require('../services/OrgService');

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
router.get('/:id/members', async (req, res, next) => {
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

    const membership = await OrgService.addMember(req.params.id, user_id, role || 'member', req.user);
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

module.exports = router;
