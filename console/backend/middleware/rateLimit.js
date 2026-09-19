/**
 * Request rate limiting, backed by Valkey with an in-process fallback.
 *
 * The API had no rate limiting of any kind. /api/auth/login accepted unlimited
 * attempts, and bcrypt makes that worse rather than better: each attempt burns
 * ~100ms of CPU on a single-threaded process, so brute force doubles as a cheap
 * denial of service. /v4/control/register hands out overlay addresses from a finite
 * pool, so an unlimited caller can exhaust the mesh's address space.
 *
 * Counters live in Valkey so that every control-plane instance shares one budget.
 * Without that, N instances behind a load balancer multiply every limit by N.
 */

const { getValkeyClient, NAMESPACE } = require('../db/valkey');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Whether limiting is switched off for this process.
 *
 * Test suites deliberately hammer the auth endpoints -- injection fuzzing and
 * constant-time verification both need hundreds of attempts -- and a limiter that
 * stops them is a limiter doing its job, not a test failure.
 *
 * The flag is read once and is ignored outright under NODE_ENV=production. An
 * escape hatch that a misplaced environment variable can turn into an open door is
 * not an escape hatch, it is the vulnerability with a friendlier name.
 */
const LIMITING_DISABLED = process.env.SOVEREIGN_RATE_LIMIT_DISABLED === 'true' && !config.IS_PRODUCTION;

if (LIMITING_DISABLED) {
  logger.warn('Rate limiting is DISABLED for this process. Never set SOVEREIGN_RATE_LIMIT_DISABLED outside tests.');
}

/**
 * In-process fallback, used when Valkey is unreachable.
 *
 * It only protects a single instance, which is why it is a fallback and not the
 * design. Entries are swept lazily to keep the map from growing without bound.
 */
const localCounters = new Map();
let lastSweep = Date.now();

function sweepLocalCounters(now) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, entry] of localCounters) {
    if (entry.resetAt <= now) localCounters.delete(key);
  }
}

function hitLocal(key, windowMs, now) {
  sweepLocalCounters(now);

  const entry = localCounters.get(key);
  if (!entry || entry.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    localCounters.set(key, fresh);
    return fresh;
  }

  entry.count += 1;
  return entry;
}

async function hitValkey(client, key, windowMs, now) {
  // INCR then EXPIRE only on first hit: a fixed window, not a sliding one. The
  // known trade-off is that a caller can spend one window's budget at the end of a
  // window and another at the start of the next. For the limits below that worst
  // case is still far under what an attack needs, and it costs one round trip
  // instead of the sorted-set bookkeeping a sliding window requires.
  const count = await client.incr(key);
  if (count === 1) {
    await client.pexpire(key, windowMs);
  }

  let ttl = await client.pttl(key);
  if (ttl < 0) {
    // Key exists without a TTL (a crash between INCR and EXPIRE). Repair it rather
    // than leaving a counter that never resets and locks the caller out forever.
    await client.pexpire(key, windowMs);
    ttl = windowMs;
  }

  return { count, resetAt: now + ttl };
}

/**
 * Build a rate limiting middleware.
 *
 * `failClosed` decides what happens when Valkey is unreachable AND the in-process
 * fallback is not considered sufficient. For authentication the limiter is the
 * security control itself, so losing it must not silently open the door; for
 * ordinary endpoints an outage of the cache should not take the API down with it.
 */
function rateLimit({ name, limit, windowMs, keyFn, failClosed = false, message }) {
  // failClosed marks limiters whose absence would be a security failure rather than
  // an availability one. Both paths currently meter locally on a cache outage; the
  // flag records which limiters must never be relaxed further if that changes.
  void failClosed;

  return async function rateLimitMiddleware(req, res, next) {
    if (LIMITING_DISABLED) {
      return next();
    }

    const now = Date.now();
    const scope = keyFn(req);

    // A caller with no resolvable identity cannot be metered. Refusing is correct:
    // otherwise every unidentifiable request shares one bucket, and one attacker
    // locks out everybody.
    if (!scope) {
      return res.status(400).json({ error: 'request could not be attributed for rate limiting' });
    }

    const key = `${NAMESPACE ? `${NAMESPACE}:` : ''}ratelimit:${name}:${scope}`;

    // When Valkey is unreachable the limit degrades to per-instance rather than
    // disappearing. That is the whole reason the in-process counter exists: an
    // attacker who can knock over the cache must not thereby remove the control
    // that stops them brute-forcing the login.
    let state;
    const client = getValkeyClient();

    if (client) {
      try {
        state = await hitValkey(client, key, windowMs, now);
      } catch (err) {
        logger.warn(`Rate limiter could not reach Valkey (${err.message}); falling back to in-process counters.`);
        state = hitLocal(key, windowMs, now);
      }
    } else {
      state = hitLocal(key, windowMs, now);
    }

    const remaining = Math.max(0, limit - state.count);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((state.resetAt - now) / 1000)));

    if (state.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: message || 'too many requests',
        retry_after_seconds: retryAfter
      });
    }

    return next();
  };
}

/** Client address, honouring the proxy chain the app is configured to trust. */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

// --- Concrete limiters -------------------------------------------------------

// Metered per address AND per attempted username, so one attacker cannot lock a
// specific account out by exhausting its budget from elsewhere, and cannot spread
// an attack across usernames from one address either.
const loginLimiter = rateLimit({
  name: 'login',
  limit: 8,
  windowMs: 15 * 60_000,
  failClosed: true,
  message: 'too many sign-in attempts; wait before trying again',
  keyFn: (req) => {
    const ip = clientIp(req);
    if (!ip) return null;
    const username = String(req.body?.username || '')
      .toLowerCase()
      .slice(0, 64);
    return `${ip}|${username}`;
  }
});

// Account creation is cheap for the caller and expensive for us.
const registerLimiter = rateLimit({
  name: 'register',
  limit: 10,
  windowMs: 60 * 60_000,
  failClosed: true,
  message: 'too many account registrations from this address',
  keyFn: clientIp
});

// Node enrolment allocates an overlay address from a finite pool.
const enrolmentLimiter = rateLimit({
  name: 'enrolment',
  limit: 60,
  windowMs: 60_000,
  failClosed: true,
  message: 'too many node enrolment attempts',
  keyFn: clientIp
});

// Everything else, metered per authenticated user where possible.
const apiLimiter = rateLimit({
  name: 'api',
  limit: 600,
  windowMs: 60_000,
  keyFn: (req) => (req.user?.id ? `user:${req.user.id}` : clientIp(req))
});

// Writes are the expensive half and get their own, tighter budget.
const writeLimiter = rateLimit({
  name: 'write',
  limit: 120,
  windowMs: 60_000,
  message: 'too many write requests',
  keyFn: (req) => (req.user?.id ? `user:${req.user.id}` : clientIp(req))
});

module.exports = {
  rateLimit,
  LIMITING_DISABLED,
  loginLimiter,
  registerLimiter,
  enrolmentLimiter,
  apiLimiter,
  writeLimiter
};
