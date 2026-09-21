/**
 * Cookie handling utilities for Console Session Hardening (ADR 0018 / WP-105)
 */

function isCookieSecure(req) {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  if (process.env.NODE_ENV === 'production') return true;
  return Boolean(req && (req.secure || req.headers['x-forwarded-proto'] === 'https'));
}

function parseCookies(req) {
  const cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach((part) => {
      const [name, ...rest] = part.trim().split('=');
      if (name) {
        cookies[name] = decodeURIComponent(rest.join('='));
      }
    });
  }
  return cookies;
}

function cookieParser(req, res, next) {
  req.cookies = parseCookies(req);
  next();
}

function setAuthCookies(req, res, { token, refreshToken }) {
  const secure = isCookieSecure(req);

  if (token) {
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/api',
      secure,
      maxAge: 15 * 60 * 1000 // 15 minutes
    });
  }

  if (refreshToken) {
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/api/auth/refresh',
      secure,
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
  }
}

function clearAuthCookies(res) {
  res.clearCookie('token', {
    path: '/api',
    httpOnly: true,
    sameSite: 'Strict'
  });
  res.clearCookie('refreshToken', {
    path: '/api/auth/refresh',
    httpOnly: true,
    sameSite: 'Strict'
  });
}

module.exports = {
  isCookieSecure,
  parseCookies,
  cookieParser,
  setAuthCookies,
  clearAuthCookies
};
