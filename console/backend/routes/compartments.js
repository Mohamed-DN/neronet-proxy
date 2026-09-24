const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, signToken, signRefreshToken } = require('../middleware/auth');
const { requireOrgRole, resolveUserOrg } = require('../middleware/rbac');
const { getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');
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

    // Check duress stealth wipe password
    if (user.password_hash_stealth_wipe && (await bcrypt.compare(password, user.password_hash_stealth_wipe))) {
      await pool.query(
        'DELETE FROM nodes WHERE compartment_id IN (SELECT id FROM compartments WHERE is_hidden = TRUE)'
      );
      await pool.query('DELETE FROM compartments WHERE is_hidden = TRUE');
      logAuditEvent({
        eventType: 'DURESS_STEALTH_WIPE',
        severity: 'critical',
        actorUserId: user.id,
        actorUsername: user.username,
        message: `Stealth wipe triggered by ${user.username} during compartment unlock`
      });
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
        severity: 'warn',
        actorUserId: user.id,
        actorUsername: user.username,
        message: `Failed ghost vault unlock attempt by ${user.username}`
      });
      return res.status(401).json({ error: 'Invalid vault password' });
    }

    const userPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      organization_id: user.organization_id,
      compartment_access: 'root'
    };

    const token = signToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);

    const tokenId = `tok-${uuidv4().substring(0, 8)}`;
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, ip_address, revoked, revoked_at)
       VALUES ($1, $2, $3, $4, $5, FALSE, NULL)`,
      [tokenId, user.id, tokenHash, expiresAt, req.ip || '127.0.0.1']
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/'
    });
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth'
    });

    logAuditEvent({
      eventType: 'VAULT_UNLOCKED',
      severity: 'info',
      actorUserId: user.id,
      actorUsername: user.username,
      message: `Ghost vaults unlocked by ${user.username}`
    });

    return res.status(200).json({
      success: true,
      compartment_access: 'root',
      token,
      refreshToken,
      user: userPayload
    });
  } catch (err) {
    next(err);
  }
});

// 1b. POST /api/compartments/lock
// Reverts session to standard compartment access tier
router.post('/lock', async (req, res, next) => {
  try {
    const pool = getPgPool();
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userRes.rows[0];

    const userPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      organization_id: user.organization_id,
      compartment_access: 'standard'
    };

    const token = signToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);

    const tokenId = `tok-${uuidv4().substring(0, 8)}`;
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, ip_address, revoked, revoked_at)
       VALUES ($1, $2, $3, $4, $5, FALSE, NULL)`,
      [tokenId, user.id, tokenHash, expiresAt, req.ip || '127.0.0.1']
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/'
    });
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth'
    });

    logAuditEvent({
      eventType: 'VAULT_LOCKED',
      severity: 'info',
      actorUserId: user.id,
      actorUsername: user.username,
      message: `Ghost vaults locked by ${user.username}`
    });

    return res.status(200).json({
      success: true,
      compartment_access: 'standard',
      token,
      refreshToken,
      user: userPayload
    });
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
