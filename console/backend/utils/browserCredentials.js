/**
 * Browser-v2 credential cookies (see services/BrowserContextService.js).
 * Credentials live only in HttpOnly cookies named for their issuance; JavaScript
 * receives the non-secret issuance selector, never a token.
 */
const jwt = require('jsonwebtoken');
const Browser = require('../services/BrowserContextService');
const { SessionAuthorityError } = require('../services/SessionAuthority');
const { isCookieSecure } = require('./cookies');

function cookieOptions(req, path, expiresAtSeconds) {
  return {
    httpOnly: true,
    sameSite: 'Strict',
    secure: isCookieSecure(req),
    path,
    maxAge: Math.max(0, expiresAtSeconds * 1000 - Date.now())
  };
}

function setBrowserCookies(req, res, session) {
  const id = session.browser.issuance_id;
  // Path=/ so the topology WebSocket upgrade (/ws/topology) carries it too.
  res.cookie(Browser.accessCookieName(id), session.token, cookieOptions(req, '/', jwt.decode(session.token).exp));
  res.cookie(
    Browser.refreshCookieName(id),
    session.refreshToken,
    cookieOptions(req, '/api/auth/refresh', jwt.decode(session.refreshToken).exp)
  );
}

function clearBrowserCookies(req, res, issuanceId) {
  const base = { httpOnly: true, sameSite: 'Strict', secure: isCookieSecure(req) };
  res.clearCookie(Browser.accessCookieName(issuanceId), { ...base, path: '/' });
  res.clearCookie(Browser.refreshCookieName(issuanceId), { ...base, path: '/api/auth/refresh' });
}

/** Proof and operation of a credential-producing v2 request; null for legacy clients. */
function browserOperation(req) {
  if (!Browser.browserProtocol(req)) return null;
  return { proof: Browser.proofFromRequest(req), operationId: req.body?.operation_id };
}

/**
 * Hooks for rotating the selected v2 session (vault unlock/lock). Null for legacy
 * clients. The admitted operation must expect exactly the authenticated issuance.
 */
function browserRotation(req, kinds) {
  if (!req.browserIssuance) return null;
  const issuance = req.browserIssuance;
  return {
    admit: async (client) => {
      const admitted = await Browser.admitOperation(client, req.browserProof, req.body?.operation_id, kinds);
      if (admitted.context.selected_issuance_id !== issuance.id)
        throw new SessionAuthorityError(409, 'Browser selection changed');
      return admitted;
    },
    record: (client, admitted, session) => Browser.recordIssuance(client, admitted, session, { select: true })
  };
}

/** Writes the rotated successor's cookies and clears the predecessor's. */
function applyBrowserRotation(req, res, session) {
  setBrowserCookies(req, res, session);
  clearBrowserCookies(req, res, req.browserIssuance.id);
}

module.exports = { setBrowserCookies, clearBrowserCookies, browserOperation, browserRotation, applyBrowserRotation };
