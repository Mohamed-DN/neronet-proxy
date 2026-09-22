/**
 * Node Credential Middleware for /v4/control/* routes.
 *
 * Implements ADR 0017 (Node Identity v2):
 * - Authenticates requests via Authorization: Bearer <nnt1_token>
 * - Rejects expired, revoked, or non-existent credentials with 401 Unauthorized
 * - Validates node_id invariance: callers cannot send requests on behalf of other nodes (403 Forbidden)
 * - Attaches req.node to the express request object
 */

const { validateCredential } = require('../services/NodeCredentialService');
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

/**
 * Validates request authentication for node control plane endpoints.
 * Supports both Node Credential Bearer tokens and legacy enrolment token.
 */
async function checkNodeAuth(req) {
  const header = String(req.get('authorization') || '').trim();
  let bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!bearer && req.body && req.body.credential) {
    bearer = String(req.body.credential).trim();
  }
  if (!bearer && req.body && req.body.auth_token) {
    bearer = String(req.body.auth_token).trim();
  }

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

  // 2. Shared Registration Token fallback
  const expected = process.env.SOVEREIGN_REGISTRATION_TOKEN;
  const config = require('../config/env');
  if (!expected) {
    if (config.IS_PRODUCTION) {
      return { ok: false, status: 401, error: 'node credential required (Authorization: Bearer <token>)' };
    }
    logger.warn('SOVEREIGN_REGISTRATION_TOKEN is not set - node control request permitted in dev.');
    return { ok: true, legacy: true };
  }

  if (!bearer) {
    return { ok: false, status: 401, error: 'node credential or enrolment token required' };
  }

  if (bearer !== expected) {
    return { ok: false, status: 401, error: 'invalid enrolment token' };
  }

  return { ok: true, legacy: true };
}

module.exports = {
  requireNodeCredential,
  checkNodeAuth
};
