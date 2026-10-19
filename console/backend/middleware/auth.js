const { signToken, signRefreshToken, verifyToken, verifyRefreshToken } = require('../services/ConsoleTokens');
const { authenticateConsoleRequest } = require('../services/SessionAuthority');

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
