/**
 * Sign-in for the NeroNet app by device code, app tokens, and the one-node enrolment grant
 * (ADR 0040 phase 0, ADR 0035 phase B).
 *
 * The flow, in the order it happens:
 *   start    the app sends its platform, a device name and its installation public key and
 *            gets a secret device code (for polling) and a short user code (for the person).
 *   lookup   the person, signed in to the console, types the code and sees what is asking.
 *   approve  with a fresh second factor when the account has one or must have one.
 *   poll     the app asks until approved; the poll that finds it approved is the one that
 *            mints the tokens and the grant, so nothing but hashes is ever stored.
 *
 * An app token is an opaque secret, not a console JWT. No console route reads it, so it
 * cannot reach admin, NeroNuke or anything else by accident: the only code that accepts it
 * is authenticateApp below, and each route names the scope it needs. The grant is an
 * ordinary single-use pre-auth key, bound to the one installation key it was issued for.
 */

const crypto = require('crypto');
const { getPgPool } = require('../db/index');
const PreAuthKeyService = require('./PreAuthKeyService');
const EnrollmentService = require('./EnrollmentService');
const RevocationEngine = require('./RevocationEngine');
const MfaSessionService = require('./MfaSessionService');
const { logAuditEvent } = require('../utils/audit');
const { isAdministrator } = require('../utils/quarantine');
const { AUTO_QUARANTINE_REASON } = require('../utils/quarantine');
const logger = require('../utils/logger');

const PLATFORMS = ['windows', 'macos', 'linux', 'android', 'ios'];
const ALLOWED_SCOPES = ['app:self', 'devices:read', 'exit:select', 'drop:use'];
const DEFAULT_SCOPES = ['app:self', 'devices:read'];
const CODE_TTL_SECONDS = 600;
const DEFAULT_INTERVAL = 5;
const MAX_INTERVAL = 30;
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_SECONDS = 30 * 86400;
const GRANT_TTL_HOURS = 1;
const VERIFICATION_PATH = '/collega';
// Crockford base32: no I, L, O or U, so a code read aloud or off a screen is not ambiguous.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

