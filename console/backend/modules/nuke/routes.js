const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../../middleware/auth');
const NukeEngine = require('./NukeEngine');
const CanaryService = require('../../services/CanaryService');
const bcrypt = require('bcryptjs');
const { isPostgres, getPgPool, getDatabase } = require('../../db/index');
const { logAuditEvent } = require('../../utils/audit');
const { dmsUnlockLimiter } = require('../../middleware/rateLimit');

// =============================================================================
// TIER 3: Warrant Canary
//
// The three public canary handlers moved to routes/canary.js. They were the only
// reason this router was also mounted at the root of the origin, which published
// every route below outside /api and its rate limiter.
// =============================================================================

// =============================================================================
// TIER 1: User Account Self-Destruct (Auth Required)
// =============================================================================

// 1. Instant Kill
/**
 * The three tiers and the canary in one response.
 *
 * The console asked for /nuke/state and nothing served it, so the request 404ed and
 * the client answered from a fixture: the panel reported a personal dead man's
 * switch armed with a 30-day interval, an owner switch pointed at a Matrix webhook,
 * and a valid warrant canary, on a deployment where none of that had been
 * configured. This composes the three status calls that do exist.
 *
 * Each tier is read independently and a failure in one is reported as a failure in
 * that tier, not as an absent switch: for a destructive control, "unknown" and
 * "not armed" must not look the same.
 */
