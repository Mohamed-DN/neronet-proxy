const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');

function claims(payload) {
  return {
    sub: payload.id || payload.sub,
    id: payload.id || payload.sub,
    username: payload.username,
    role: payload.role,
    organization_id: payload.organization_id,
    compartment_access: payload.compartment_access,
    sid: payload.sid,
    root_grant_id: payload.root_grant_id,
    jti: uuidv4()
  };
}

function signToken(payload, expiresIn = config.JWT_EXPIRES_IN || '15m') {
  return jwt.sign(claims(payload), config.JWT_SECRET, { expiresIn });
}

function signRefreshToken(payload, expiresIn = config.REFRESH_EXPIRES_IN || '7d') {
  return jwt.sign(claims(payload), config.REFRESH_SECRET, { expiresIn });
}

function signRefreshTokenUntil(payload, expiresAt) {
  return jwt.sign({ ...claims(payload), exp: Math.floor(new Date(expiresAt).getTime() / 1000) }, config.REFRESH_SECRET);
}

function verify(token, secret) {
  try {
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

module.exports = {
  signToken,
  signRefreshToken,
  signRefreshTokenUntil,
  verifyToken: (token) => verify(token, config.JWT_SECRET),
  verifyRefreshToken: (token) => verify(token, config.REFRESH_SECRET)
};