class AppAuthError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// Poll and refresh run every few seconds per app: they take row locks, not the fleet-wide
// enrolment lock that approve shares with registration.
async function withTransaction(work) {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const sameHash = (a, b) => {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const orgOf = (user) => user.organization_id || 'org-default';
const deriveNodeId = (publicKeyHex) => `pk_${publicKeyHex.slice(0, 16).toLowerCase()}`;

function newUserCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Canonical form of a typed code, or null when it cannot be one. Crockford reads O as 0, I and L as 1. */
function normaliseUserCode(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const code = raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return new RegExp(`^[${CODE_ALPHABET}]{8}$`).test(code) ? code : null;
}

const displayCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

// ---------------------------------------------------------------------------------------
// Input validation. Every field comes from a device the console has never seen.

function validateStart(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!PLATFORMS.includes(b.platform)) throw new AppAuthError(400, 'invalid_platform', 'Unknown platform');
  const name = typeof b.device_name === 'string' ? b.device_name.trim() : '';
  if (!/^[\p{L}\p{N} ._()'-]{1,64}$/u.test(name))
    throw new AppAuthError(400, 'invalid_device_name', 'Device name must be 1 to 64 plain characters');
  const key = typeof b.public_key_hex === 'string' ? b.public_key_hex.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(key))
    throw new AppAuthError(400, 'invalid_public_key', 'public_key_hex must be 64 hex characters');
  const signing = typeof b.signing_key === 'string' ? b.signing_key.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(signing))
    throw new AppAuthError(400, 'invalid_signing_key', 'signing_key must be 64 hex characters');
  let scopes = DEFAULT_SCOPES;
  if (b.scopes !== undefined) {
    if (
      !Array.isArray(b.scopes) ||
      b.scopes.length > ALLOWED_SCOPES.length ||
      !b.scopes.every((s) => ALLOWED_SCOPES.includes(s))
    )
      throw new AppAuthError(400, 'invalid_scopes', 'Unknown scope');
    scopes = [...new Set(['app:self', ...b.scopes])];
  }
  return { platform: b.platform, deviceName: name, publicKey: key, signingKey: signing, scopes };
}

function parseDeviceCode(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new AppAuthError(400, 'invalid_device_code', 'Malformed device code');
  return value;
}

// ---------------------------------------------------------------------------------------
// Sign-in

async function startSignIn(body, { ip }) {
  const input = validateStart(body);
  const pool = getPgPool();
  const deviceCode = randomHex(32);
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = newUserCode();
    try {
      await pool.query(
        `INSERT INTO app_device_codes
           (id, device_code_hash, user_code_hash, platform, device_name, installation_public_key,
            signing_public_key, scopes, request_ip, interval_seconds, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + make_interval(secs => $11))`,
        [
          `adc_${randomHex(12)}`,
          sha256(deviceCode),
          sha256(userCode),
          input.platform,
          input.deviceName,
          input.publicKey,
          input.signingKey,
          input.scopes,
          ip || null,
          DEFAULT_INTERVAL,
          CODE_TTL_SECONDS
        ]
      );
      // Housekeeping: a code that expired a day ago answers "expired" like an unknown one.
      pool.query("DELETE FROM app_device_codes WHERE expires_at < NOW() - INTERVAL '1 day'").catch(() => {});
      logAuditEvent({
        eventType: 'APP_SIGNIN_STARTED',
        // No organisation yet: nobody has signed in. Stated, not left out.
        organizationId: null,
        severity: 'info',
        targetType: 'app_signin',
        message: `App sign-in started from a ${input.platform} device named "${input.deviceName}"`,
        ipAddress: ip,
        metadata: { platform: input.platform, scopes: input.scopes }
      });
      return {
        device_code: deviceCode,
        user_code: displayCode(userCode),
        verification_uri: VERIFICATION_PATH,
        verification_uri_complete: `${VERIFICATION_PATH}?code=${displayCode(userCode)}`,
        interval: DEFAULT_INTERVAL,
        expires_in: CODE_TTL_SECONDS,
        public_key_hex: input.publicKey
      };
    } catch (err) {
      if (err.code === '23505') continue; // user code collision: draw another
      throw err;
    }
  }
  throw new AppAuthError(503, 'try_again', 'Could not allocate a code, try again');
}

async function codeRow(client, userCodeRaw, { lock = false } = {}) {
  const code = normaliseUserCode(userCodeRaw);
  if (!code) throw new AppAuthError(404, 'code_not_found', 'No sign-in is waiting for that code');
  const res = await client.query(
    `SELECT *, expires_at <= NOW() AS expired FROM app_device_codes WHERE user_code_hash = $1${lock ? ' FOR UPDATE' : ''}`,
    [sha256(code)]
  );
  const row = res.rows[0];
  if (!row) throw new AppAuthError(404, 'code_not_found', 'No sign-in is waiting for that code');
  if (row.expired) throw new AppAuthError(410, 'code_expired', 'That code has expired, start again in the app');
  return row;
}

