const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const { loginLimiter, registerLimiter } = require('../middleware/rateLimit');
const router = express.Router();
const { getPgPool } = require('../db/index');
const { authenticateToken, verifyRefreshToken } = require('../middleware/auth');
const { blacklistToken, isTokenBlacklisted } = require('../db/valkey');
const { logAuditEvent } = require('../utils/audit');
const { setAuthCookies, clearAuthCookies } = require('../utils/cookies');
const OidcService = require('../services/OidcService');
const DuressService = require('../services/DuressService');
const { revokeAccessTokenAndRefresh } = require('../services/AccessTokenRevocation');
const logger = require('../utils/logger');
const ConsoleSessionService = require('../services/ConsoleSessionService');
const MfaSessionService = require('../services/MfaSessionService');

// Pre-computed constant-time dummy bcrypt hash to prevent timing side-channel attacks on non-existent usernames
const DUMMY_BCRYPT_HASH = '$2a$10$wN3t8gX1ZkGkR0e2M8t0y.9gZ0n4p7s2e6u1v8w5x9y2z3a4b5c6d';

/**
 * Issue new session (access token + refresh token) and store in database
 */
async function issueUserSession(req, res, user) {
  const session = await ConsoleSessionService.issueSession({ user, ipAddress: req.ip });
  setAuthCookies(req, res, session);
  return { token: session.token, user: session.user };
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

    const registration = await pool.query(
      `
      INSERT INTO users (
        id, username, email, password_hash, role, status, bypass_apps
      ) VALUES (
        $1, $2, $3, $4, $5, 'active', '[]'::jsonb
      ) RETURNING *
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

    const created = registration.rows[0];
    const session = await MfaSessionService.signIn({
      verifiedUser: created,
      passwordColumn: 'password_hash',
      accessTier: 'standard',
      ipAddress: req.ip
    });
    if (session.mfa_required) return res.status(201).json(session);
    setAuthCookies(req, res, session);

    return res.status(201).json({ token: session.token, user: session.user });
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
    let passwordColumn;
    let accessTier = 'standard'; // 'standard', 'root', 'stealth_wipe', 'nuclear_wipe'

    try {
      if (user.password_hash && (await bcrypt.compare(password, user.password_hash))) {
        isMatch = true;
        passwordColumn = 'password_hash';
        accessTier = 'standard';
      } else if (user.password_hash_root && (await bcrypt.compare(password, user.password_hash_root))) {
        isMatch = true;
        passwordColumn = 'password_hash_root';
        accessTier = 'root';
      } else if (user.password_hash_stealth_wipe && (await bcrypt.compare(password, user.password_hash_stealth_wipe))) {
        isMatch = true;
        passwordColumn = 'password_hash_stealth_wipe';
        accessTier = 'stealth_wipe';
      } else if (user.password_hash_nuclear_wipe && (await bcrypt.compare(password, user.password_hash_nuclear_wipe))) {
        isMatch = true;
        passwordColumn = 'password_hash_nuclear_wipe';
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

    const session = await MfaSessionService.signIn({
      verifiedUser: user,
      passwordColumn,
      accessTier,
      providedOtp: totp_code || code,
      ipAddress: req.ip
    });
    if (session.mfa_required) return res.status(200).json(session);
    setAuthCookies(req, res, session);

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

    return res.status(200).json({ token: session.token, user: session.user });
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

  return MfaSessionService.resolveCaller(token);
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
    const { user } = caller;
    const setup = await MfaSessionService.setup(caller, req.body && req.body.current_code);

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

    return res.status(200).json(setup);
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
    const { user } = caller;
    const { session, confirmingPending } = await MfaSessionService.complete(caller, { ...req.body, ipAddress: req.ip });
    setAuthCookies(req, res, session);

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

    return res.status(200).json({ token: session.token, user: session.user });
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

    const userId = decoded.sub || decoded.id;
    if (!ConsoleSessionService.validSessionId(decoded.sid) || typeof userId !== 'string') {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Fresh sign-in required' });
    }
    // Network I/O must finish before acquiring the account/family SQL locks.
    const idpStatus = await OidcService.verifyUserActiveOnIdP(userId);
    if (!idpStatus.active) {
      clearAuthCookies(res);
      return res.status(401).json({ error: idpStatus.reason || 'Account deactivated on identity provider' });
    }
    const session = await ConsoleSessionService.rotateSession({ decoded, refreshToken: token, ipAddress: req.ip });
    if (session.replay) {
      logAuditEvent({
        eventType: 'AUTH_REFRESH_REPLAY_DETECTED',
        severity: 'critical',
        actorUserId: session.userId,
        targetId: session.userId,
        targetType: 'user',
        message: 'Refresh replay detected; the affected session family was revoked.',
        ipAddress: req.ip
      });
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Revoked refresh token presented: entire session chain terminated' });
    }
    setAuthCookies(req, res, session);
    return res.status(200).json({ token: session.token, user: session.user });
  } catch (err) {
    next(err);
  }
});

// 4. Get Current User (Authenticated)
router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const userRes = await pool.query(
      'SELECT id, username, email, role, status, organization_id, totp_enabled, bypass_apps, created_at FROM users WHERE id = $1',
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

// 5. Logout: commit durable access and refresh revocations before acknowledging.
router.post('/logout', authenticateToken, async (req, res, next) => {
  try {
    const token = req.token;
    const refreshToken = (req.cookies && req.cookies.refreshToken) || (req.body && req.body.refreshToken);

    await revokeAccessTokenAndRefresh({
      token,
      userId: req.user.id,
      sessionId: req.sessionAuthority.sessionId,
      refreshToken,
      expiresAt: req.sessionAuthority.expiresAt
    });
    // A cache entry may reject sooner; its absence can never grant access.
    const ttl = req.sessionAuthority.expiresAt
      ? Math.max(1, Math.ceil((req.sessionAuthority.expiresAt - Date.now()) / 1000))
      : 900;
    await blacklistToken(token, ttl);

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
