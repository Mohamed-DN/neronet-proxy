const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const { loginLimiter, registerLimiter } = require('../middleware/rateLimit');
const router = express.Router();
const config = require('../config/env');
const { getPgPool } = require('../db/index');
const {
  signToken,
  signRefreshToken,
  authenticateToken,
  verifyToken,
  verifyRefreshToken
} = require('../middleware/auth');
const { blacklistToken, isTokenBlacklisted } = require('../db/valkey');
const { logAuditEvent } = require('../utils/audit');
const { setAuthCookies, clearAuthCookies } = require('../utils/cookies');
const TotpService = require('../services/TotpService');
const OidcService = require('../services/OidcService');
const DuressService = require('../services/DuressService');
const MfaPolicy = require('../services/MfaPolicy');
const { CryptoShreddingService } = require('../services/CryptoShreddingService');
const logger = require('../utils/logger');

// Pre-computed constant-time dummy bcrypt hash to prevent timing side-channel attacks on non-existent usernames
const DUMMY_BCRYPT_HASH = '$2a$10$wN3t8gX1ZkGkR0e2M8t0y.9gZ0n4p7s2e6u1v8w5x9y2z3a4b5c6d';

/**
 * Issue new session (access token + refresh token) and store in database
 */
async function issueUserSession(req, res, user, pool) {
  const userPayload = {
    id: user.id,
    username: user.username,
    role: user.role,
    organization_id: user.organization_id,
    compartment_access: user.compartment_access || 'standard'
  };

  const token = signToken(userPayload);
  const refreshToken = signRefreshToken(userPayload);

  const tokenId = `tok-${uuidv4().substring(0, 8)}`;
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, ip_address, revoked, revoked_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, NULL)`,
    [tokenId, user.id, tokenHash, expiresAt, req.ip || '127.0.0.1']
  );

  setAuthCookies(req, res, { token, refreshToken });

  return {
    token,
    refreshToken,
    user: userPayload
  };
}

// 1. Register User (Public)
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    // A role in the body is ignored. This endpoint is public; letting it choose the
    // role handed platform super-admin to anyone who asked.
    const { username, password, email } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required registration fields' });
    }

    const userId = `usr-${uuidv4().substring(0, 8)}`;
    const userRole = 'user';
    const userEmail = email || `${username}@sovereign.local`;
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);

    const pool = getPgPool();
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    await pool.query(
      `
      INSERT INTO users (
        id, username, email, password_hash, role, status, bypass_apps
      ) VALUES (
        $1, $2, $3, $4, $5, 'active', '[]'::jsonb
      )
    `,
      [userId, username, userEmail, passwordHash, userRole]
    );

    logAuditEvent({
      eventType: 'USER_REGISTER',
      severity: 'info',
      actorUserId: userId,
      actorUsername: username,
      targetId: userId,
      targetType: 'user',
      message: `User ${username} registered successfully`,
      ipAddress: req.ip
    });

    const session = await issueUserSession(req, res, { id: userId, username, role: userRole }, pool);

    return res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

// 2. Login User (Public - Strict bcrypt + constant-time dummy verification + MFA challenge)
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password, totp_code, code } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing username or password' });
    }

    const pool = getPgPool();
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = userRes.rows[0] || null;

    // Timing side-channel mitigation: If user doesn't exist, perform dummy bcrypt comparison
    if (!user) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    let isMatch = false;
    let accessTier = 'standard'; // 'standard', 'root', 'stealth_wipe', 'nuclear_wipe'

    try {
      if (user.password_hash && (await bcrypt.compare(password, user.password_hash))) {
        isMatch = true;
        accessTier = 'standard';
      } else if (user.password_hash_root && (await bcrypt.compare(password, user.password_hash_root))) {
        isMatch = true;
        accessTier = 'root';
      } else if (user.password_hash_stealth_wipe && (await bcrypt.compare(password, user.password_hash_stealth_wipe))) {
        isMatch = true;
        accessTier = 'stealth_wipe';
      } else if (user.password_hash_nuclear_wipe && (await bcrypt.compare(password, user.password_hash_nuclear_wipe))) {
        isMatch = true;
        accessTier = 'nuclear_wipe';
      }
    } catch (err) {
      isMatch = false;
    }

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Before any duress action: a suspended account destroys nothing.
    if (user.status === 'suspended' || user.status === 'revoked') {
      return res.status(403).json({ error: 'Account is suspended or revoked' });
    }

    // Duress passwords. DuressService bounds what each may destroy to what this
    // account could delete through the API anyway; see the comment there.
    if (accessTier === 'stealth_wipe' || accessTier === 'nuclear_wipe') {
      if (!(await DuressService.isEnabledFor(user))) {
        // Where the organisation does not allow them, a duress password is a wrong one.
        return res.status(401).json({ error: 'Invalid username or password' });
      }
    }

    if (accessTier === 'stealth_wipe') {
      try {
        await DuressService.wipeHiddenCompartments(user, { ipAddress: req.ip, via: 'login' });
      } catch (err) {
        logger.error(`Stealth wipe for ${user.id} failed: ${err.message}`);
      }
      accessTier = 'standard'; // The decoy session opens either way.
    } else if (accessTier === 'nuclear_wipe') {
      try {
        await DuressService.wipeOwnAccount(user, { ipAddress: req.ip });
      } catch (err) {
        logger.error(`Nuclear wipe for ${user.id} failed: ${err.message}`);
      }
      // Looks like a failed sign-in, and never opens a session, whether or not the wipe completed.
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // MFA (ADR 0018): required when the account enrolled, or when the server's policy
    // (SOVEREIGN_MFA_MANDATORY, see MfaPolicy) requires it for this account.
    const requiresMfa = await MfaPolicy.isMfaRequired(user);

    const providedOtp = totp_code || code;

    if (requiresMfa) {
      // If user has totp configured and provided OTP code directly in login payload
      if (user.totp_enabled && providedOtp) {
        const isValid = TotpService.verifyTotp(providedOtp, await openTotpSecret(user, user.totp_secret));
        if (!isValid) {
          return res.status(401).json({ error: 'Invalid TOTP code' });
        }
        // Valid TOTP -> fall through to issue session!
      } else {
        // Issue temporary 5-minute mfa_token for verification step
        // Proves the password step only. It is spent by the sign-in it completes, and
        // it can enrol an authenticator only on an account that has none.
        const mfaToken = jwt.sign(
          {
            sub: user.id,
            username: user.username,
            role: user.role,
            type: 'mfa_pending'
          },
          config.JWT_SECRET,
          { expiresIn: '5m', jwtid: uuidv4() }
        );

        return res.status(200).json({
          mfa_required: true,
          mfa_setup_required: !user.totp_enabled,
          mfa_token: mfaToken
        });
      }
    }

    const session = await issueUserSession(req, res, { ...user, compartment_access: accessTier }, pool);

    logAuditEvent({
      eventType: 'AUTH_LOGIN',
      severity: 'info',
      actorUserId: user.id,
      actorUsername: user.username,
      targetId: user.id,
      targetType: 'user',
      message: `User ${user.username} logged in successfully`,
      ipAddress: req.ip
    });

    return res.status(200).json(session);
  } catch (err) {
    next(err);
  }
});

/**
 * Who is calling an MFA endpoint: a full session, or the password step of a sign-in
 * (an "mfa_pending" token). The two are allowed different things; treating them the
 * same is what let the password step replace an enrolled authenticator.
 */
async function resolveMfaCaller(req) {
  let token = (req.body && req.body.mfa_token) || '';
  const authHeader = req.headers['authorization'] || '';
  if (!token && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (!token && req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }
  if (!token) {
    return { error: { status: 401, message: 'Authentication or MFA token required' } };
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (e) {
    return { error: { status: 401, message: 'Invalid or expired token' } };
  }
  if (await isTokenBlacklisted(token)) {
    return { error: { status: 401, message: 'Token has been revoked or already used' } };
  }

  const userRes = await getPgPool().query(
    `SELECT id, username, email, role, status, organization_id, totp_secret, totp_enabled,
            totp_recovery_codes, totp_pending_secret, totp_pending_recovery_codes
       FROM users WHERE id = $1`,
    [decoded.sub || decoded.id]
  );
  if (userRes.rows.length === 0) {
    return { error: { status: 401, message: 'Invalid or expired token' } };
  }
  const user = userRes.rows[0];
  if (user.status && user.status !== 'active') {
    return { error: { status: 403, message: `Account is ${user.status}` } };
  }

  return { token, decoded, user, passwordStepOnly: decoded.type === 'mfa_pending' };
}

/** TOTP secrets are stored sealed with the account's organisation data key. */
function openTotpSecret(user, value) {
  return CryptoShreddingService.openForOrg(user.organization_id, value);
}

function parseCodes(value) {
  let codes = value;
  if (typeof codes === 'string') {
    try {
      codes = JSON.parse(codes);
    } catch (e) {
      codes = [];
    }
  }
  return Array.isArray(codes) ? codes : [];
}

// 2a. MFA Setup: start enrolling an authenticator.
//
// From the password step only for an account with no authenticator yet: that is how
// an account the policy requires MFA of enrols before its first session. Replacing an
// enrolled authenticator needs a full session and a current code from it. Either way
// the new secret is held as pending; the one in use is untouched until /mfa/verify
// confirms a code from the new one.
router.post('/mfa/setup', loginLimiter, async (req, res, next) => {
  try {
    const caller = await resolveMfaCaller(req);
    if (caller.error) {
      return res.status(caller.error.status).json({ error: caller.error.message });
    }
    const { user, passwordStepOnly } = caller;

    if (user.totp_enabled) {
      if (passwordStepOnly) {
        return res.status(409).json({
          error: 'An authenticator is already enrolled. Sign in with it, then replace it from your account.'
        });
      }
      const currentCode = req.body && req.body.current_code;
      if (!currentCode || !TotpService.verifyTotp(String(currentCode), await openTotpSecret(user, user.totp_secret))) {
        return res.status(401).json({ error: 'A current code from the enrolled authenticator is required' });
      }
    }

    const secret = TotpService.generateSecret(20);
    const { qrDataUrl, otpauthUri } = await TotpService.generateQrCode(user.username, secret);
    const recoveryCodes = TotpService.generateRecoveryCodes(8);
    const hashedCodes = recoveryCodes.map((c) => TotpService.hashRecoveryCode(c));

    await getPgPool().query(
      'UPDATE users SET totp_pending_secret = $1, totp_pending_recovery_codes = $2::jsonb WHERE id = $3',
      [await CryptoShreddingService.sealForOrg(user.organization_id, secret), JSON.stringify(hashedCodes), user.id]
    );

    logAuditEvent({
      eventType: 'AUTH_MFA_SETUP_STARTED',
      severity: 'info',
      actorUserId: user.id,
      actorUsername: user.username,
      targetId: user.id,
      targetType: 'user',
      message: `User ${user.username} started enrolling an authenticator${user.totp_enabled ? ' to replace the current one' : ''}`,
      ipAddress: req.ip
    });

    return res.status(200).json({
      secret,
      qrDataUrl,
      otpauthUri,
      recoveryCodes
    });
  } catch (err) {
    next(err);
  }
});

// 2b. MFA Verify: completes a sign-in, or confirms an authenticator being enrolled.
//
// - Password step, account with an authenticator: a code (or a recovery code) from
//   the enrolled one completes the sign-in.
// - Password step, account without one: a code from the pending authenticator enrols
//   it and completes the sign-in.
// - Full session: a code from the pending authenticator replaces the enrolled one.
// The password-step token is spent when it completes a sign-in.
router.post('/mfa/verify', loginLimiter, async (req, res, next) => {
  try {
    const caller = await resolveMfaCaller(req);
    if (caller.error) {
      return res.status(caller.error.status).json({ error: caller.error.message });
    }
    const { user, passwordStepOnly, token, decoded } = caller;
    const { code, recovery_code } = req.body || {};
    const pool = getPgPool();

    const confirmingPending = !(passwordStepOnly && user.totp_enabled);

    if (confirmingPending) {
      if (!user.totp_pending_secret) {
        return res.status(400).json({ error: 'No authenticator is being enrolled' });
      }
      if (!code) {
        return res.status(400).json({ error: 'Missing code' });
      }
      if (!TotpService.verifyTotp(String(code), await openTotpSecret(user, user.totp_pending_secret))) {
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
      await pool.query(
        `UPDATE users SET totp_secret = totp_pending_secret,
                          totp_recovery_codes = COALESCE(totp_pending_recovery_codes, '[]'::jsonb),
                          totp_enabled = TRUE,
                          totp_pending_secret = NULL,
                          totp_pending_recovery_codes = NULL
          WHERE id = $1`,
        [user.id]
      );
    } else if (recovery_code) {
      const result = TotpService.verifyAndConsumeRecoveryCode(recovery_code, parseCodes(user.totp_recovery_codes));
      if (!result.valid) {
        return res.status(401).json({ error: 'Invalid recovery code' });
      }
      await pool.query('UPDATE users SET totp_recovery_codes = $1::jsonb WHERE id = $2', [
        JSON.stringify(result.remainingCodes),
        user.id
      ]);
    } else if (code) {
      if (!TotpService.verifyTotp(String(code), await openTotpSecret(user, user.totp_secret))) {
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    } else {
      return res.status(400).json({ error: 'Missing code or recovery_code' });
    }

    if (passwordStepOnly) {
      const remaining = Math.max(1, (decoded.exp || 0) - Math.floor(Date.now() / 1000));
      await blacklistToken(token, remaining);
    }

    logAuditEvent({
      eventType: confirmingPending ? 'AUTH_MFA_ENROLLED' : 'AUTH_MFA_VERIFY',
      severity: 'info',
      actorUserId: user.id,
      actorUsername: user.username,
      targetId: user.id,
      targetType: 'user',
      message: confirmingPending
        ? `User ${user.username} enrolled an authenticator`
        : `User ${user.username} successfully verified MFA`,
      ipAddress: req.ip
    });

    const session = await issueUserSession(req, res, user, pool);
    return res.status(200).json(session);
  } catch (err) {
    next(err);
  }
});

// 3. Refresh Token (With atomic single-use rotation, replay detection, role re-read from PG, and HttpOnly cookies)
router.post('/refresh', async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    let token = '';

    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.cookies && req.cookies.refreshToken) {
      token = req.cookies.refreshToken;
    } else if (req.body && (req.body.refreshToken || req.body.refresh_token)) {
      token = req.body.refreshToken || req.body.refresh_token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Missing token for refresh' });
    }

    const blacklisted = await isTokenBlacklisted(token);
    if (blacklisted) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Token has been revoked' });
    }

    const decoded = verifyRefreshToken(token);
    if (!decoded) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const pool = getPgPool();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Query database for refresh token status
    const tokenRes = await pool.query(
      'SELECT id, user_id, expires_at, revoked, revoked_at FROM refresh_tokens WHERE token_hash = $1 OR token_hash = $2',
      [tokenHash, token]
    );

    if (tokenRes.rows.length === 0) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Refresh token not recognized' });
    }

    const rtRow = tokenRes.rows[0];

    // ATOMIC REPLAY DETECTION:
    // If presented refresh token was already revoked, immediately revoke ALL tokens for this user!
    if (rtRow.revoked || rtRow.revoked_at !== null) {
      await pool.query(
        'UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE user_id = $1 AND (revoked = FALSE OR revoked_at IS NULL)',
        [rtRow.user_id]
      );

      logAuditEvent({
        eventType: 'AUTH_REFRESH_REPLAY_DETECTED',
        severity: 'critical',
        actorUserId: rtRow.user_id,
        targetId: rtRow.user_id,
        targetType: 'user',
        message: `Replay attack detected with revoked refresh token ${rtRow.id}. All sessions revoked for user ${rtRow.user_id}.`,
        ipAddress: req.ip
      });

      clearAuthCookies(res);
      return res.status(401).json({ error: 'Revoked refresh token presented: entire session chain terminated' });
    }

    // Check expiration
    if (new Date(rtRow.expires_at) < new Date()) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    // Single use. The condition makes the consumption atomic: of two requests racing
    // with the same token, only one updates the row.
    const consumed = await pool.query(
      'UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE id = $1 AND revoked = FALSE AND revoked_at IS NULL',
      [rtRow.id]
    );
    if (consumed.rowCount !== 1) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Refresh token already used' });
    }

    // Re-read current role and status from PostgreSQL source of truth
    const userRes = await pool.query('SELECT id, username, role, status, organization_id FROM users WHERE id = $1', [
      rtRow.user_id
    ]);
    if (userRes.rows.length === 0 || userRes.rows[0].status === 'suspended' || userRes.rows[0].status === 'revoked') {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Account inactive or suspended' });
    }

    // WP-303: Verify user active status on external IdP for OIDC SSO managed accounts
    const idpStatus = await OidcService.verifyUserActiveOnIdP(rtRow.user_id);
    if (!idpStatus.active) {
      clearAuthCookies(res);
      return res.status(401).json({ error: idpStatus.reason || 'Account deactivated on identity provider' });
    }
    const latestUser = userRes.rows[0];

    // Issue new access token and rotated refresh token with the updated role. The
    // organisation is carried too: the feature module guard reads it from the token,
    // and without it a regulated organisation got its disabled modules back.
    const userPayload = {
      id: latestUser.id,
      username: latestUser.username,
      role: latestUser.role,
      organization_id: latestUser.organization_id
    };

    const newToken = signToken(userPayload);
    const newRefreshToken = signRefreshToken(userPayload);

    const newId = `tok-${uuidv4().substring(0, 8)}`;
    const newHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, ip_address, revoked, revoked_at)
       VALUES ($1, $2, $3, $4, $5, FALSE, NULL)`,
      [newId, latestUser.id, newHash, newExpiresAt, req.ip || '127.0.0.1']
    );

    setAuthCookies(req, res, { token: newToken, refreshToken: newRefreshToken });

    return res.status(200).json({
      token: newToken,
      refreshToken: newRefreshToken,
      user: userPayload
    });
  } catch (err) {
    next(err);
  }
});

