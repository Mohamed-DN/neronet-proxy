const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requireOrgRole, resolveUserOrg } = require('../middleware/rbac');
const CompartmentService = require('../services/CompartmentService');

router.use(authenticateToken);
router.use(resolveUserOrg);

// 1. List Compartments
router.get('/', async (req, res, next) => {
  try {
    const orgId = req.query.org_id || req.user.organization_id || 'org-default';
    if (req.user.role !== 'super-admin' && req.user.organization_id !== orgId) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const accessTier = req.user.compartment_access || req.user.access_tier || 'standard';
    const compartments = await CompartmentService.listCompartments(orgId, accessTier);
    return res.status(200).json({ compartments });
  } catch (err) {
    next(err);
  }
});

// 2. Get Compartment
router.get('/:id', async (req, res, next) => {
  try {
    const orgId = req.query.org_id || req.user.organization_id || 'org-default';
    const accessTier = req.user.compartment_access || req.user.access_tier || 'standard';
    const compartment = await CompartmentService.getCompartment(req.params.id, orgId, accessTier);

    if (!compartment) {
      return res.status(404).json({ error: 'Compartment not found' });
    }

    return res.status(200).json({ compartment });
  } catch (err) {
    next(err);
  }
});

// 3. Create Compartment (owner, admin, network_admin)
router.post('/', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const { name, slug, subnet_cidr, is_hidden } = req.body || {};

    const accessTier = req.user.compartment_access || req.user.access_tier || 'standard';
    const compartment = await CompartmentService.createCompartment(
      {
        organizationId: orgId,
        name,
        slug,
        subnetCidr: subnet_cidr,
        isHidden: Boolean(is_hidden)
      },
      accessTier,
      req.user
    );

    return res.status(201).json({ compartment });
  } catch (err) {
    if (err.message.includes('Forbidden')) {
      return res.status(403).json({ error: err.message });
    }
    next(err);
  }
});

// 4. Update Compartment
router.put('/:id', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const { name, subnet_cidr, is_hidden } = req.body || {};
    const accessTier = req.user.compartment_access || req.user.access_tier || 'standard';

    const updated = await CompartmentService.updateCompartment(
      req.params.id,
      orgId,
      {
        name,
        subnetCidr: subnet_cidr,
        isHidden: is_hidden
      },
      accessTier,
      req.user
    );

    if (!updated) {
      return res.status(404).json({ error: 'Compartment not found' });
    }

    return res.status(200).json({ compartment: updated });
  } catch (err) {
    if (err.message.includes('Forbidden')) {
      return res.status(403).json({ error: err.message });
    }
    next(err);
  }
});

// 5. Delete Compartment
router.delete('/:id', requireOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const accessTier = req.user.compartment_access || req.user.access_tier || 'standard';

    const deleted = await CompartmentService.deleteCompartment(req.params.id, orgId, accessTier, req.user);
    if (!deleted) {
      return res.status(404).json({ error: 'Compartment not found' });
    }

    return res.status(200).json({ success: true, message: 'Compartment deleted' });
  } catch (err) {
    if (err.message.includes('Cannot delete the default compartment')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// 6. List Compartment Peering Rules
router.get('/peerings/list', async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const peerings = await CompartmentService.listPeeringRules(orgId);
    return res.status(200).json({ peerings });
  } catch (err) {
    next(err);
  }
});

// 7. Create Compartment Peering Rule
router.post('/peerings/create', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const { src_compartment_id, dst_compartment_id, policy } = req.body || {};

    if (!src_compartment_id || !dst_compartment_id) {
      return res.status(400).json({ error: 'src_compartment_id and dst_compartment_id are required' });
    }

    const peering = await CompartmentService.createPeeringRule(
      {
        organizationId: orgId,
        srcCompartmentId: src_compartment_id,
        dstCompartmentId: dst_compartment_id,
        policy: policy || 'allow'
      },
      req.user
    );

    return res.status(201).json({ peering });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
