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
const ControlPlaneKeyService = require('./ControlPlaneKeyService');
const { normalisePublicKeyHex } = require('../utils/crypto');
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

/**
 * A public key is not a secret: every peer receives it in its netmap. Naming a key at start is
 * therefore not enough; the caller proves it holds the private half with the same challenge
 * and proof registration uses, for the purpose "APP_SIGNIN", so a proof for one thing is no
 * proof for another and a challenge is spent once.
 */
async function requireKeyProof(publicKey, body) {
  const nonce = typeof body?.nonce === 'string' ? body.nonce.trim() : '';
  const proof = typeof body?.proof === 'string' ? body.proof.trim() : '';
  const fail = () =>
    new AppAuthError(401, 'key_proof_invalid', 'Prove that this device holds its key: fetch a challenge and sign it');
  if (!nonce || !proof) throw fail();
  if (!(await ControlPlaneKeyService.consumeChallenge(nonce))) throw fail();
  if (!ControlPlaneKeyService.verifyProof(publicKey, nonce, proof, 'APP_SIGNIN')) throw fail();
}

async function startSignIn(body, { ip }) {
  const input = validateStart(body);
  await requireKeyProof(input.publicKey, body);
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
        // The code rides in the fragment, which no server or proxy ever sees, never in the query string.
        verification_uri_complete: `${VERIFICATION_PATH}#code=${displayCode(userCode)}`,
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
    // Shown back so the person can compare it with the one on the app's screen and type it to confirm.
    user_code: displayCode(normaliseUserCode(userCode)),
    platform: row.platform,
    device_name: row.device_name,
    request_ip: row.request_ip,
    requested_at: row.created_at,
    expires_at: row.expires_at,
    scopes: row.scopes,
    mfa_required: full ? await MfaPolicy.isMfaRequired(full) : false
  };
}

const ABSOLUTE_LIFETIME_DAYS = 90;
const READ_ONLY_ROLES = ['auditor', 'viewer'];

/**
 * Whether this person may still have an app, judged afresh each time the app asks for something
 * that lasts: approval, collecting the tokens, refreshing them. The same authority that lets a
 * person add a device in the console (authorizeOwner as a console actor, so a read-only role is
 * refused), the blocked-device rule, and the account's authentication epoch, which a password,
 * role or second-factor change, or "revoke all sessions", moves.
 */
async function standing(client, userId, organizationId, authEpoch) {
  const u = (
    await client.query(
      'SELECT id, username, role, status, organization_id, console_auth_epoch FROM users WHERE id = $1',
      [userId]
    )
  ).rows[0];
  if (!u || u.status !== 'active')
    return { ok: false, reason: 'account_not_active', message: 'Active account required' };
  if (authEpoch !== null && authEpoch !== undefined && String(u.console_auth_epoch) !== String(authEpoch))
    return { ok: false, reason: 'account_changed', message: 'The account changed after the approval' };
  let actor;
  try {
    actor = await EnrollmentService.authorizeOwner(client, u.id, organizationId, { consoleActor: true });
  } catch (err) {
    return {
      ok: false,
      reason: /read-only/i.test(err.message) ? 'read_only_role' : 'organization_unavailable',
      message: err.message
    };
  }
  // The same rule as adding a device: an administrator's block is not undone by a new one.
  if (!isAdministrator({ role: actor.role, org_role: actor.org_role })) {
    const blocked = await client.query(
      `SELECT 1 FROM nodes WHERE user_id = $1 AND organization_id = $2
         AND is_quarantined AND COALESCE(quarantine_reason, '') <> $3 LIMIT 1`,
      [u.id, organizationId, AUTO_QUARANTINE_REASON]
    );
    if (blocked.rows.length > 0)
      return {
        ok: false,
        reason: 'owner_has_blocked_device',
        message: 'You have a blocked device; an administrator must unblock it first'
      };
  }
  return { ok: true, user: u, actor };
}

const standingError = (st) =>
  new AppAuthError(403, st.reason === 'read_only_role' ? 'forbidden_role' : st.reason, st.message);