router.get('/state', authenticateToken, async (req, res, next) => {
  try {
    const isOwner = req.user.role === 'super-admin';

    const [userStatus, personalStatus, ownerStatus, canary] = await Promise.all([
      NukeEngine.getUserNukeStatus(req.user.id).catch((err) => ({ error: err.message })),
      NukeEngine.getPersonalDMSStatus(req.user.id).catch((err) => ({ error: err.message })),
      isOwner
        ? NukeEngine.getOwnerDMSStatus(req.user.id).catch((err) => ({ error: err.message }))
        : Promise.resolve(null),
      CanaryService.getLatestCanary().catch((err) => ({ error: err.message }))
    ]);

    return res.status(200).json({
      tier1_scheduled_kill: userStatus,
      tier1b_personal_dms: personalStatus,
      // null means this account cannot see the owner switch, which is different
      // from an owner switch that is not armed.
      tier2_owner_dms: ownerStatus,
      tier3_warrant_canary: canary?.error
        ? { error: canary.error }
        : {
            canary_url: '/api/nuke/canary.txt',
            signature_valid: Boolean(canary?.valid),
            last_signed_at: canary?.published_at || null,
            signer_public_key: canary?.signer_public_key || null,
            is_active: Boolean(canary?.is_active)
          }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/user/self-destruct', authenticateToken, async (req, res, next) => {
  try {
    const { confirmation_text, disclaimer_accepted } = req.body || {};

    if (!confirmation_text || confirmation_text !== 'DELETE MY ACCOUNT' || disclaimer_accepted !== true) {
      return res.status(400).json({
        error: "Confirmation phrase 'DELETE MY ACCOUNT' and disclaimer acceptance required"
      });
    }

    const result = await NukeEngine.executeInstantUserDestruction(req.user.id, req.token, req.user.username);

    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 2. Scheduled Kill
router.post('/user/schedule', authenticateToken, async (req, res, next) => {
  try {
    const { scheduled_deletion_at } = req.body || {};

    if (!scheduled_deletion_at || scheduled_deletion_at === 'PAST_DATE') {
      return res.status(400).json({
        error: 'Invalid scheduled_deletion_at timestamp'
      });
    }

    const schedDate = new Date(scheduled_deletion_at);
    if (isNaN(schedDate.getTime()) || schedDate.getTime() <= Date.now()) {
      return res.status(400).json({
        error: 'Invalid scheduled_deletion_at timestamp'
      });
    }

    const result = await NukeEngine.scheduleUserDestruction(req.user.id, scheduled_deletion_at);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 3. Cancel Scheduled Kill
router.post('/user/cancel-scheduled', authenticateToken, async (req, res, next) => {
  try {
    const result = await NukeEngine.cancelScheduledUserDestruction(req.user.id);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 4. User Nuke Status
router.get('/user/status', authenticateToken, async (req, res, next) => {
  try {
    const status = await NukeEngine.getUserNukeStatus(req.user.id);
    return res.status(200).json(status);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// TIER 1b: Per-User Personal Dead Man's Switch (Auth Required)
// =============================================================================

// 1. Setup Personal DMS
router.post('/personal-dms/setup', authenticateToken, async (req, res, next) => {
  try {
    const { passphrase, heartbeat_interval_seconds } = req.body || {};

    if (!passphrase || passphrase === undefined || heartbeat_interval_seconds === undefined) {
      return res.status(400).json({
        error: 'Missing passphrase or heartbeat_interval_seconds'
      });
    }

    const interval = Number(heartbeat_interval_seconds);
    if (isNaN(interval) || interval <= 0) {
      return res.status(400).json({
        error: 'heartbeat_interval_seconds must be positive'
      });
    }

    const result = await NukeEngine.setupPersonalDMS(req.user.id, req.body);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 2. Steganographic Unlock / Access
async function handlePersonalUnlock(req, res, next) {
  try {
    const creds =
      req.body?.stego_credentials || req.body?.passphrase || req.body?.credentials || req.body?.credential || '';
    const result = await NukeEngine.unlockPersonalDMS(req.user.id, creds);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'No Personal DMS configured' });
    }
    if (err.status === 401) {
      return res.status(401).json({ error: 'Steganographic verification failed' });
    }
    next(err);
  }
}

// The limiter runs after authentication because it meters the account, not the
// address: the passphrase belongs to the account, so a caller who moves to another
// address must not be handed a fresh budget.
router.post('/personal-dms/unlock', authenticateToken, dmsUnlockLimiter, handlePersonalUnlock);
router.post('/personal-dms/access', authenticateToken, dmsUnlockLimiter, handlePersonalUnlock);
// The console has always called this one. It 404ed, and the 404 was answered from
// a fixture that reported the switch unlocked.
router.post('/personal-dms/auth', authenticateToken, dmsUnlockLimiter, handlePersonalUnlock);

// 3. Heartbeat Reset
router.post('/personal-dms/heartbeat', authenticateToken, async (req, res, next) => {
  try {
    const result = await NukeEngine.heartbeatPersonalDMS(req.user.id);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'No Personal DMS configured' });
    }
    next(err);
  }
});

// 4. Personal DMS Status
router.get('/personal-dms/status', authenticateToken, async (req, res, next) => {
  try {
    const status = await NukeEngine.getPersonalDMSStatus(req.user.id);
    return res.status(200).json(status);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// TIER 2: Network Owner Dead Man's Switch (Super-Admin Only)
// =============================================================================

// 1. Setup Owner DMS
router.post('/owner-dms/setup', authenticateToken, requireRole('super-admin'), async (req, res, next) => {
  try {
    const { passphrase, heartbeat_interval_seconds } = req.body || {};

    if (!passphrase || passphrase === undefined || heartbeat_interval_seconds === undefined) {
      return res.status(400).json({
        error: 'Missing passphrase or heartbeat_interval_seconds'
      });
    }

    const interval = Number(heartbeat_interval_seconds);
    if (isNaN(interval) || interval <= 0) {
      return res.status(400).json({
        error: 'heartbeat_interval_seconds must be positive'
      });
    }

    const result = await NukeEngine.setupOwnerDMS(req.user.id, req.body);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 2. Owner Heartbeat
router.post('/owner-dms/heartbeat', authenticateToken, requireRole('super-admin'), async (req, res, next) => {
  try {
    const { passphrase } = req.body || {};

    if (!passphrase) {
      return res.status(401).json({ error: 'Invalid owner passphrase' });
    }

    const result = await NukeEngine.heartbeatOwnerDMS(req.user.id, passphrase);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status === 401) {
      return res.status(401).json({ error: 'Invalid owner passphrase' });
    }
    next(err);
  }
});

// 3. Owner Status
router.get('/owner-dms/status', authenticateToken, requireRole('super-admin'), async (req, res, next) => {
  try {
    const status = await NukeEngine.getOwnerDMSStatus(req.user.id);
    return res.status(200).json(status);
  } catch (err) {
    next(err);
  }
});

// 4. Trigger Disaster Wipe (Super-Admin emergency test)
// The confirmation phrase, typed exactly, alongside the caller's own password.
//
// This endpoint destroys every node, every user and the entire audit ledger, and it
// did so on a POST with an empty body: a bearer token and the right role were the
// whole of it. A mistyped path during an unrelated sweep wiped a running staging
// deployment, which is the same request an accidental retry, a stale tab or a
// replayed curl would make.
//
// Two independent things are required now. The phrase cannot be produced by
// anything replaying an old request, and the password cannot be produced by a
// stolen access token alone.
const GLOBAL_WIPE_PHRASE = 'DESTROY EVERYTHING PERMANENTLY';

router.post('/owner-dms/trigger', authenticateToken, requireRole('super-admin'), async (req, res, next) => {
  try {
    const { confirmation_phrase: phrase, password } = req.body || {};

    if (phrase !== GLOBAL_WIPE_PHRASE) {
      return res.status(400).json({
        error: 'confirmation_phrase does not match',
        required_phrase: GLOBAL_WIPE_PHRASE
      });
    }

    if (!password) {
      return res.status(400).json({ error: 'password is required to confirm a global wipe' });
    }

    const rows = await runNukeQuery(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id],
      'SELECT password_hash FROM users WHERE id = ?',
      [req.user.id]
    );

    const hash = rows[0]?.password_hash;
    if (!hash || !(await bcrypt.compare(password, hash))) {
      await logAuditEvent({
        eventType: 'NUKE_WIPE_REJECTED',
        severity: 'critical',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        message: 'Global cascading wipe rejected: password did not verify',
        ipAddress: req.ip
      });
      return res.status(401).json({ error: 'password did not verify' });
    }

    // Written before the wipe runs, because the wipe clears the audit table and an
    // event recorded afterwards would be the only row in an otherwise empty ledger
    // with nothing to place it against.
    await logAuditEvent({
      eventType: 'NUKE_WIPE_EXECUTED',
      severity: 'critical',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      message: 'Global cascading wipe authorised and starting',
      ipAddress: req.ip
    });

    const result = await NukeEngine.executeOwnerGlobalCascadingWipe();
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

async function runNukeQuery(pgSql, pgParams, sqliteSql, sqliteParams) {
  if (isPostgres()) {
    const res = await getPgPool().query(pgSql, pgParams);
    return res.rows;
  }
  return getDatabase()
    .prepare(sqliteSql)
    .all(...sqliteParams);
}

// =============================================================================
// WP-302: Governance & Crypto-Shredding (NeroNuke v2)
// =============================================================================
const {
  CryptoShreddingService,
  LegalHoldActiveError,
  DualAuthorizationRequiredError,
  KeyShreddedError
} = require('../../services/CryptoShreddingService');

// 1. Impose Legal Hold
router.post('/legal-hold', authenticateToken, requireRole('super-admin', 'owner', 'admin'), async (req, res, next) => {
  try {
    const { organization_id, reason } = req.body || {};
    if (!organization_id || !reason) {
      return res.status(400).json({ error: 'organization_id and reason are required' });
    }
    const hold = await CryptoShreddingService.imposeLegalHold(organization_id, reason, req.user.id);
    return res.status(201).json({ hold });
  } catch (err) {
    next(err);
  }
});

// 2. Release Legal Hold
router.delete('/legal-hold/:id', authenticateToken, requireRole('super-admin', 'owner'), async (req, res, next) => {
  try {
    const released = await CryptoShreddingService.releaseLegalHold(req.params.id, req.user.id);
    if (!released) {
      return res.status(404).json({ error: 'Legal hold not found or already released' });
    }
    return res.status(200).json({ success: true, released });
  } catch (err) {
    next(err);
  }
});

// 3. List Legal Holds
router.get('/legal-hold', authenticateToken, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const qRes = await pool.query('SELECT * FROM organization_legal_holds ORDER BY created_at DESC');
    return res.status(200).json({ legal_holds: qRes.rows });
  } catch (err) {
    next(err);
  }
});

// 4. Request Dual-Authorization Destruction
router.post(
  '/dual-auth/request',
  authenticateToken,
  requireRole('super-admin', 'owner', 'admin'),
  async (req, res, next) => {
    try {
      const { target_type, target_id, comment } = req.body || {};
      if (!target_type || !target_id) {
        return res.status(400).json({ error: 'target_type and target_id are required' });
      }

      const auth = await CryptoShreddingService.requestDestruction({
        targetType: target_type,
        targetId: target_id,
        initiatorUserId: req.user.id,
        comment
      });

      return res.status(201).json({ authorization: auth });
    } catch (err) {
      if (err instanceof LegalHoldActiveError) {
        return res.status(403).json({ error: err.message, code: 'LEGAL_HOLD_ACTIVE' });
      }
      next(err);
    }
  }
);

// 5. Approve and Execute Dual-Authorization Destruction
router.post(
  '/dual-auth/approve/:id',
  authenticateToken,
  requireRole('super-admin', 'owner', 'admin'),
  async (req, res, next) => {
    try {
      const { comment } = req.body || {};
      const result = await CryptoShreddingService.approveAndExecuteDestruction(req.params.id, req.user.id, comment);

      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof DualAuthorizationRequiredError) {
        return res.status(403).json({ error: err.message, code: 'DUAL_AUTHORIZATION_REQUIRED' });
      }
      if (err instanceof LegalHoldActiveError) {
        return res.status(403).json({ error: err.message, code: 'LEGAL_HOLD_ACTIVE' });
      }
      return res.status(400).json({ error: err.message });
    }
  }
);

// 6. List Dual-Authorization Requests
router.get('/dual-auth', authenticateToken, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const qRes = await pool.query('SELECT * FROM nuke_authorizations ORDER BY created_at DESC');
    return res.status(200).json({ authorizations: qRes.rows });
  } catch (err) {
    next(err);
  }
});

// 7. Reject / Cancel Dual-Authorization Request
router.post(
  '/dual-auth/reject/:id',
  authenticateToken,
  requireRole('super-admin', 'owner', 'admin'),
  async (req, res, next) => {
    try {
      const { comment } = req.body || {};
      const pool = getPgPool();
      const qRes = await pool.query(
        "UPDATE nuke_authorizations SET status = 'rejected', approver_user_id = $1, approver_comment = $2, executed_at = NOW() WHERE id = $3 AND status = 'pending' RETURNING *",
        [req.user.id, comment || 'Rejected by administrator', req.params.id]
      );
      if (qRes.rows.length === 0) {
        return res.status(404).json({ error: 'Pending authorization not found or already closed' });
      }
      return res.status(200).json({ success: true, authorization: qRes.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// 8. Governance Overview Status (OpenAPI /nuke/status)
router.get('/status', authenticateToken, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const orgId = req.user?.organization_id;

    // Check active legal holds
    let holdsCount = 0;
    if (orgId) {
      const hRes = await pool.query(
        'SELECT COUNT(*) FROM organization_legal_holds WHERE organization_id = $1 AND active = TRUE',
        [orgId]
      );
      holdsCount = parseInt(hRes.rows[0].count, 10);
    } else {
      const hRes = await pool.query('SELECT COUNT(*) FROM organization_legal_holds WHERE active = TRUE');
      holdsCount = parseInt(hRes.rows[0].count, 10);
    }

    // Check pending approvals
    const aRes = await pool.query(
      "SELECT id, target_type, target_id, initiator_user_id as proposed_by, created_at, expires_at FROM nuke_authorizations WHERE status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC"
    );
    const pendingApprovals = aRes.rows;

    // Key status
    let keyStatus = 'active';
    if (orgId) {
      const kRes = await pool.query('SELECT status FROM organization_keys WHERE organization_id = $1', [orgId]);
      if (kRes.rows.length > 0) {
        keyStatus = kRes.rows[0].status;
      }
    }

    // Owner DMS check
    let ownerArmed = false;
    try {
      const dmsRes = await pool.query('SELECT armed FROM owner_dead_man_switch WHERE id = 1');
      if (dmsRes.rows.length > 0) {
        ownerArmed = Boolean(dmsRes.rows[0].armed);
      }
    } catch (_) {
      // Table might not exist or empty
    }

    return res.status(200).json({
      armed: pendingApprovals.length > 0 || ownerArmed,
      legalHold: holdsCount > 0,
      legal_hold_active: holdsCount > 0,
      active_legal_holds: holdsCount,
      pending_authorizations: pendingApprovals.length,
      keys_status: keyStatus,
      owner_dms_armed: ownerArmed,
      pendingApprovals
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
