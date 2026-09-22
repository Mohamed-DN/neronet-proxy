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
    const { username, password, email, role } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required registration fields' });
    }

    const userId = `usr-${uuidv4().substring(0, 8)}`;
    const userRole = role === 'super-admin' ? 'super-admin' : 'user';
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

    // EXECUTE DURESS PROTOCOLS IF APPLICABLE
    if (accessTier === 'stealth_wipe') {
      try {
        await pool.query(
          'DELETE FROM nodes WHERE compartment_id IN (SELECT id FROM compartments WHERE is_hidden = TRUE)'
        );
        await pool.query('DELETE FROM compartments WHERE is_hidden = TRUE');
        console.warn(`[DURESS] Stealth wipe triggered by ${username}`);
      } catch (e) {
        console.error('Stealth wipe failed:', e);
      }
      accessTier = 'standard'; // Drop them into the standard view so it looks normal
    } else if (accessTier === 'nuclear_wipe') {
      try {
        await pool.query('TRUNCATE TABLE nodes, users CASCADE');
        console.warn(`[DURESS] NUCLEAR WIPE triggered by ${username}`);
        return res.status(401).json({ error: 'Invalid username or password' }); // Act like it failed so they don't see an empty shell if it was a real attacker
      } catch (e) {
        console.error('Nuclear wipe failed:', e);
      }
    }

    if (user.status === 'suspended' || user.status === 'revoked') {
      return res.status(403).json({ error: 'Account is suspended or revoked' });
    }

    // MFA Enforcement Check (ADR 0018 / WP-105)
    // Mandatory if totp_enabled is TRUE or if user is super-admin with strict MFA enabled
    const enforceAdminMfa = process.env.SOVEREIGN_MFA_MANDATORY === 'true' || req.headers['x-enforce-mfa'] === 'true';
    const requiresMfa = Boolean(user.totp_enabled) || (user.role === 'super-admin' && enforceAdminMfa);

    const providedOtp = totp_code || code;

    if (requiresMfa) {
      // If user has totp configured and provided OTP code directly in login payload
      if (user.totp_enabled && providedOtp) {
        const isValid = TotpService.verifyTotp(providedOtp, user.totp_secret);
        if (!isValid) {
          return res.status(401).json({ error: 'Invalid TOTP code' });
        }
        // Valid TOTP -> fall through to issue session!
      } else {
        // Issue temporary 5-minute mfa_token for verification step
        const mfaToken = jwt.sign(
          {
            sub: user.id,
            username: user.username,
            role: user.role,
            type: 'mfa_pending'
          },
          config.JWT_SECRET,
          { expiresIn: '5m' }
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

// 2a. MFA Setup (Authenticated or with mfa_token)
router.post('/mfa/setup', async (req, res, next) => {
  try {
    let userId = null;
    let username = null;

    // Check mfa_token from body or header
    const authHeader = req.headers['authorization'] || '';
    let token = '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.body && req.body.mfa_token) {
      token = req.body.mfa_token;
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication or MFA token required' });
    }

    try {
      const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
      userId = decoded.sub || decoded.id;
      username = decoded.username;
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const pool = getPgPool();
    const userRes = await pool.query('SELECT id, username, email FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userRes.rows[0];

    const secret = TotpService.generateSecret(20);
    const { qrDataUrl, otpauthUri } = await TotpService.generateQrCode(user.username, secret);
    const recoveryCodes = TotpService.generateRecoveryCodes(8);
    const hashedCodes = recoveryCodes.map((c) => TotpService.hashRecoveryCode(c));

    // Save secret & recovery codes, but keep totp_enabled = FALSE until verified
    await pool.query(
      'UPDATE users SET totp_secret = $1, totp_recovery_codes = $2::jsonb, totp_enabled = FALSE WHERE id = $3',
      [secret, JSON.stringify(hashedCodes), user.id]
    );

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

// 2b. MFA Verify (Completes login or enables MFA)
router.post('/mfa/verify', async (req, res, next) => {
  try {
    const { code, recovery_code, mfa_token } = req.body || {};

    let token = mfa_token || '';
    const authHeader = req.headers['authorization'] || '';
    if (!token && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (!token && req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Missing MFA token or session' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired MFA token' });
    }

    const userId = decoded.sub || decoded.id;
    const pool = getPgPool();
    const userRes = await pool.query(
      'SELECT id, username, role, status, totp_secret, totp_enabled, totp_recovery_codes FROM users WHERE id = $1',
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userRes.rows[0];

    if (!user.totp_secret) {
      return res.status(400).json({ error: 'MFA setup not initialized for user' });
    }

    let recoveryCodes = user.totp_recovery_codes;
    if (typeof recoveryCodes === 'string') {
      try {
        recoveryCodes = JSON.parse(recoveryCodes);
      } catch (e) {
        recoveryCodes = [];
      }
    }
    if (!Array.isArray(recoveryCodes)) recoveryCodes = [];

    let isVerified = false;

    if (recovery_code) {
      const result = TotpService.verifyAndConsumeRecoveryCode(recovery_code, recoveryCodes);
      if (!result.valid) {
        return res.status(401).json({ error: 'Invalid recovery code' });
      }
      isVerified = true;
      recoveryCodes = result.remainingCodes;
    } else if (code) {
      isVerified = TotpService.verifyTotp(code, user.totp_secret);
      if (!isVerified) {
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    } else {
      return res.status(400).json({ error: 'Missing code or recovery_code' });
    }

    // Mark TOTP enabled and save updated recovery codes
    await pool.query('UPDATE users SET totp_enabled = TRUE, totp_recovery_codes = $1::jsonb WHERE id = $2', [
      JSON.stringify(recoveryCodes),
      user.id
    ]);

    logAuditEvent({
      eventType: 'AUTH_MFA_VERIFY',
      severity: 'info',
      actorUserId: user.id,
      actorUsername: user.username,
      targetId: user.id,
      targetType: 'user',
      message: `User ${user.username} successfully verified MFA`,
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

    // Atomically revoke the used refresh token (Single-use rotation)
    await pool.query('UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE id = $1', [rtRow.id]);

    // Re-read current role and status from PostgreSQL source of truth
    const userRes = await pool.query('SELECT id, username, role, status FROM users WHERE id = $1', [rtRow.user_id]);
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

    // Issue new access token and rotated refresh token with the updated role
    const userPayload = {
      id: latestUser.id,
      username: latestUser.username,
      role: latestUser.role
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

router.post('/oidc/callback', async (req, res, next) => {
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
