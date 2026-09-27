/**
 * Node Credential Middleware for /v4/control/* routes.
 *
 * Implements ADR 0017 (Node Identity v2):
 * - Authenticates requests via Authorization: Bearer <nnt1_token>
 * - Rejects expired, revoked, or non-existent credentials with 401 Unauthorized
 * - Validates node_id invariance: callers cannot send requests on behalf of other nodes (403 Forbidden)
 * - Attaches req.node to the express request object
 */

const crypto = require('crypto');
const { validateCredential } = require('../services/NodeCredentialService');
const config = require('../config/env');
const logger = require('../utils/logger');

function requireNodeCredential(req, res, next) {
  const authHeader = String(req.get('authorization') || '').trim();
  let bearerToken = '';

  if (authHeader.toLowerCase().startsWith('bearer ')) {
    bearerToken = authHeader.slice(7).trim();
  }

  // Fallback check for body token if header absent
  if (!bearerToken && req.body && req.body.credential) {
    bearerToken = String(req.body.credential).trim();
  }

  if (!bearerToken) {
    return res.status(401).json({ error: 'node credential required (Authorization: Bearer <token>)' });
  }

  validateCredential(bearerToken)
    .then((result) => {
      if (!result.ok) {
        return res.status(result.status || 401).json({ error: result.error });
      }

      const authenticatedNodeId = result.node.id;

      // Invariance Check: if node_id is provided in body, params, or query,
      // it MUST strictly match the authenticated node identity.
      const bodyNodeId = req.body && req.body.node_id ? String(req.body.node_id).trim() : null;
      const paramNodeId = req.params && req.params.node_id ? String(req.params.node_id).trim() : null;
      const queryNodeId = req.query && req.query.node_id ? String(req.query.node_id).trim() : null;

      const declaredNodeId = bodyNodeId || paramNodeId || queryNodeId;

      if (declaredNodeId && declaredNodeId !== authenticatedNodeId) {
        logger.warn(
          `Node identity spoofing attempted: credential for ${authenticatedNodeId} attempted to act as ${declaredNodeId}`
        );
        return res.status(403).json({ error: 'forbidden: credential belongs to another node' });
      }

      req.node = result.node;
      return next();
    })
    .catch((err) => {
      logger.error(`Node auth middleware failure: ${err.message}`);
      return res.status(500).json({ error: 'internal authentication error' });
    });
}

function bearerOf(req) {
  const header = String(req.get('authorization') || '').trim();
  let bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!bearer && req.body && req.body.credential) {
    bearer = String(req.body.credential).trim();
  }
  if (!bearer && req.body && req.body.auth_token) {
    bearer = String(req.body.auth_token).trim();
  }
  return bearer;
}

function matchesFleetToken(bearer, expected) {
  const a = Buffer.from(String(bearer), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Authenticates node requests on /v4/control/* endpoints.
 *
 * Implements ADR 0017 (Node Identity v2):
 * - Accepts 256-bit bearer node credentials (nnt1_<hex>)
 * - Enforces node ID invariance: request body node_id must match authenticated identity (403 Forbidden)
 * - Validates credential revocation and expiration (401 Unauthorized)
 *
 * The fleet-wide enrolment token identifies no node, so it is not a node credential:
 * accepted as one, it let any holder read any node's netmap and forge any node's
 * heartbeat. It is accepted only where `allowFleetToken` says so -- the fleet
 * inventory, which is not about one node. With no token configured outside
 * production, requests pass unauthenticated, as the development default always has.
 */
async function checkNodeAuth(req, { allowFleetToken = false } = {}) {
  const bearer = bearerOf(req);

  // 1. Node Credential (nnt1_...)
  if (bearer && bearer.startsWith('nnt1_')) {
    const credResult = await validateCredential(bearer);
    if (!credResult.ok) {
      return { ok: false, status: credResult.status || 401, error: credResult.error || 'invalid node credential' };
    }

    const node = credResult.node;
    const bodyNodeId = req.body && req.body.node_id ? String(req.body.node_id).trim() : null;
    const queryNodeId = req.query && req.query.node_id ? String(req.query.node_id).trim() : null;
    const declaredNodeId = bodyNodeId || queryNodeId;

    if (declaredNodeId && declaredNodeId !== node.id) {
      logger.warn(`Node identity spoofing attempted: credential for ${node.id} attempted to act as ${declaredNodeId}`);
      return { ok: false, status: 403, error: 'forbidden: credential belongs to another node' };
    }

    req.node = node;
    return { ok: true, node, token: bearer };
  }

  const expected = process.env.SOVEREIGN_REGISTRATION_TOKEN;
  if (!expected) {
    if (config.IS_PRODUCTION) {
      return { ok: false, status: 401, error: 'node credential required (Authorization: Bearer <token>)' };
    }
    logger.warn('SOVEREIGN_REGISTRATION_TOKEN is not set - node control request permitted in dev.');
    return { ok: true, legacy: true };
  }

  if (!bearer) {
    return { ok: false, status: 401, error: 'node credential required' };
  }
  if (!allowFleetToken || !matchesFleetToken(bearer, expected)) {
    return { ok: false, status: 401, error: 'node credential required' };
  }
  return { ok: true, legacy: true };
}

/**
 * Whether the caller may enrol a key the control plane does not know yet with the
 * fleet token. Only enrolment: the token says the caller may add nodes, not which
 * node it is. Possession of the key is proved separately.
 */
function checkEnrolmentToken(req) {
  const expected = process.env.SOVEREIGN_REGISTRATION_TOKEN;
  if (!expected) {
    if (config.IS_PRODUCTION) {
      return { ok: false, status: 401, error: 'a pre-auth key or the enrolment token is required' };
    }
    logger.warn('SOVEREIGN_REGISTRATION_TOKEN is not set - enrolment permitted in dev.');
    return { ok: true };
  }
  const bearer = bearerOf(req);
  if (!bearer || !matchesFleetToken(bearer, expected)) {
    return { ok: false, status: 401, error: 'a pre-auth key or the enrolment token is required' };
  }
  return { ok: true };
}

module.exports = {
  requireNodeCredential,
  checkNodeAuth,
  checkEnrolmentToken
};