async function lookupSignIn(user, userCode) {
  const row = await codeRow(getPgPool(), userCode);
  if (row.status !== 'pending') throw new AppAuthError(409, 'code_used', 'That code was already used');
  const MfaPolicy = require('./MfaPolicy');
  const full = (await getPgPool().query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
  return {
    platform: row.platform,
    device_name: row.device_name,
    request_ip: row.request_ip,
    requested_at: row.created_at,
    expires_at: row.expires_at,
    scopes: row.scopes,
    mfa_required: full ? await MfaPolicy.isMfaRequired(full) : false
  };
}

async function approveSignIn(user, body, { ip }) {
  const pool = getPgPool();
  const preview = await codeRow(pool, body?.user_code);
  if (preview.status !== 'pending') throw new AppAuthError(409, 'code_used', 'That code was already used');

  const proof = await MfaSessionService.verifyFreshProof(user.id, {
    code: body?.totp_code,
    recovery_code: body?.recovery_code
  });
  if (proof === 'required') throw new AppAuthError(401, 'mfa_required', 'Enter the code from your authenticator');
  if (proof === 'invalid') throw new AppAuthError(401, 'mfa_invalid', 'That code is not valid');
  if (proof === 'setup')
    throw new AppAuthError(403, 'mfa_setup_required', 'Set up your authenticator before approving an app');

  const outcome = await EnrollmentService.transaction(async (client) => {
    const row = await codeRow(client, body.user_code, { lock: true });
    if (row.status !== 'pending') throw new AppAuthError(409, 'code_used', 'That code was already used');
    const person = (
      await client.query('SELECT id, username, role, status, organization_id FROM users WHERE id = $1 FOR UPDATE', [
        user.id
      ])
    ).rows[0];
    if (!person || person.status !== 'active')
      throw new AppAuthError(403, 'account_not_active', 'Active account required');
    const organizationId = orgOf(person);
    try {
      await EnrollmentService.authorizeOwner(client, person.id, organizationId);
    } catch (err) {
      throw new AppAuthError(403, 'organization_unavailable', err.message);
    }

    // The same rule as adding a device: an administrator's block is not undone by a new one.
    if (!isAdministrator({ role: person.role, org_role: user.org_role })) {
      const blocked = await client.query(
        `SELECT 1 FROM nodes WHERE user_id = $1 AND organization_id = $2
           AND is_quarantined AND COALESCE(quarantine_reason, '') <> $3 LIMIT 1`,
        [person.id, organizationId, AUTO_QUARANTINE_REASON]
      );
      if (blocked.rows.length > 0)
        throw new AppAuthError(
          403,
          'owner_has_blocked_device',
          'You have a blocked device; an administrator must unblock it first'
        );
    }

    const nodeId = deriveNodeId(row.installation_public_key);
    if (await RevocationEngine.isRevoked(row.installation_public_key, client))
      throw new AppAuthError(409, 'installation_revoked', 'This installation was removed; reinstall the app');
    const existing = await client.query('SELECT user_id, organization_id FROM nodes WHERE id = $1', [nodeId]);
    if (
      existing.rows[0] &&
      (existing.rows[0].user_id !== person.id || existing.rows[0].organization_id !== organizationId)
    )
      throw new AppAuthError(409, 'installation_in_use', 'This installation belongs to someone else');

    await client.query(
      `UPDATE app_device_codes SET status = 'approved', approved_user_id = $2, approved_organization_id = $3,
              decided_at = NOW() WHERE id = $1`,
      [row.id, person.id, organizationId]
    );
    return { row, person, organizationId };
  });

  logAuditEvent({
    eventType: 'APP_SIGNIN_APPROVED',
    organizationId: outcome.organizationId,
    actorUserId: outcome.person.id,
    actorUsername: outcome.person.username,
    targetId: outcome.row.id,
    targetType: 'app_signin',
    message: `${outcome.person.username} approved a ${outcome.row.platform} app named "${outcome.row.device_name}" asking from ${outcome.row.request_ip || 'an unknown address'}`,
    ipAddress: ip,
    metadata: { platform: outcome.row.platform, scopes: outcome.row.scopes, mfa: proof === 'ok' }
  });
  return { approved: true };
}

async function denySignIn(user, body, { ip }) {
  const pool = getPgPool();
  const row = await codeRow(pool, body?.user_code);
  const res = await pool.query(
    `UPDATE app_device_codes SET status = 'denied', approved_user_id = $2, decided_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [row.id, user.id]
  );
  if (res.rowCount !== 1) throw new AppAuthError(409, 'code_used', 'That code was already used');
  logAuditEvent({
    eventType: 'APP_SIGNIN_DENIED',
    organizationId: orgOf(user),
    actorUserId: user.id,
    actorUsername: user.username,
    targetId: row.id,
    targetType: 'app_signin',
    message: `${user.username} denied a ${row.platform} app named "${row.device_name}"`,
    ipAddress: ip,
    severity: 'info'
  });
  return { denied: true };
}

function mintTokens() {
  return {
    access: `nna_${randomHex(32)}`,
    refresh: `nnr_${randomHex(32)}`
  };
}

const tokenBody = (tokens, scopes) => ({
  token_type: 'Bearer',
  access_token: tokens.access,
  expires_in: ACCESS_TTL_SECONDS,
  refresh_token: tokens.refresh,
  refresh_expires_in: REFRESH_TTL_SECONDS,
  scopes
});

async function pollSignIn(body, { ip }) {
  const deviceCode = parseDeviceCode(body?.device_code);
  const hash = sha256(deviceCode);
  const minted = await withTransaction(async (client) => {
    const found = await client.query(
      'SELECT *, expires_at <= NOW() AS expired, last_polled_at > NOW() - make_interval(secs => interval_seconds) AS too_fast FROM app_device_codes WHERE device_code_hash = $1 FOR UPDATE',
      [hash]
    );
    const row = found.rows[0];
    if (!row || !sameHash(row.device_code_hash, hash) || row.expired || row.status === 'consumed')
      return { status: 'expired' };
    if (row.status === 'denied') return { status: 'denied' };
    if (row.status === 'pending') {
      if (row.too_fast) {
        const interval = Math.min(row.interval_seconds + DEFAULT_INTERVAL, MAX_INTERVAL);
        await client.query('UPDATE app_device_codes SET interval_seconds = $2, last_polled_at = NOW() WHERE id = $1', [
          row.id,
          interval
        ]);
        return { status: 'slow_down', interval };
      }
      await client.query('UPDATE app_device_codes SET last_polled_at = NOW() WHERE id = $1', [row.id]);
      return { status: 'pending', interval: row.interval_seconds };
    }

    // Approved: the person must still be allowed in at the moment the app collects.
    const person = (
      await client.query('SELECT id, username, status, organization_id FROM users WHERE id = $1 FOR UPDATE', [
        row.approved_user_id
      ])
    ).rows[0];
    if (!person || person.status !== 'active') {
      await client.query("UPDATE app_device_codes SET status = 'denied' WHERE id = $1", [row.id]);
      return { status: 'denied' };
    }
    const organizationId = row.approved_organization_id;
    const nodeId = deriveNodeId(row.installation_public_key);

    // A new sign-in of the same installation replaces the previous one.
    const old = await client.query(
      `UPDATE app_sessions SET revoked_at = NOW(), revoked_reason = 'superseded'
        WHERE node_id = $1 AND revoked_at IS NULL RETURNING grant_key_id`,
      [nodeId]
    );
    for (const o of old.rows) {
      if (o.grant_key_id)
        await client.query('UPDATE preauth_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [
          o.grant_key_id
        ]);
    }

    const grant = await PreAuthKeyService.createPreAuthKey({
      ownerId: person.id,
      organizationId,
      allowedRole: 'CLIENT_ORIGIN',
      isReusable: false,
      expiresInHours: GRANT_TTL_HOURS,
      boundPublicKey: row.installation_public_key,
      client
    });
    const tokens = mintTokens();
    const sessionId = `aps_${randomHex(12)}`;
    await client.query(
      `INSERT INTO app_sessions
         (id, user_id, organization_id, installation_public_key, signing_public_key, node_id, grant_key_id, platform,
          device_name, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at, request_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() + make_interval(secs => $12), $13, NOW() + make_interval(secs => $14), $15)`,
      [
        sessionId,
        person.id,
        organizationId,
        row.installation_public_key,
        row.signing_public_key,
        nodeId,
        grant.id,
        row.platform,
        row.device_name,
        row.scopes,
        sha256(tokens.access),
        ACCESS_TTL_SECONDS,
        sha256(tokens.refresh),
        REFRESH_TTL_SECONDS,
        row.request_ip
      ]
    );
    await client.query("UPDATE app_device_codes SET status = 'consumed' WHERE id = $1", [row.id]);
    return {
      status: 'approved',
      app_token: tokenBody(tokens, row.scopes),
      enrolment: {
        preauth_key: grant.secret,
        node_id: nodeId,
        role: 'CLIENT_ORIGIN',
        expires_at: grant.expires_at
      },
      account: { username: person.username, organization_id: organizationId },
      audit: { sessionId, person, organizationId, platform: row.platform, scopes: row.scopes }
    };
  });
  if (minted.audit) {
    const a = minted.audit;
    logAuditEvent({
      eventType: 'APP_SESSION_ISSUED',
      organizationId: a.organizationId,
      actorUserId: a.person.id,
      actorUsername: a.person.username,
      targetId: a.sessionId,
      targetType: 'app_session',
      message: `App session ${a.sessionId} issued to ${a.person.username} for a ${a.platform} app`,
      ipAddress: ip,
      metadata: { platform: a.platform, scopes: a.scopes }
    });
    delete minted.audit;
  }
  return minted;
}

// ---------------------------------------------------------------------------------------
// The app token itself

/** The bearer token of a request if it is shaped like an app access token. */
function appTokenFromRequest(req) {
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return /^nna_[0-9a-f]{64}$/.test(token) ? token : null;
}

async function resolveAppToken(token) {
  const hash = sha256(token);
  const res = await getPgPool().query(
    `SELECT s.*, u.username, u.status AS user_status,
            s.access_expires_at <= NOW() AS access_expired
       FROM app_sessions s JOIN users u ON u.id = s.user_id WHERE s.access_hash = $1`,
    [hash]
  );
  const s = res.rows[0];
  if (!s || !sameHash(s.access_hash, hash) || s.revoked_at || s.access_expired || s.user_status !== 'active')
    return null;
  getPgPool()
    .query(
      "UPDATE app_sessions SET last_used_at = NOW() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')",
      [s.id]
    )
    .catch(() => {});
  return s;
}

/** Express middleware: accepts an app token with the scope, and nothing else. */
function authenticateApp(scope) {
  return async (req, res, next) => {
    try {
      const token = appTokenFromRequest(req);
      const session = token ? await resolveAppToken(token) : null;
      if (!session) return res.status(401).json({ error: 'Invalid or expired app token' });
      if (!session.scopes.includes(scope)) return res.status(403).json({ error: 'insufficient_scope', scope });
      req.appSession = {
        id: session.id,
        userId: session.user_id,
        username: session.username,
        organizationId: session.organization_id,
        nodeId: session.node_id,
        platform: session.platform,
        deviceName: session.device_name,
        scopes: session.scopes,
        expiresAt: session.access_expires_at
      };
      return next();
    } catch (err) {
      logger.error(`App token check failed: ${err.message}`);
      return res.status(503).json({ error: 'App authority unavailable' });
    }
  };
}

// How far a signed refresh may be from the console's clock, and how long the previous refresh
// token stays good for one retry after a rotation whose answer never arrived.
const SIGNATURE_WINDOW_SECONDS = 60;
const RETRY_WINDOW_SECONDS = 60;
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The exact bytes an installation signs to refresh: method, path, hash of the token, time, nonce. */
function refreshMessage(refreshToken, timestamp, nonce) {
  return [
    'NERONET-APP-REFRESH-V1',
    'POST',
    '/api/app-auth/token/refresh',
    sha256(refreshToken),
    String(timestamp),
    nonce
  ].join('\n');
}

function verifyEd25519(publicHex, message, signatureHex) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicHex, 'hex')]),
      format: 'der',
      type: 'spki'
    });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Rotates the app token. The request must be signed by the installation's Ed25519 key, so a
 * stolen refresh token alone is worthless (and does not revoke anything: a thief must not be
 * able to sign the real app out by presenting it).
 *
 * A lost response is survivable: the immediately previous refresh token, presented again within
 * a minute with a fresh valid signature, returns a new pair once. Every other use of a replaced
 * token is a replay and revokes the app and cuts its node.
 */
async function refreshTokens(body, { ip }) {
  const unauthorised = new AppAuthError(401, 'invalid_refresh', 'Sign in again');
  const refresh = typeof body?.refresh_token === 'string' ? body.refresh_token : '';
  if (!/^nnr_[0-9a-f]{64}$/.test(refresh)) throw unauthorised;
  const timestamp = body?.timestamp;
  const nonce = typeof body?.nonce === 'string' ? body.nonce : '';
  const signature = typeof body?.signature === 'string' ? body.signature : '';
  const wellFormed =
    Number.isSafeInteger(timestamp) && /^[0-9a-f]{32}$/.test(nonce) && /^[0-9a-f]{128}$/.test(signature);
  const fresh = wellFormed && Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= SIGNATURE_WINDOW_SECONDS;
  const hash = sha256(refresh);

  let reuse = null;
  const result = await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT s.*, u.status AS user_status, u.username, s.refresh_expires_at <= NOW() AS refresh_expired,
              s.rotated_at > NOW() - make_interval(secs => $2) AS within_retry_window
         FROM app_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_hash = $1 OR s.previous_refresh_hash = $1 FOR UPDATE OF s`,
      [hash, RETRY_WINDOW_SECONDS]
    );
    const s = found.rows[0];
    if (!s || s.revoked_at) return null;
    const signedByInstallation =
      fresh && verifyEd25519(s.signing_public_key, refreshMessage(refresh, timestamp, nonce), signature);
    const isCurrent = sameHash(s.refresh_hash, hash);
    const isPrevious = !isCurrent && s.previous_refresh_hash && sameHash(s.previous_refresh_hash, hash);

    const revoke = async (reason) => {
      reuse = s;
      await client.query('UPDATE app_sessions SET revoked_at = NOW(), revoked_reason = $2 WHERE id = $1', [
        s.id,
        reason
      ]);
      if (s.grant_key_id)
        await client.query('UPDATE preauth_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [
          s.grant_key_id
        ]);
      return null;
    };

    // A signed request is accepted once: its nonce is spent here, before anything is issued.
    const spendNonce = async () => {
      await client.query('DELETE FROM app_refresh_nonces WHERE expires_at < NOW()');
      const spent = await client.query(
        `INSERT INTO app_refresh_nonces (nonce_hash, session_id, expires_at)
         VALUES ($1, $2, NOW() + make_interval(secs => $3)) ON CONFLICT DO NOTHING RETURNING 1`,
        [sha256(`${s.id}:${nonce}`), s.id, SIGNATURE_WINDOW_SECONDS * 2]
      );
      return spent.rowCount === 1;
    };

    if (isPrevious) {
      const retry = signedByInstallation && !s.previous_retry_used && s.within_retry_window && (await spendNonce());
      if (!retry) return revoke('refresh_reuse');
    } else if (isCurrent) {
      if (!signedByInstallation || !(await spendNonce())) return null;
    } else {
      return null;
    }

    if (s.refresh_expired) return null;
    if (s.user_status !== 'active') {
      await client.query(
        "UPDATE app_sessions SET revoked_at = NOW(), revoked_reason = 'account_not_active' WHERE id = $1",
        [s.id]
      );
      return null;
    }
    const tokens = mintTokens();
    // A retry keeps the original old token as "previous" and marks its retry spent; a normal
    // rotation makes the current token previous with its retry still unspent.
    await client.query(
      `UPDATE app_sessions SET previous_refresh_hash = $6, previous_retry_used = $7, refresh_hash = $2,
              access_hash = $3, access_expires_at = NOW() + make_interval(secs => $4),
              refresh_expires_at = NOW() + make_interval(secs => $5), rotated_at = NOW(), last_used_at = NOW()
        WHERE id = $1`,
      [
        s.id,
        sha256(tokens.refresh),
        sha256(tokens.access),
        ACCESS_TTL_SECONDS,
        REFRESH_TTL_SECONDS,
        isPrevious ? s.previous_refresh_hash : s.refresh_hash,
        Boolean(isPrevious)
      ]
    );
    return tokenBody(tokens, s.scopes);
  });

  if (reuse) {
    await cutNode(reuse.node_id, { reason: 'app_token_reuse', actorId: null });
    logAuditEvent({
      eventType: 'APP_TOKEN_REUSE_DETECTED',
      organizationId: reuse.organization_id,
      actorUserId: reuse.user_id,
      actorUsername: reuse.username,
      targetId: reuse.id,
      targetType: 'app_session',
      severity: 'warn',
      message: `A replaced refresh token of app session ${reuse.id} was used again; the app was signed out and its node cut`,
      ipAddress: ip
    });
  }
  if (!result) throw unauthorised;
  return result;
}

