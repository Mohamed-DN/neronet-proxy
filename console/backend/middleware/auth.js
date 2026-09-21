const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Pinning the algorithm keeps a token from choosing its own verification method.
// jsonwebtoken defends against the classic 'alg: none' forgery, but an unpinned
// verifier still accepts any algorithm the secret happens to satisfy.
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');
const { isTokenBlacklisted } = require('../db/valkey');
const { getPgPool } = require('../db/index');

function signToken(payload, expiresIn = config.JWT_EXPIRES_IN || '15m') {
  const cleanPayload = {
    sub: payload.id || payload.sub,
    id: payload.id || payload.sub,
    username: payload.username,
    role: payload.role,
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
  let token = '';
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  // 1. Fast O(1) Valkey revocation blacklist check
  const blacklisted = await isTokenBlacklisted(token);
  if (blacklisted) {
    return res.status(401).json({ error: 'Token has been revoked' });
  }

  // 2. Database revocation check (fallback / persistent)
  try {
    const pool = getPgPool();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const checkRes = await pool.query(
      'SELECT id FROM refresh_tokens WHERE (token_hash = $1 OR token_hash = $2) AND (revoked = TRUE OR revoked_at IS NOT NULL)',
      [tokenHash, token]
    );
    if (checkRes.rows.length > 0) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
  } catch (e) {
    // Continue if DB check fails or table absent
  }

  // 3. Cryptographic JWT verification
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.type === 'mfa_pending') {
      return res.status(401).json({ error: 'MFA verification required' });
    }
    req.user = {
      id: decoded.sub || decoded.id,
      username: decoded.username,
      role: decoded.role
    };
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
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
