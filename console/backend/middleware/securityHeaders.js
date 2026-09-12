const config = require('../config/env');

/**
 * Response security headers.
 *
 * The API and the console shipped with none: no CSP, no HSTS, no frame-ancestors.
 * For an ordinary dashboard that is careless; for this one it is worse. The console
 * arms a dead man's switch and triggers NeroNuke, so a page that can be framed by a
 * hostile site is a page where a stolen click can schedule a wipe. The absence of a
 * CSP also means an XSS anywhere in the console has no second line of defence.
 *
 * Written out rather than pulled from a package: it is thirty lines, every value
 * here is a deliberate decision about this application, and a dependency that
 * silently changes a default is exactly what a security header set should not have.
 */
function securityHeaders(req, res, next) {
  // Nothing here is a document that benefits from sniffing.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // No referrer leaks to third parties; same-origin navigation keeps the path.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // The console needs none of these, and an unused permission is a permission an
  // injected script can use.
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()'
  );

  // frame-ancestors 'none' is the clickjacking control that matters; X-Frame-Options
  // is kept for clients that predate CSP level 2.
  res.setHeader('X-Frame-Options', 'DENY');

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      // The SPA build inlines its style runtime; scripts stay bundle-only.
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // Same-origin API plus the topology WebSocket.
      "connect-src 'self' ws: wss:",
      "worker-src 'self' blob:",
      'upgrade-insecure-requests'
    ].join('; ')
  );

  // Only meaningful over TLS, and actively harmful to set on a plain-HTTP
  // development origin, where it would pin localhost to HTTPS in the browser.
  if (config.IS_PRODUCTION) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  // The version of the server is not information a client needs.
  res.removeHeader('X-Powered-By');

  return next();
}

module.exports = securityHeaders;