// ---------------------------------------------------------------------------------------
// Listing and revoking

async function cutNode(nodeId, { reason, actorId }) {
  // The existing revocation path: key to every peer, credentials dead, ACL epoch bumped.
  await RevocationEngine.revokeNodeKeys([nodeId], { reason, actorId });
}

const publicSession = (r) => ({
  id: r.id,
  user_id: r.user_id,
  username: r.username,
  organization_id: r.organization_id,
  platform: r.platform,
  device_name: r.device_name,
  node_id: r.node_id,
  scopes: r.scopes,
  created_at: r.created_at,
  last_used_at: r.last_used_at,
  revoked_at: r.revoked_at,
  revoked_reason: r.revoked_reason,
  status: r.revoked_at ? 'revoked' : new Date(r.refresh_expires_at) <= new Date() ? 'expired' : 'active'
});

async function listSessions(user, { organization = false } = {}) {
  const params = [];
  let where;
  if (organization) {
    if (!isAdministrator(user)) throw new AppAuthError(403, 'forbidden', 'Administrators only');
    if (user.role === 'super-admin') where = 'TRUE';
    else {
      params.push(orgOf(user));
      where = 's.organization_id = $1';
    }
  } else {
    params.push(user.id);
    where = 's.user_id = $1';
  }
  const res = await getPgPool().query(
    `SELECT s.*, u.username FROM app_sessions s JOIN users u ON u.id = s.user_id
      WHERE ${where} ORDER BY s.created_at DESC LIMIT 200`,
    params
  );
  return { sessions: res.rows.map(publicSession) };
}

