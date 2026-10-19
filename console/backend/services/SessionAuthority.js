const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { getPgPool } = require('../db');
const { isTokenBlacklisted } = require('../db/valkey');

class SessionAuthorityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function accessTokenFromRequest(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  return header.startsWith('Bearer ') ? header.substring(7).trim() : req.cookies?.token || '';
}

async function resolveAccessToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    throw new SessionAuthorityError(401, 'Invalid or expired token');
  }
  const id = decoded.sub || decoded.id;
  if (decoded.type === 'mfa_pending') {
    throw new SessionAuthorityError(401, 'MFA verification required');
  }
  if (
    typeof id !== 'string' ||
    !id ||
    typeof decoded.sid !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.sid)
  ) {
    throw new SessionAuthorityError(401, 'Invalid or expired token');
  }
  if (await isTokenBlacklisted(token)) {
    throw new SessionAuthorityError(401, 'Token has been revoked');
  }

  try {
    const pool = getPgPool();
    const result = await pool.query(
      `SELECT u.id, u.username, u.role, u.status,
              COALESCE(u.organization_id, 'org-default') AS organization_id,
              m.role AS membership_role, s.expires_at AS session_expires_at,
              s.revoked_at AS session_revoked_at, s.expires_at<=clock_timestamp() AS session_expired,
              s.root_grant_id, s.root_organization_id,
              s.root_grant_expires_at>clock_timestamp() AS root_grant_fresh
         FROM users u JOIN console_sessions s ON s.user_id=u.id AND s.id=$2
         LEFT JOIN memberships m ON m.user_id=u.id
          AND m.organization_id=COALESCE(u.organization_id, 'org-default')
        WHERE u.id=$1`,
      [id, decoded.sid]
    );
    const actor = result.rows[0];
    if (!actor) throw new SessionAuthorityError(401, 'Account or session no longer exists');
    if (actor.session_revoked_at || actor.session_expired)
      throw new SessionAuthorityError(401, 'Session expired or revoked');
    if (actor.status !== 'active') throw new SessionAuthorityError(403, 'Active account required');

    // Retain explicit tombstones and older revocation entries across the upgrade;
    // neither family admission nor token termination depends on cache presence.
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const revocation = await pool.query(
      `SELECT token_hash FROM access_token_revocations WHERE token_hash=$1
       UNION ALL
       SELECT token_hash FROM refresh_tokens WHERE (token_hash=$1 OR token_hash=$2)
         AND (revoked=TRUE OR revoked_at IS NOT NULL) LIMIT 1`,
      [tokenHash, token]
    );
    if (revocation.rows.length) throw new SessionAuthorityError(401, 'Token has been revoked');

    // The root-password proof applies to the tenant where it was obtained. Moving
    // an account must not carry an old hidden-compartment grant into another one.
    const sameOrganization = (decoded.organization_id || 'org-default') === actor.organization_id;
    return {
      user: {
        id: actor.id,
        username: actor.username,
        role: actor.role,
        organization_id: actor.organization_id,
        org_role: actor.membership_role || (actor.role === 'super-admin' ? 'owner' : 'member'),
        compartment_access:
          sameOrganization &&
          decoded.compartment_access === 'root' &&
          decoded.root_grant_id &&
          decoded.root_grant_id === actor.root_grant_id &&
          actor.root_grant_fresh &&
          actor.root_organization_id === actor.organization_id
            ? 'root'
            : 'standard'
      },
      organizationIdAtIssue: decoded.organization_id || 'org-default',
      sessionId: decoded.sid,
      accessTokenExpiresAt: decoded.exp ? decoded.exp * 1000 : null,
      expiresAt: Math.min(decoded.exp ? decoded.exp * 1000 : Infinity, new Date(actor.session_expires_at).getTime())
    };
  } catch (error) {
    if (error instanceof SessionAuthorityError) throw error;
    throw new SessionAuthorityError(503, 'Session authority unavailable');
  }
}

// A module guard and its downstream router share one verified request decision.
// This is request-local, never a cache of principals across requests or sockets.
const requestDecisions = new WeakMap();
async function authenticateConsoleRequest(req) {
  const token = accessTokenFromRequest(req);
  if (!token) throw new SessionAuthorityError(401, 'Missing or malformed Authorization header');
  let decision = requestDecisions.get(req);
  if (!decision || decision.token !== token) {
    decision = { token, authority: resolveAccessToken(token) };
    requestDecisions.set(req, decision);
  }
  const authority = await decision.authority;
  req.user = authority.user;
  req.token = token;
  req.sessionAuthority = {
    organizationIdAtIssue: authority.organizationIdAtIssue,
    sessionId: authority.sessionId,
    expiresAt: authority.accessTokenExpiresAt
  };
  return authority;
}

module.exports = { resolveAccessToken, authenticateConsoleRequest, accessTokenFromRequest, SessionAuthorityError };
