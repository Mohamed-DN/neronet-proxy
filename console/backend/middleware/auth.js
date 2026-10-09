const jwt = require('jsonwebtoken');

// Pinning the algorithm keeps a token from choosing its own verification method.
// jsonwebtoken defends against the classic 'alg: none' forgery, but an unpinned
// verifier still accepts any algorithm the secret happens to satisfy.
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');
const { authenticateConsoleRequest } = require('../services/SessionAuthority');

function signToken(payload, expiresIn = config.JWT_EXPIRES_IN || '15m') {
  const cleanPayload = {
    sub: payload.id || payload.sub,
    id: payload.id || payload.sub,
    username: payload.username,
    role: payload.role,
    organization_id: payload.organization_id,
    compartment_access: payload.compartment_access,
    jti: uuidv4()
  };
  return jwt.sign(cleanPayload, config.JWT_SECRET, { expiresIn });
}

function signRefreshToken(payload, expiresIn = config.REFRESH_EXPIRES_IN || '7d') {
  const cleanPayload = {
    sub: payload.id || payload.sub,
    id: payload.id || payload.sub,
    username: payload.username,
    role: payload.role,
    organization_id: payload.organization_id,
    compartment_access: payload.compartment_access,
    jti: uuidv4()
  };
  return jwt.sign(cleanPayload, config.REFRESH_SECRET, { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return null;
  }
}

function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, config.REFRESH_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return null;
  }
}

async function authenticateToken(req, res, next) {
  try {
    await authenticateConsoleRequest(req);
  } catch (err) {
    return res.status(err.status || 503).json({ error: err.status ? err.message : 'Session authority unavailable' });
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role permissions' });
    }
    next();
  };
}

function requireSelfOrAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const targetId = req.params.id || req.params.userId;
  if (req.user.role === 'super-admin' || req.user.id === targetId) {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden: cannot access another user resource' });
}

module.exports = {
  signToken,
  signRefreshToken,
  verifyToken,
  verifyRefreshToken,
  authenticateToken,
  requireRole,
  requireSelfOrAdmin
};
