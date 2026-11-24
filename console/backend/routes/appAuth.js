const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  appSigninStartLimiter,
  appSigninPollLimiter,
  appCodeAttemptLimiter,
  appRefreshLimiter
} = require('../middleware/rateLimit');
const App = require('../services/AppAuthService');
const logger = require('../utils/logger');

/**
 * Sign-in for the NeroNet app (ADR 0040 phase 0).
 *
 *   POST   /device/start      public, rate limited        the app asks for a code
 *   POST   /device/poll       public, rate limited        the app waits for approval
 *   POST   /token/refresh     public, rate limited        refresh token plus installation key
 *   POST   /device/lookup     console session             what is asking
 *   POST   /device/approve    console session + MFA       approve
 *   POST   /device/deny       console session             deny
 *   GET    /sessions          console session             own apps (?scope=organization: administrators)
 *   DELETE /sessions/:id      console session             revoke an app and cut its node
 *   GET    /app/me            app token, app:self
 *   DELETE /app/session       app token, app:self         the app signs itself out
 *   GET    /app/devices       app token, devices:read
 *
 * The /app routes are the only ones that read an app token. Console routes verify a
 * console JWT and reject an app token as malformed; nothing else needs to know it exists.
 */

function sendError(res, next, err) {
  if (err instanceof App.AppAuthError) {
    return res.status(err.status).json({ error: err.code, code: err.code, message: err.message });
  }
  logger.error(`[APP-AUTH] ${err.message}`);
  return next(err);
}

const router = express.Router();
const noStore = (res) => res.set('Cache-Control', 'no-store');
const ctx = (req) => ({ ip: req.ip });

router.post('/device/start', appSigninStartLimiter, async (req, res, next) => {
  try {
    noStore(res);
    return res.json(await App.startSignIn(req.body, ctx(req)));
  } catch (err) {
    return sendError(res, next, err);
  }
});

router.post('/device/poll', appSigninPollLimiter, async (req, res, next) => {
  try {
    noStore(res);
    return res.json(await App.pollSignIn(req.body, ctx(req)));
  } catch (err) {
    return sendError(res, next, err);
  }
});

router.post('/token/refresh', appRefreshLimiter, async (req, res, next) => {
  try {
    noStore(res);
    return res.json(await App.refreshTokens(req.body, ctx(req)));
  } catch (err) {
    return sendError(res, next, err);
  }
});

router.post('/device/lookup', authenticateToken, appCodeAttemptLimiter, async (req, res, next) => {
  try {
    return res.json(await App.lookupSignIn(req.user, req.body?.user_code));
  } catch (err) {
    return sendError(res, next, err);
  }
});

router.post('/device/approve', authenticateToken, appCodeAttemptLimiter, async (req, res, next) => {
  try {
    return res.json(await App.approveSignIn(req.user, req.body || {}, ctx(req)));
  } catch (err) {
    return sendError(res, next, err);
  }
});

router.post('/device/deny', authenticateToken, appCodeAttemptLimiter, async (req, res, next) => {
  try {
    return res.json(await App.denySignIn(req.user, req.body || {}, ctx(req)));
  } catch (err) {
    return sendError(res, next, err);
  }
});

router.get('/sessions', authenticateToken, async (req, res, next) => {
  try {
    return res.json(await App.listSessions(req.user, { organization: req.query.scope === 'organization' }));
  } catch (err) {
    return sendError(res, next, err);
  }
});

router.delete('/sessions/:id', authenticateToken, async (req, res, next) => {
  try {
    return res.json(await App.revokeSession(req.user, req.params.id, { ip: req.ip }));
  } catch (err) {
    return sendError(res, next, err);
  }
});

// ---- Routes an app token opens ----------------------------------------------------------

router.get('/app/me', App.authenticateApp('app:self'), (req, res) => {
  const s = req.appSession;
  res.json({
    user_id: s.userId,
    username: s.username,
    organization_id: s.organizationId,
    node_id: s.nodeId,
    platform: s.platform,
    device_name: s.deviceName,
    scopes: s.scopes,
    expires_at: s.expiresAt
  });
});

router.delete('/app/session', App.authenticateApp('app:self'), async (req, res, next) => {
  try {
    const s = req.appSession;
    return res.json(
      await App.revokeSession({ id: s.userId, username: s.username, role: 'user' }, s.id, {
        reason: 'app_signout',
        ip: req.ip,
        bySelfApp: true
      })
    );
  } catch (err) {
    return sendError(res, next, err);
  }
});

router.get('/app/devices', App.authenticateApp('devices:read'), async (req, res, next) => {
  try {
    return res.json(await App.ownDevices(req.appSession));
  } catch (err) {
    return sendError(res, next, err);
  }
});

module.exports = router;
