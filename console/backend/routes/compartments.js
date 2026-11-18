const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { authenticateToken } = require('../middleware/auth');
const { changeRootGrant } = require('../services/ConsoleSessionService');
const { setAuthCookies } = require('../utils/cookies');
const { browserRotation, applyBrowserRotation } = require('../utils/browserCredentials');
const { requireOrgRole, resolveUserOrg } = require('../middleware/rbac');
const { getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');
const CompartmentService = require('../services/CompartmentService');
const DuressService = require('../services/DuressService');
const logger = require('../utils/logger');

// Errors CompartmentService raises with a status: refusals the caller can act on.
// One that carries a code (name_in_use, nodes_not_in_source, ...) answers with the code as
// "error", so the console can branch on it, and the sentence as "message".
function sendServiceError(res, err) {
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    const body = err.code ? { error: err.code, message: err.message } : { error: err.message };
    res.status(err.status).json(body);
    return true;
  }
  return false;
}

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

// 1a. POST /api/compartments/unlock
// Unlocks Ghost Vaults dynamically using root password or duress password
router.post('/unlock', async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const pool = getPgPool();
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userRes.rows[0];

    // Duress password: wipes this organisation's hidden compartments, within the
    // limits DuressService sets, and answers like a wrong password.
    if (
      user.password_hash_stealth_wipe &&
      (await bcrypt.compare(password, user.password_hash_stealth_wipe)) &&
      (await DuressService.isEnabledFor(user))
    ) {
      try {
        await DuressService.wipeHiddenCompartments(user, { ipAddress: req.ip, via: 'vault_unlock' });
      } catch (err) {
        logger.error(`Stealth wipe for ${user.id} failed: ${err.message}`);
      }
      return res.status(401).json({ error: 'Invalid vault password' });
    }

    // Check root password
    let isMatch = false;
    if (user.password_hash_root && (await bcrypt.compare(password, user.password_hash_root))) {
      isMatch = true;
    }

    if (!isMatch) {
      logAuditEvent({
        eventType: 'VAULT_UNLOCK_FAILED',
        organizationId: req.user.organization_id,
        severity: 'warn',
        actorUserId: user.id,
        actorUsername: user.username,
        message: `Failed ghost vault unlock attempt by ${user.username}`
      });
      return res.status(401).json({ error: 'Invalid vault password' });
    }

    const session = await changeRootGrant({
      userId: req.user.id,
      sessionId: req.sessionAuthority.sessionId,
      root: true,
      verifiedRootHash: user.password_hash_root,
      organizationIdAtIssue: req.sessionAuthority.organizationIdAtIssue,
      ipAddress: req.ip,
      browser: browserRotation(req, ['unlock'])
    });
    if (req.browserIssuance) applyBrowserRotation(req, res, session);
    else setAuthCookies(req, res, session);

    logAuditEvent({
      eventType: 'VAULT_UNLOCKED',
      organizationId: session.user.organization_id,
      severity: 'info',
      actorUserId: user.id,
      actorUsername: user.username,
      message: `Ghost vaults unlocked by ${user.username}`
    });

    return res.status(200).json({
      success: true,
      compartment_access: 'root',
      ...(req.browserIssuance ? { selected: session.browser } : { token: session.token }),
      user: session.user
    });
  } catch (err) {
    next(err);
  }
});

// 1b. POST /api/compartments/lock
// Reverts session to standard compartment access tier
router.post('/lock', async (req, res, next) => {
  try {
    const session = await changeRootGrant({
      userId: req.user.id,
      sessionId: req.sessionAuthority.sessionId,
      root: false,
      ipAddress: req.ip,
      browser: browserRotation(req, ['lock'])
    });
    if (req.browserIssuance) applyBrowserRotation(req, res, session);
    else setAuthCookies(req, res, session);
    const user = session.user;

    logAuditEvent({
      eventType: 'VAULT_LOCKED',
      organizationId: user.organization_id,
      severity: 'info',
      actorUserId: user.id,
      actorUsername: user.username,
      message: `Ghost vaults locked by ${user.username}`
    });

    return res.status(200).json({
      success: true,
      compartment_access: 'standard',
      ...(req.browserIssuance ? { selected: session.browser } : { token: session.token }),
      user: session.user
    });
  } catch (err) {
    next(err);
  }
});

// 2. Get Compartment
router.get('/:id', async (req, res, next) => {
  try {
    const orgId = req.query.org_id || req.user.organization_id || 'org-default';
    // The same check as the list: ?org_id names another organisation only for the
    // platform super-admin.
    if (req.user.role !== 'super-admin' && req.user.organization_id !== orgId) {
      return res.status(404).json({ error: 'Compartment not found' });
    }
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
    const { name, slug, subnet_cidr, is_hidden, line_colour } = req.body || {};

    const accessTier = req.user.compartment_access || req.user.access_tier || 'standard';
    const compartment = await CompartmentService.createCompartment(
      {
        organizationId: orgId,
        name,
        slug,
        subnetCidr: subnet_cidr,
        isHidden: Boolean(is_hidden),
        lineColour: line_colour
      },
      accessTier,
      req.user
    );

    return res.status(201).json({ compartment });
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    if (err.message.includes('Forbidden')) {
      return res.status(403).json({ error: err.message });
    }
    next(err);
  }
});