async function approveSignIn(user, body, { ip, organizationIdAtIssue = null }) {
  const pool = getPgPool();
  const preview = await codeRow(pool, body?.user_code);
  if (preview.status !== 'pending') throw new AppAuthError(409, 'code_used', 'That code was already used');
  // The second factor's secret is opened before the transaction takes the account lock.
  const prepared = await MfaSessionService.prepareFreshProof(user.id);

  let outcome;
  try {
    outcome = await EnrollmentService.transaction(async (client) => {
      const row = await codeRow(client, body.user_code, { lock: true });
      if (row.status !== 'pending') throw new AppAuthError(409, 'code_used', 'That code was already used');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      // Bound to the organisation the signed-in session was issued for, as every console action that
      // creates a node is: a read-only role is refused here.
      const organizationId = organizationIdAtIssue || orgOf(user);
      const st = await standing(client, user.id, organizationId, null);
      if (!st.ok) throw standingError(st);

      const proof = await MfaSessionService.applyFreshProof(client, user.id, prepared, {
        code: body?.totp_code,
        recovery_code: body?.recovery_code
      });
      if (proof === 'required')
        throw Object.assign(new AppAuthError(401, 'mfa_required', 'Enter the code from your authenticator'), {
          mfa: 'required'
        });
      if (proof === 'invalid')
        throw Object.assign(new AppAuthError(401, 'mfa_invalid', 'That code is not valid'), { mfa: 'invalid' });
      if (proof === 'setup')
        throw new AppAuthError(403, 'mfa_setup_required', 'Set up your authenticator before approving an app');

      const key = row.installation_public_key;
      const nodeId = deriveNodeId(key);
      if ((await revokedForGood(key, client)) || (await keyWasRevoked(key, client)))
        throw new AppAuthError(409, 'installation_revoked', 'This installation was removed; reinstall the app');
      const inUse = () => new AppAuthError(409, 'installation_in_use', 'This installation belongs to someone else');
      const existing = (
        await client.query('SELECT id, user_id, organization_id, public_key FROM nodes WHERE id = $1 FOR UPDATE', [
          nodeId
        ])
      ).rows[0];
      if (existing) {
        // Only a node an app sign-in made, for this person and this very key, may be signed in again.
        const madeByApp = await client.query(
          'SELECT 1 FROM app_sessions WHERE node_id = $1 AND installation_public_key = $2 LIMIT 1',
          [nodeId, key]
        );
        if (
          madeByApp.rows.length === 0 ||
          existing.user_id !== st.user.id ||
          existing.organization_id !== organizationId ||
          normalisePublicKeyHex(existing.public_key) !== key
        )
          throw inUse();
      }
      const other = await client.query(
        'SELECT 1 FROM app_sessions WHERE node_id = $1 AND revoked_at IS NULL AND user_id <> $2 LIMIT 1',
        [nodeId, st.user.id]
      );
      if (other.rows.length > 0) throw inUse();

      await client.query(
        `UPDATE app_device_codes SET status = 'approved', approved_user_id = $2, approved_organization_id = $3,
                approved_auth_epoch = $4, decided_at = NOW() WHERE id = $1`,
        [row.id, st.user.id, organizationId, st.user.console_auth_epoch]
      );
      return { row, person: st.user, organizationId, mfa: proof === 'ok' && prepared.state === 'needed' };
    });
  } catch (err) {
    if (err.mfa) {
      logAuditEvent({
        eventType: 'APP_SIGNIN_MFA_FAILED',
        organizationId: organizationIdAtIssue || orgOf(user),
        actorUserId: user.id,
        actorUsername: user.username,
        targetType: 'app_signin',
        severity: 'warn',
        message: `${user.username} gave ${err.mfa === 'required' ? 'no' : 'a wrong or used'} second-factor code to approve an app`,
        ipAddress: ip,
        metadata: { reason: err.mfa }
      });
    }
    throw err;
  }

  logAuditEvent({
    eventType: 'APP_SIGNIN_APPROVED',
    organizationId: outcome.organizationId,
    actorUserId: outcome.person.id,
    actorUsername: outcome.person.username,
    targetId: outcome.row.id,
    targetType: 'app_signin',
    message: `${outcome.person.username} approved a ${outcome.row.platform} app named "${outcome.row.device_name}" (self-declared) asking from ${outcome.row.request_ip || 'an unknown address'}`,
    ipAddress: ip,
    metadata: { platform: outcome.row.platform, scopes: outcome.row.scopes, mfa: outcome.mfa }
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
  // Only collecting an approval touches nodes and sessions, so only that takes the lifecycle lock first.
  const peek = await getPgPool().query('SELECT status FROM app_device_codes WHERE device_code_hash = $1', [hash]);
  const runTransaction = peek.rows[0]?.status === 'approved' ? EnrollmentService.transaction : withTransaction;
  const minted = await retryDeadlock(() =>
    runTransaction(async (client) => {
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
          await client.query(
            'UPDATE app_device_codes SET interval_seconds = $2, last_polled_at = NOW() WHERE id = $1',
            [row.id, interval]
          );
          return { status: 'slow_down', interval };
        }
        await client.query('UPDATE app_device_codes SET last_polled_at = NOW() WHERE id = $1', [row.id]);
        return { status: 'pending', interval: row.interval_seconds };
      }

      // Approved: the person must still be allowed in at the moment the app collects.
      const organizationId = row.approved_organization_id;
      const nodeId = deriveNodeId(row.installation_public_key);
      const st = await standing(client, row.approved_user_id, organizationId, row.approved_auth_epoch);
      const refused =
        !st.ok ||
        (await keyWasRevoked(row.installation_public_key, client)) ||
        (
          await client.query('SELECT 1 FROM app_sessions WHERE node_id = $1 AND revoked_at IS NULL AND user_id <> $2', [
            nodeId,
            row.approved_user_id
          ])
        ).rows.length > 0;
      if (refused) {
        await client.query("UPDATE app_device_codes SET status = 'denied' WHERE id = $1", [row.id]);
        return { status: 'denied' };
      }
      const person = st.user;

      // A new sign-in of the same installation by the same person replaces the previous one.
      const old = await client.query(
        `UPDATE app_sessions SET revoked_at = NOW(), revoked_reason = 'superseded'
        WHERE node_id = $1 AND revoked_at IS NULL AND user_id = $2 RETURNING grant_key_id`,
        [nodeId, person.id]
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
          device_name, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at, request_ip,
          auth_epoch, absolute_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() + make_interval(secs => $12), $13,
               NOW() + make_interval(secs => $14), $15, $16, NOW() + make_interval(days => $17))`,
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
          row.request_ip,
          person.console_auth_epoch,
          ABSOLUTE_LIFETIME_DAYS
        ]
      );
      await client.query("UPDATE app_device_codes SET status = 'consumed' WHERE id = $1", [row.id]);
      // The same installation coming back after a suspension: peers hear of its node again.
      await liftSuspension(client, nodeId);
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
    })
  );
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

/**
 * Whether this key has been revoked for good. The revoked-key list that reaches the peers is kept
 * for a day; an app that was signed out, or cut for reusing a token, must not come back through
 * the "already enrolled" door the day after, so the sessions themselves remember. A key that was
 * only replaced by a newer sign-in of the same installation ("superseded") is not revoked.
 */
async function keyWasRevoked(publicKeyHex, client = null) {
  const key = normalisePublicKeyHex(publicKeyHex);
  if (!key) return false;
  const res = await (client || getPgPool()).query(
    'SELECT 1 FROM app_key_bans WHERE installation_public_key = $1 LIMIT 1',
    [key]
  );
  return res.rows.length > 0;
}

/** On the revoked-key list for a reason that is not an app's recoverable suspension. */
async function revokedForGood(publicKeyHex, client) {
  const key = normalisePublicKeyHex(publicKeyHex);
  if (!key) return false;
  const res = await client.query(
    "SELECT 1 FROM revoked_keys WHERE public_key_hex = $1 AND expires_at > NOW() AND reason NOT LIKE 'app_suspended:%' LIMIT 1",
    [key]
  );
  return res.rows.length > 0;
}

async function resolveAppToken(token) {
  const hash = sha256(token);
  const res = await getPgPool().query(
    `SELECT s.*, u.username, u.status AS user_status, u.role AS user_role, u.console_auth_epoch,
            COALESCE(u.organization_id, 'org-default') AS user_organization, m.id AS membership_id,
            m.role AS membership_role, o.destroyed_at AS organization_destroyed_at,
            s.access_expires_at <= NOW() AS access_expired, s.absolute_expires_at <= NOW() AS absolute_expired
       FROM app_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.user_id = u.id AND m.organization_id = s.organization_id
       LEFT JOIN organizations o ON o.id = s.organization_id
      WHERE s.access_hash = $1`,
    [hash]
  );
  const s = res.rows[0];
  if (!s || !sameHash(s.access_hash, hash)) return null;
  if (s.revoked_at || s.access_expired || s.absolute_expired) return null;
  // The account behind the token must still be the one that approved it, in the same standing.
  if (s.user_status !== 'active' || String(s.console_auth_epoch) !== String(s.auth_epoch)) return null;
  if (s.organization_destroyed_at) return null;
  const superAdmin = s.user_role === 'super-admin';
  if (!superAdmin && s.user_organization !== s.organization_id && !s.membership_id) return null;
  const orgRole = superAdmin ? 'owner' : s.membership_role || s.user_role;
  if (READ_ONLY_ROLES.includes(orgRole)) return null;
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
      req.appToken = token;
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

// ---------------------------------------------------------------------------------------
// Three states, and the order in which writers take their locks
//
// An app is in one of three states, and the difference is what can come back:
//   active     revoked_at is null.
//   suspended  revoked_at is set, banned is false. Something that can be put right ended it: a blocked
//              device, a changed password, role or second factor, "revoke all sessions", a brief
//              account suspension, an expired lifetime, a retry that came too late. The node is cut off
//              (credentials dead, peers told, row kept) but its key is not banned: the same installation
//              signs in again, is approved again, and is back with the same node.
//   revoked    banned is true and the key is in app_key_bans. A person or an administrator revoked it,
//              a fresh valid signature replayed a token that was long replaced, or an administrator
//              deleted the node. Nothing brings that key back; the app must be installed again.
//
// Lock order. Every writer that touches nodes, app sessions or organisations takes the enrolment
// lifecycle lock first (EnrollmentService.transaction, the lock registration and the destruction of an
// organisation take too), so they queue up in one line instead of crossing each other:
//   1. the lifecycle advisory lock
//   2. organisations, then nodes (as destruction takes them)
//   3. app_device_codes, app_sessions
//   4. users, revoked_keys, mesh_epochs
// Writers that cannot take the lock first (a console action that updates a user) can still be chosen
// as the victim of a deadlock; retryDeadlock runs such a transaction again.
const DEADLOCK_RETRIES = 3;
async function retryDeadlock(work) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      const retryable = err && (err.code === '40P01' || err.code === '40001');
      if (!retryable || attempt >= DEADLOCK_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1) + Math.floor(Math.random() * 25)));
    }
  }
}

/** Puts the installation key in the ban list, for good. */
async function banKey(client, session, reason) {
  await client.query(
    `INSERT INTO app_key_bans (installation_public_key, node_id, organization_id, reason) VALUES ($1, $2, $3, $4)
     ON CONFLICT (installation_public_key) DO NOTHING`,
    [session.installation_public_key, session.node_id, session.organization_id, reason]
  );
  await client.query(
    `UPDATE app_sessions SET banned = TRUE
      WHERE installation_public_key = $1 AND revoked_at IS NOT NULL AND COALESCE(revoked_reason, '') <> 'superseded'`,
    [session.installation_public_key]
  );
}

/**
 * Ends a session that can be put right: its node is cut off from the network and from its peers,
 * its credentials die and its row stays, the key is not banned. Idempotent.
 */
async function suspendSession(client, session, reason, actorId = null) {
  await client.query(
    'UPDATE app_sessions SET revoked_at = NOW(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL',
    [session.id, reason]
  );
  if (session.grant_key_id)
    await client.query('UPDATE preauth_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [
      session.grant_key_id
    ]);
  const node = (await client.query('SELECT * FROM nodes WHERE id = $1 FOR UPDATE', [session.node_id])).rows[0];
  if (!node) return { cut: false, why: 'no node' };
  if (node.user_id !== session.user_id || normalisePublicKeyHex(node.public_key) !== session.installation_public_key)
    return { cut: false, why: "not this session's node" };
  const newer = await client.query(
    'SELECT 1 FROM app_sessions WHERE node_id = $1 AND revoked_at IS NULL AND id <> $2 LIMIT 1',
    [session.node_id, session.id]
  );
  if (newer.rows.length > 0) return { cut: false, why: 'superseded' };
  // A node that serves profile devices carries all their tunnels: the app is suspended, the node is not
  // touched, as DELETE /api/nodes refuses to remove it and the app routes refuse to cut it.
  if (node.profile_gateway_endpoint) return { cut: false, why: 'serves profile devices' };
  await RevocationEngine.revokeNodeKeys([node.id], { reason: `app_suspended:${reason}`, actorId, client });
  // A suspension has no end date of its own: the entry stays until a new approval lifts it (liftSuspension).
  // The 24 hour list is for keys that are gone; this node is still in the table, so peers, relays and
  // netmaps must keep excluding it however long it is suspended.
  await client.query("UPDATE revoked_keys SET expires_at = 'infinity' WHERE node_id = $1", [node.id]);
  return { cut: true, kept: true };
}

/** What happens when the app comes back after a suspension: peers hear of the node again. */
async function liftSuspension(client, nodeId) {
  const lifted = await client.query(
    "DELETE FROM revoked_keys WHERE node_id = $1 AND reason LIKE 'app_suspended:%' RETURNING 1",
    [nodeId]
  );
  if (lifted.rowCount > 0)
    await client.query("UPDATE mesh_epochs SET epoch = epoch + 1, updated_at = NOW() WHERE name IN ('acl', 'netmap')");
}

function suspensionAudit(s, reason, ip, extra = '') {
  logAuditEvent({
    eventType: 'APP_SESSION_SUSPENDED',
    organizationId: s.organization_id,
    actorUserId: s.user_id,
    actorUsername: s.username || null,
    targetId: s.id,
    targetType: 'app_session',
    severity: 'warn',
    message: `App session ${s.id} was suspended (${reason})${extra}; its node ${s.node_id} is cut off until the app is approved again`,
    ipAddress: ip,
    metadata: { reason, node_id: s.node_id }
  });
}

/**
 * Whether a node that an app sign-in enrolled may be served at all: the node routes call this for
 * every credential check. A node whose app is suspended or revoked is refused even though its
 * credential has not run out, and an app whose account no longer stands (a moved authentication
 * epoch, a suspended person, a passed lifetime) is suspended on the spot, so an app that never
 * refreshes does not keep its node.
 */
async function nodeAdmission(nodeId) {
  const s = (
    await getPgPool().query(
      `SELECT s.id, s.node_id, s.user_id, s.organization_id, s.revoked_at, s.banned, s.auth_epoch,
              s.absolute_expires_at <= NOW() AS absolute_expired, s.refresh_expires_at <= NOW() AS refresh_expired,
              u.status AS user_status, u.console_auth_epoch, n.profile_gateway_endpoint
         FROM app_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN nodes n ON n.id = s.node_id
        WHERE s.node_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [nodeId]
    )
  ).rows[0];
  if (!s) return { ok: true };
  // A gateway for profile devices is not cut off because its app is: see suspendSession.
  if (s.profile_gateway_endpoint && !s.banned) {
    if (!s.revoked_at) {
      const gone =
        s.user_status !== 'active' ||
        String(s.console_auth_epoch) !== String(s.auth_epoch) ||
        s.absolute_expired ||
        s.refresh_expired;
      if (gone) await suspendById(s.id, 'account_changed');
    }
    return { ok: true };
  }
  if (s.revoked_at) return { ok: false, error: s.banned ? 'this app was removed' : 'this app must be approved again' };
  const reason =
    s.user_status !== 'active'
      ? 'account_not_active'
      : String(s.console_auth_epoch) !== String(s.auth_epoch)
        ? 'account_changed'
        : s.absolute_expired || s.refresh_expired
          ? 'expired'
          : null;
  if (!reason) return { ok: true };
  await suspendById(s.id, reason);
  return { ok: false, error: 'this app must be approved again' };
}

/** Whether a node an app enrolled has no live session: it may not register again without a grant. */
async function nodeNeedsSignIn(nodeId, client = null) {
  const res = await (client || getPgPool()).query(
    `SELECT EXISTS (SELECT 1 FROM app_sessions WHERE node_id = $1) AS had,
            EXISTS (SELECT 1 FROM app_sessions WHERE node_id = $1 AND revoked_at IS NULL) AS live`,
    [nodeId]
  );
  return res.rows[0].had && !res.rows[0].live;
}

async function suspendById(sessionId, reason, ip = null) {
  const suspended = await retryDeadlock(() =>
    EnrollmentService.transaction(async (client) => {
      const s = (
        await client.query(
          'SELECT s.*, u.username FROM app_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 FOR UPDATE OF s',
          [sessionId]
        )
      ).rows[0];
      if (!s || s.revoked_at) return null;
      await suspendSession(client, s, reason);
      return s;
    })
  );
  if (suspended) suspensionAudit(suspended, reason, ip);
  return Boolean(suspended);
}

/** Inside the caller's transaction: every live app of a person is suspended, as "revoke all sessions" ends their sessions. */
async function suspendUserApps(client, userId, reason = 'sessions_revoked') {
  const rows = (
    await client.query(
      'SELECT s.*, u.username FROM app_sessions s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1 AND s.revoked_at IS NULL FOR UPDATE OF s',
      [userId]
    )
  ).rows;
  for (const s of rows) {
    await suspendSession(client, s, reason);
    suspensionAudit(s, reason, null);
  }
  return rows.length;
}

/**
 * Checks every live app against its person's standing and suspends the ones that no longer have it.
 * Nodes are also checked at every credential use; this is for the app whose node is quiet.
 */
async function sweepStanding() {
  const ids = (await getPgPool().query('SELECT id FROM app_sessions WHERE revoked_at IS NULL')).rows.map((r) => r.id);
  let suspended = 0;
  for (const id of ids) {
    let reason = null;
    try {
      reason = await retryDeadlock(() =>
        EnrollmentService.transaction(async (client) => {
          const s = (
            await client.query(
              `SELECT s.*, u.username, s.absolute_expires_at <= NOW() AS absolute_expired,
                    s.refresh_expires_at <= NOW() AS refresh_expired
               FROM app_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 FOR UPDATE OF s`,
              [id]
            )
          ).rows[0];
          if (!s || s.revoked_at) return null;
          let why = s.absolute_expired || s.refresh_expired ? 'expired' : null;
          if (!why) {
            const st = await standing(client, s.user_id, s.organization_id, s.auth_epoch);
            if (!st.ok) why = st.reason;
          }
          if (!why) return null;
          await suspendSession(client, s, why);
          suspensionAudit(s, why, null, ' by the sweeper');
          return why;
        })
      );
    } catch (err) {
      logger.warn(`App standing check of ${id} failed, the others go on: ${err.message}`);
    }
    if (reason) suspended += 1;
  }
  return suspended;
}

/**
 * Old rows go; the ban list never does. A suspension a year old is not left as a node with no session:
 * it becomes a revocation (key banned, node removed), because nobody is coming back for it.
 */
async function purgeAppRows() {
  const pool = getPgPool();
  const stale = (
    await pool.query(
      `SELECT id FROM app_sessions WHERE revoked_at IS NOT NULL AND NOT banned AND revoked_at < NOW() - INTERVAL '365 days'`
    )
  ).rows;
  for (const row of stale) {
    try {
      await retryDeadlock(() =>
        EnrollmentService.transaction(async (client) => {
          const s = (await client.query('SELECT * FROM app_sessions WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
          if (!s || s.banned || !s.revoked_at) return;
          await client.query('UPDATE app_sessions SET banned = TRUE WHERE id = $1', [s.id]);
          await banKey(client, s, 'suspension_expired');
          await cutSessionNode(client, s, { reason: 'app_session_revoked', actorId: null });
        })
      );
    } catch (err) {
      logger.warn(`Purging the suspended app ${row.id} failed, the others go on: ${err.message}`);
    }
  }
  await pool.query(
    `DELETE FROM app_sessions WHERE revoked_at IS NOT NULL AND banned AND revoked_at < NOW() - INTERVAL '90 days'`
  );
  await pool.query('DELETE FROM app_refresh_nonces WHERE expires_at < NOW()');
  await pool.query("DELETE FROM app_device_codes WHERE expires_at < NOW() - INTERVAL '1 day'");
}

/**
 * One sweep, on the one instance that leads (DistributedLeaderService), never overlapping its own
 * previous run: several control plane instances must not all do it, nor pile up when it is slow.
 */
async function runSweep() {
  const { getDistributedLeaderService } = require('./DistributedLeaderService');
  return getDistributedLeaderService().executeAsLeader('app-standing-sweep', async () => {
    await sweepStanding();
    await purgeAppRows();
  });
}

let sweeperTimer = null;
function startSweeper(intervalMs = 60_000) {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    runSweep().catch((err) => logger.warn(`App standing sweep failed: ${err.message}`));
  }, intervalMs);
  sweeperTimer.unref();
}
function stopSweeper() {
  if (sweeperTimer) clearInterval(sweeperTimer);
  sweeperTimer = null;
}

// How far a signed request may be from the console's clock, and how long the previous refresh token
// stays good for a retry after a rotation whose answer never arrived.
//
// The retry window is a day. What makes a retry safe is not the clock but the signature: only the
// device that holds the installation key can sign one, so a stolen token cannot use the window at all.
// The window has to outlast what really happens: a laptop closed on the train with a refresh in
// flight is back the next morning, and an app whose answer was lost twice must still be able to ask a
// third time. A retry replaces the unseen pair, so there is never more than one live chain, and a
// token two rotations old (the app did receive a newer pair) is gone for good.
const SIGNATURE_WINDOW_SECONDS = 60;
const RETRY_WINDOW_SECONDS = 24 * 3600;
const RETIRED_KEPT = 50;
const RETRIED_KEPT = 20;
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

/** The exact bytes an installation signs to sign itself out: the access token is named by its hash. */
function signOutMessage(accessToken, timestamp, nonce) {
  return [
    'NERONET-APP-SIGNOUT-V1',
    'DELETE',
    '/api/app-auth/app/session',
    sha256(accessToken),
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

const signedFields = (body) => {
  const timestamp = body?.timestamp;
  const nonce = typeof body?.nonce === 'string' ? body.nonce : '';
  const signature = typeof body?.signature === 'string' ? body.signature : '';
  const wellFormed =
    Number.isSafeInteger(timestamp) && /^[0-9a-f]{32}$/.test(nonce) && /^[0-9a-f]{128}$/.test(signature);
  const fresh = wellFormed && Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= SIGNATURE_WINDOW_SECONDS;
  return { timestamp, nonce, signature, fresh };
};

async function spendNonce(client, sessionId, nonce) {
  await client.query('DELETE FROM app_refresh_nonces WHERE expires_at < NOW()');
  const spent = await client.query(
    `INSERT INTO app_refresh_nonces (nonce_hash, session_id, expires_at)
     VALUES ($1, $2, NOW() + make_interval(secs => $3)) ON CONFLICT DO NOTHING RETURNING 1`,
    [sha256(`${sessionId}:${nonce}`), sessionId, SIGNATURE_WINDOW_SECONDS * 2]
  );
  return spent.rowCount === 1;
}

/**
 * Rotates the app token. The request must be signed by the installation's Ed25519 key. Anything
 * that is not a fresh, valid, first-time signature (no signature, a wrong key, a skewed clock, a
 * spent nonce, a byte-identical replay) is a plain 401 that changes nothing: a thief holding an old
 * token, or anyone replaying captured bytes, must not be able to sign the real app out.
 *
 * To a request that is validly signed the console says more: the app is suspended (sign in again) or
 * revoked (install again), or the pair is not due (409), so an honest app knows what to do.
 *
 * Only a fresh valid signature over a token that was already replaced is evidence that the key holder
 * itself fell out of step. The immediately previous token is a legitimate retry for a day (a lost
 * answer); one older than that suspends the app; any older token revokes it and removes its node.
 * A pair that is still more than half fresh is not rotated, except by that retry: nobody can use
 * rotation to hide a stolen chain in a stream of early refreshes.
 */
async function refreshTokens(body, { ip }) {
  const unauthorised = new AppAuthError(401, 'invalid_refresh', 'Sign in again');
  const refresh = typeof body?.refresh_token === 'string' ? body.refresh_token : '';
  if (!/^nnr_[0-9a-f]{64}$/.test(refresh)) throw unauthorised;
  const { timestamp, nonce, signature, fresh } = signedFields(body);
  if (!fresh) throw unauthorised;
  const hash = sha256(refresh);

  // Before the lifecycle lock (one line for every writer of nodes) is asked for, the request is checked
  // against the key it claims: whoever cannot sign must not be able to queue for the lock, let alone
  // hold the others up. The same check is made again under the lock, on the row as it is by then.
  const claimed = (
    await getPgPool().query(
      `SELECT signing_public_key FROM app_sessions
        WHERE refresh_hash = $1 OR previous_refresh_hash = $1
           OR $1 = ANY (retired_refresh_hashes) OR $1 = ANY (retried_refresh_hashes)`,
      [hash]
    )
  ).rows[0];
  if (!claimed || !verifyEd25519(claimed.signing_public_key, refreshMessage(refresh, timestamp, nonce), signature))
    throw unauthorised;

  const run = await retryDeadlock(() =>
    EnrollmentService.transaction(async (client) => {
      const out = { tokens: null, outcome: null, session: null, reason: null };
      const found = await client.query(
        `SELECT s.*, u.username, s.refresh_expires_at <= NOW() AS refresh_expired,
                s.absolute_expires_at <= NOW() AS absolute_expired,
                s.rotated_at > NOW() - make_interval(secs => $2) AS within_retry_window,
                s.access_expires_at > NOW() + make_interval(secs => $3) AS access_fresh
           FROM app_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.refresh_hash = $1 OR s.previous_refresh_hash = $1 OR $1 = ANY (s.retired_refresh_hashes)
             OR $1 = ANY (s.retried_refresh_hashes)
          FOR UPDATE OF s`,
        [hash, RETRY_WINDOW_SECONDS, ACCESS_TTL_SECONDS / 2]
      );
      const s = found.rows[0];
      if (!s) return out;
      // Nothing below happens for a request that was not signed, now, by this installation.
      if (!verifyEd25519(s.signing_public_key, refreshMessage(refresh, timestamp, nonce), signature)) return out;
      out.session = s;
      if (s.revoked_at) {
        out.outcome = s.banned ? 'revoked' : 'suspended';
        return out;
      }
      const isCurrent = sameHash(s.refresh_hash, hash);
      const isPrevious = !isCurrent && s.previous_refresh_hash && sameHash(s.previous_refresh_hash, hash);
      if (isCurrent && s.access_fresh) {
        out.outcome = 'not_due';
        return out;
      }
      if (!(await spendNonce(client, s.id, nonce))) return { ...out, session: null };

      const end = async (how, reason) => {
        out.reason = reason;
        if (how === 'ban') {
          await client.query(
            'UPDATE app_sessions SET revoked_at = NOW(), revoked_reason = $2, banned = TRUE WHERE id = $1',
            [s.id, reason]
          );
          if (s.grant_key_id)
            await client.query('UPDATE preauth_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [
              s.grant_key_id
            ]);
          await banKey(client, { ...s, revoked_reason: reason }, reason);
          await cutSessionNode(client, { ...s, revoked_reason: reason }, { reason: 'app_token_reuse', actorId: null });
          out.outcome = 'revoked_now';
        } else {
          await suspendSession(client, s, reason);
          out.outcome = 'suspended_now';
        }
        return out;
      };

      if (!isCurrent && !isPrevious) return end('ban', 'refresh_reuse');
      if (isPrevious && !s.within_retry_window) return end('suspend', 'late_retry');
      if (s.refresh_expired || s.absolute_expired) return end('suspend', 'expired');
      const st = await standing(client, s.user_id, s.organization_id, s.auth_epoch);
      if (!st.ok) return end('suspend', st.reason);

      const tokens = mintTokens();
      // A normal rotation makes the current token the previous one and retires the one before it. A retry
      // keeps the original previous token (so it can be retried again) and files the pair the app never
      // saw in a list of its own, so that retries, however many, never push a real rotation's token out.
      const retired = isPrevious
        ? s.retired_refresh_hashes
        : [...s.retired_refresh_hashes, s.previous_refresh_hash].filter(Boolean).slice(-RETIRED_KEPT);
      const retried = isPrevious
        ? [...s.retried_refresh_hashes, s.refresh_hash].slice(-RETRIED_KEPT)
        : s.retried_refresh_hashes;
      await client.query(
        `UPDATE app_sessions SET previous_refresh_hash = $2, retired_refresh_hashes = $3, refresh_hash = $4,
                access_hash = $5, access_expires_at = NOW() + make_interval(secs => $6),
                refresh_expires_at = LEAST(NOW() + make_interval(secs => $7), absolute_expires_at),
                rotated_at = CASE WHEN $8 THEN rotated_at ELSE NOW() END, last_used_at = NOW(),
                retried_refresh_hashes = $9
          WHERE id = $1`,
        [
          s.id,
          isPrevious ? s.previous_refresh_hash : s.refresh_hash,
          retired,
          sha256(tokens.refresh),
          sha256(tokens.access),
          ACCESS_TTL_SECONDS,
          REFRESH_TTL_SECONDS,
          Boolean(isPrevious),
          retried
        ]
      );
      out.tokens = tokenBody(tokens, s.scopes);
      return out;
    })
  );

  if (run.outcome === 'revoked_now' && run.session) {
    logAuditEvent({
      eventType: 'APP_TOKEN_REUSE_DETECTED',
      organizationId: run.session.organization_id,
      actorUserId: run.session.user_id,
      actorUsername: run.session.username,
      targetId: run.session.id,
      targetType: 'app_session',
      severity: 'warn',
      message: `A replaced refresh token of app session ${run.session.id} was signed and used again; the app was revoked and its node removed`,
      ipAddress: ip
    });
  }
  if (run.outcome === 'suspended_now' && run.session) suspensionAudit(run.session, run.reason, ip);
  if (run.tokens) return run.tokens;
  if (run.outcome === 'not_due') throw new AppAuthError(409, 'refresh_not_due', 'The current pair is still fresh');
  if (run.outcome === 'revoked' || run.outcome === 'revoked_now')
    throw new AppAuthError(401, 'app_revoked', 'This app was removed; install it again');
  if (run.outcome === 'suspended' || run.outcome === 'suspended_now')
    throw new AppAuthError(401, 'app_suspended', 'Sign in again to continue');
  throw unauthorised;
}

/**
 * The app signs itself out. The access token alone is not enough: it travels in every request and a
 * leaked one must not be able to delete the node, so the request carries a signature by the
 * installation's key over the token's hash, a time and a nonce.
 */
async function selfSignOut(session, accessToken, body, { ip }) {
  const { timestamp, nonce, signature, fresh } = signedFields(body);
  const denied = new AppAuthError(401, 'signature_required', 'Signing out needs the installation to sign the request');
  if (!fresh) throw denied;
  const s = (await getPgPool().query('SELECT signing_public_key FROM app_sessions WHERE id = $1', [session.id]))
    .rows[0];
  if (!s || !verifyEd25519(s.signing_public_key, signOutMessage(accessToken, timestamp, nonce), signature))
    throw denied;
  const spent = await retryDeadlock(() =>
    EnrollmentService.transaction((client) => spendNonce(client, session.id, nonce))
  );
  if (!spent) throw denied;
  return revokeSession({ id: session.userId, username: session.username, role: 'user' }, session.id, {
    reason: 'app_signout',
    ip,
    bySelfApp: true
  });
}

// ---------------------------------------------------------------------------------------
// Listing and revoking

/**
 * Removes the node an app session enrolled, inside the caller's transaction, so that revoking the
 * session and cutting the node are one act. The key goes on the revoked list (to every peer, the
 * node's credentials die, the ACL epoch moves) and the node row is removed, except where removing it
 * would do harm that is not the app's to do:
 *   - a node an administrator blocked keeps its row, so signing out cannot erase the block, and its
 *     revoked-key entry never expires, so that unblocking it cannot put it back in a netmap;
 *   - a node that serves profile devices is left alone, as DELETE /api/nodes refuses to remove it;
 *   - a node that is not this session's own (another owner, or another full key behind the same
 *     eight-byte id) is never touched, nor one a newer session of the same installation has taken over.
 */
async function cutSessionNode(client, session, { reason, actorId }) {
  const node = (await client.query('SELECT * FROM nodes WHERE id = $1 FOR UPDATE', [session.node_id])).rows[0];
  if (!node) return { cut: false, why: 'no node' };
  if (node.user_id !== session.user_id || normalisePublicKeyHex(node.public_key) !== session.installation_public_key)
    return { cut: false, why: "not this session's node" };
  const newer = await client.query(
    'SELECT 1 FROM app_sessions WHERE node_id = $1 AND revoked_at IS NULL AND id <> $2 LIMIT 1',
    [session.node_id, session.id]
  );
  if (newer.rows.length > 0 || session.revoked_reason === 'superseded') return { cut: false, why: 'superseded' };
  if (node.profile_gateway_endpoint) return { cut: false, why: 'serves profile devices' };
  await RevocationEngine.revokeNodeKeys([node.id], { reason, actorId, client });
  if (node.is_quarantined) {
    await client.query("UPDATE revoked_keys SET expires_at = 'infinity' WHERE node_id = $1", [node.id]);
    return { cut: true, kept: true };
  }
  await client.query('DELETE FROM nodes WHERE id = $1', [node.id]);
  // The row is gone and the key is banned for good: an open-ended suspension entry left from before ends
  // after the usual 24 hours, enough for every peer to hear of it.
  await client.query(
    "UPDATE revoked_keys SET expires_at = NOW() + INTERVAL '24 hours' WHERE node_id = $1 AND expires_at = 'infinity'",
    [node.id]
  );
  return { cut: true, kept: false };
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
  // revoked: final. suspended: can be put right by approving the app again. superseded: replaced by a
  // newer sign-in of the same installation, history only.
  status: r.revoked_at
    ? r.banned
      ? 'revoked'
      : r.revoked_reason === 'superseded'
        ? 'superseded'
        : 'suspended'
    : new Date(r.refresh_expires_at) <= new Date()
      ? 'expired'
      : 'active'
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
  const done = await retryDeadlock(() =>
    EnrollmentService.transaction(async (client) => {
      const s = (await client.query('SELECT * FROM app_sessions WHERE id = $1 FOR UPDATE', [sessionId])).rows[0];
      const allowed =
        s &&
        (bySelfApp ||
          s.user_id === actor.id ||
          actor.role === 'super-admin' ||
          (isAdministrator(actor) && s.organization_id === orgOf(actor)));
      if (!allowed) throw new AppAuthError(404, 'not_found', 'No such app');
      // A session that a newer sign-in of the same installation replaced is history: revoking it must
      // not ban the key or touch the node the live session stands on.
      if (s.revoked_reason === 'superseded') return { s, first: false, cut: { cut: false, why: 'superseded' } };
      const first = !s.banned;
      const live = { ...s, revoked_reason: s.revoked_at ? s.revoked_reason : reason };
      await client.query(
        `UPDATE app_sessions SET revoked_at = COALESCE(revoked_at, NOW()), revoked_by = $2,
                revoked_reason = CASE WHEN revoked_at IS NULL THEN $3 ELSE revoked_reason END, banned = TRUE
          WHERE id = $1`,
        [s.id, actor.id, reason]
      );
      if (s.grant_key_id)
        await client.query('UPDATE preauth_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [
          s.grant_key_id
        ]);
      await banKey(client, live, reason);
      // Revoked, banned and cut in one transaction. Revoking a session that is already revoked repairs a
      // cut that an earlier version left undone.
      const cut = await cutSessionNode(client, live, { reason: 'app_session_revoked', actorId: actor.id });
      return { s, first, cut };
    })
  );
  if (done.first) {
    const { s, cut } = done;
    logAuditEvent({
      eventType: 'APP_SESSION_REVOKED',
      organizationId: s.organization_id,
      actorUserId: actor.id,
      actorUsername: actor.username,
      targetId: s.id,
      targetType: 'app_session',
      severity: 'warn',
      message: `App session ${s.id} (${s.platform}, "${s.device_name}") revoked by ${actor.username}; its node ${s.node_id} ${cut.cut ? (cut.kept ? 'was cut and kept because it is blocked' : 'was cut and removed') : `was not touched (${cut.why})`}`,
      ipAddress: ip,
      metadata: { reason, node_id: s.node_id, owner: s.user_id }
    });
  }
  return { revoked: true, already: !done.first };
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
  keyWasRevoked,
  nodeAdmission,
  nodeNeedsSignIn,
  suspendUserApps,
  sweepStanding,
  purgeAppRows,
  startSweeper,
  runSweep,
  stopSweeper,
  selfSignOut,
  signOutMessage,
  refreshMessage,
  authenticateApp,
  listSessions,
  revokeSession,
  ownDevices
};