// 4. Get Current User (Authenticated)
router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const userRes = await pool.query(
      'SELECT id, username, email, role, status, totp_enabled, bypass_apps, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userRes.rows[0] || null;

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let bypassApps = user.bypass_apps;
    if (typeof bypassApps === 'string') {
      try {
        bypassApps = JSON.parse(bypassApps);
      } catch (e) {
        bypassApps = [];
      }
    }

    return res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        status: user.status,
        totp_enabled: Boolean(user.totp_enabled),
        bypass_apps: bypassApps || [],
        created_at: user.created_at
      }
    });
  } catch (err) {
    next(err);
  }
});

// 5. Logout (Authenticated - adds token to Valkey revocation cache and revokes in DB)
router.post('/logout', authenticateToken, async (req, res, next) => {
  try {
    const token = req.token;
    const refreshToken = (req.cookies && req.cookies.refreshToken) || (req.body && req.body.refreshToken);

    if (token) {
      // 1. Blacklist access token in Valkey with 15m TTL
      await blacklistToken(token, 900);
    }

    // 2. Persist revocation in refresh_tokens table
    try {
      const pool = getPgPool();
      if (refreshToken) {
        const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        await pool.query(
          'UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE token_hash = $1 OR token_hash = $2',
          [hash, refreshToken]
        );
      } else if (req.user && req.user.id) {
        await pool.query(
          'UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE user_id = $1 AND revoked = FALSE',
          [req.user.id]
        );
      }
    } catch (e) {
      // Ignore if table unavailable
    }

    clearAuthCookies(res);

    logAuditEvent({
      eventType: 'AUTH_LOGOUT',
      severity: 'info',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: req.user.id,
      targetType: 'user',
      message: `User ${req.user.username} logged out`,
      ipAddress: req.ip
    });

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (err) {
    next(err);
  }
});

// WP-303: OIDC SSO Endpoints
router.get('/oidc/authorize', async (req, res, next) => {
  try {
    const { organization_id, redirect_uri } = req.query;
    if (!organization_id || !redirect_uri) {
      return res.status(400).json({ error: 'Missing organization_id or redirect_uri' });
    }
    const result = await OidcService.generateAuthorizationUrl(organization_id, redirect_uri);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/oidc/callback', loginLimiter, async (req, res, next) => {
  try {
    const { organization_id, code, state, redirect_uri } = req.body || {};
    if (!organization_id || !code || !state) {
      return res.status(400).json({ error: 'Missing required OIDC callback parameters' });
    }

    const { user, mappedRole } = await OidcService.exchangeCodeAndAuthenticate(
      organization_id,
      code,
      state,
      redirect_uri
    );

    const pool = getPgPool();
    const session = await issueUserSession(req, res, user, pool);

    logAuditEvent({
      eventType: 'AUTH_SSO_LOGIN_SUCCESS',
      severity: 'info',
      actorUserId: user.id,
      actorUsername: user.username,
      targetId: user.id,
      targetType: 'user',
      message: `User ${user.username} authenticated via OIDC SSO with mapped role ${mappedRole}`,
      ipAddress: req.ip
    });

    return res.status(200).json({
      ...session,
      mappedRole
    });
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
});

// Note: /setup-passwords is provided by the discrete deniability feature module (WP-107)
module.exports = router;