async function revokeSession(actor, sessionId, { reason = 'revoked', ip = null, bySelfApp = false } = {}) {
  if (typeof sessionId !== 'string' || !/^aps_[0-9a-f]{24}$/.test(sessionId))
    throw new AppAuthError(404, 'not_found', 'No such app');
  const pool = getPgPool();
  const res = await pool.query('SELECT * FROM app_sessions WHERE id = $1', [sessionId]);
  const s = res.rows[0];
  const allowed =
    s &&
    (bySelfApp ||
      s.user_id === actor.id ||
      actor.role === 'super-admin' ||
      (isAdministrator(actor) && s.organization_id === orgOf(actor)));
  if (!allowed) throw new AppAuthError(404, 'not_found', 'No such app');
  const updated = await pool.query(
    `UPDATE app_sessions SET revoked_at = NOW(), revoked_by = $2, revoked_reason = $3
      WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [s.id, actor.id, reason]
  );
  if (s.grant_key_id)
    await pool.query('UPDATE preauth_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [
      s.grant_key_id
    ]);
  // Always cut the node, even when the session was already revoked: a failed earlier cut is repaired here.
  await cutNode(s.node_id, { reason: 'app_session_revoked', actorId: actor.id });
  if (updated.rowCount === 1) {
    logAuditEvent({
      eventType: 'APP_SESSION_REVOKED',
      organizationId: s.organization_id,
      actorUserId: actor.id,
      actorUsername: actor.username,
      targetId: s.id,
      targetType: 'app_session',
      severity: 'warn',
      message: `App session ${s.id} (${s.platform}, "${s.device_name}") revoked by ${actor.username}; its node ${s.node_id} was cut`,
      ipAddress: ip,
      metadata: { reason, node_id: s.node_id, owner: s.user_id }
    });
  }
  return { revoked: true, already: updated.rowCount !== 1 };
}

async function ownDevices(session) {
  const res = await getPgPool().query(
    `SELECT id, name, role, device_kind, overlay_ipv4, overlay_ipv6, is_healthy, is_quarantined
       FROM nodes WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 200`,
    [session.userId, session.organizationId]
  );
  return {
    devices: res.rows.map((d) => ({
      id: d.id,
      name: d.name,
      role: d.role,
      kind: d.device_kind,
      overlay_ipv4: d.overlay_ipv4,
      overlay_ipv6: d.overlay_ipv6,
      online: Boolean(d.is_healthy) && !d.is_quarantined,
      blocked: Boolean(d.is_quarantined),
      this_device: d.id === session.nodeId
    }))
  };
}

module.exports = {
  AppAuthError,
  PLATFORMS,
  ALLOWED_SCOPES,
  normaliseUserCode,
  startSignIn,
  lookupSignIn,
  approveSignIn,
  denySignIn,
  pollSignIn,
  refreshTokens,
  authenticateApp,
  listSessions,
  revokeSession,
  ownDevices
};