// 4a. Reorder lines: { ids: [...] }, first id first. Display only. Registered before
// PUT /:id so "reorder" is not read as a compartment id.
router.put('/reorder', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const compartments = await CompartmentService.reorderCompartments(
      orgId,
      (req.body || {}).ids,
      req.user.compartment_access || req.user.access_tier || 'standard',
      req.user
    );
    return res.status(200).json({ compartments });
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    next(err);
  }
});

// 4. Update Compartment (name, subnet, hidden, and the display-only line_colour and sort_order)
router.put('/:id', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const { name, subnet_cidr, is_hidden, line_colour, sort_order } = req.body || {};
    const accessTier = req.user.compartment_access || req.user.access_tier || 'standard';

    const updated = await CompartmentService.updateCompartment(
      req.params.id,
      orgId,
      {
        name,
        subnetCidr: subnet_cidr,
        isHidden: is_hidden,
        lineColour: line_colour,
        sortOrder: sort_order
      },
      accessTier,
      req.user
    );

    if (!updated) {
      return res.status(404).json({ error: 'Compartment not found' });
    }

    return res.status(200).json({ compartment: updated });
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
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

const accessTierOf = (req) => req.user.compartment_access || req.user.access_tier || 'standard';

// 6. List Compartment Peering Rules
router.get('/peerings/list', async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const peerings = await CompartmentService.listPeeringRules(orgId, accessTierOf(req));
    return res.status(200).json({ peerings });
  } catch (err) {
    next(err);
  }
});

// 7. Create Compartment Peering Rule. A peering with policy "allow" connects the two
// compartments both ways in the data plane (ADR 0021).
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
      req.user,
      accessTierOf(req)
    );

    return res.status(201).json({ peering });
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    next(err);
  }
});

// 8. Remove a peering: the two compartments stop reaching each other.
router.delete('/peerings/:peeringId', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const deleted = await CompartmentService.deletePeeringRule(req.params.peeringId, orgId, req.user);
    if (!deleted) {
      return res.status(404).json({ error: 'Peering not found' });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// 9. Move nodes into a compartment: { node_ids: [...] }. Moving them into the default
// compartment is how a node leaves a sub-network.
router.post('/:id/members', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const moved = await CompartmentService.setMembers(
      req.params.id,
      orgId,
      (req.body || {}).node_ids,
      accessTierOf(req),
      req.user
    );
    if (moved === null) {
      return res.status(404).json({ error: 'Compartment not found' });
    }
    return res.status(200).json({ moved });
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    next(err);
  }
});

// 10. Split devices off a line into a new one: { name, node_ids: [...], line_colour? }.
// One transaction, one ACL epoch bump. The new line starts with no peerings.
router.post('/:id/split', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const { name, node_ids, line_colour } = req.body || {};
    const result = await CompartmentService.splitCompartment(
      req.params.id,
      orgId,
      { name, nodeIds: node_ids, lineColour: line_colour },
      accessTierOf(req),
      req.user
    );
    if (!result) return res.status(404).json({ error: 'Compartment not found' });
    return res.status(201).json(result);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    next(err);
  }
});

// 11. Merge a line into another: { into }. Owner or admin, as for a delete: the merged
// line and its peerings are gone afterwards.
router.post('/:id/merge', requireOrgRole('owner', 'admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const result = await CompartmentService.mergeCompartment(
      req.params.id,
      orgId,
      (req.body || {}).into,
      accessTierOf(req),
      req.user
    );
    if (!result) return res.status(404).json({ error: 'Compartment not found' });
    return res.status(200).json(result);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    next(err);
  }
});

// 12. What a move would change, with nothing written: { node_ids: [...], to }.
router.post('/preview-move', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const { node_ids, to } = req.body || {};
    const preview = await CompartmentService.previewMove(orgId, node_ids, to, accessTierOf(req));
    if (!preview) return res.status(404).json({ error: 'Compartment not found' });
    return res.status(200).json(preview);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    next(err);
  }
});

// 13. What a split would change, with nothing written: { node_ids: [...] }.
router.post('/:id/preview-split', requireOrgRole('owner', 'admin', 'network_admin'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id || 'org-default';
    const preview = await CompartmentService.previewSplit(
      req.params.id,
      orgId,
      (req.body || {}).node_ids,
      accessTierOf(req)
    );
    if (!preview) return res.status(404).json({ error: 'Compartment not found' });
    return res.status(200).json(preview);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    next(err);
  }
});

module.exports = router;
