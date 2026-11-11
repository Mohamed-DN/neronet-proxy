/**
 * Invitations into an organisation.
 *
 * An administrator creates an invitation; the person it is meant for opens the link (or
 * types the short code) from anywhere and chooses their own username and password.
 * Public registration stays closed: the invitation is the only door, and it is shaped
 * like a password rather than like a URL.
 *
 * - The token is 32 random bytes, sent as base64url in the fragment of the link, so no
 *   proxy or access log sees it. The short code (12 Crockford base32 characters, 60 bits)
 *   is derived from the token, so both name the same secret. Neither is stored: the
 *   token as SHA-256, the code as a slow scrypt, because 60 bits are within reach of an
 *   offline search and a fast hash would hand a copy of the table an invitation.
 * - Accepting is single use in one SQL statement (UPDATE ... WHERE used_at IS NULL AND
 *   revoked_at IS NULL AND expires_at > now() RETURNING), and the account, its membership
 *   and the spent invitation are written in one transaction.
 * - Every unusable secret (unknown, malformed, expired, used, revoked, or issued by
 *   someone who has since lost the right to issue it) gets the same answer.
 * - Delegation cap (ADR 0030 §5, "you cannot give what you do not have"): an actor
 *   invites only into a role at or below their own; owner is never invitable.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const bcrypt = require('bcryptjs');
const { getPgPool } = require('../db/index');

const scrypt = promisify(crypto.scrypt);

const ROLE_RANK = { owner: 5, admin: 4, network_admin: 3, auditor: 2, member: 1 };
const INVITABLE_ROLES = ['admin', 'network_admin', 'auditor', 'member'];
const ISSUING_ROLES = ['owner', 'admin'];
// The platform super-admin is above every organisation role; owner stays out of reach
// because it is not invitable at all.
const PLATFORM_RANK = ROLE_RANK.owner;

const DEFAULT_LIFETIME_DAYS = 7;
const MAX_LIFETIME_DAYS = 30;
const MAX_HINT_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 1024;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

const CODE_LABEL = 'neronet-invitation-code-v1';
// N=2^14, r=8: 16 MiB and tens of milliseconds per attempt. Online guessing is bounded
// by the per-address limiter; this cost is for the offline case.
const SCRYPT_OPTIONS = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

class InvitationError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// One answer for every secret that does not open an invitation, whatever the reason.
const INVALID = Object.freeze({
  error: 'invitation_invalid',
  message: 'This invitation cannot be used. Ask the person who invited you for a new one.'
});

function invalid() {
  return new InvitationError(400, INVALID.error, INVALID.message);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** The 12-character code a person can type, derived from the token. */
function deriveCode(token) {
  const digest = crypto.createHash('sha256').update(`${CODE_LABEL}\0${token}`).digest();
  let bits = digest.readBigUInt64BE(0) >> 4n; // 60 bits
  let out = '';
  for (let i = 0; i < 12; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

/**
 * A typed code as Crockford base32 reads it: case, spaces and dashes do not matter, O is
 * 0 and I or L is 1. Anything that is not then twelve symbols of the alphabet is null.
 */
function normaliseCode(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_PATTERN.test(code) ? code : null;
}

async function codeHash(normalisedCode) {
  const key = await scrypt(normalisedCode, CODE_LABEL, 32, SCRYPT_OPTIONS);
  return key.toString('hex');
}

function canInviteInto(rank, role) {
  return INVITABLE_ROLES.includes(role) && ROLE_RANK[role] <= rank;
}

/**
 * How far the actor may delegate in this organisation. 404 when the organisation does not
 * exist or the actor is not in it (another organisation is not told this one exists), 403
 * for a member whose role may not invite.
 */
async function issuerRank(client, actorId, orgId) {
  const res = await client.query(
    `SELECT u.role AS platform_role, m.role AS org_role,
            EXISTS (SELECT 1 FROM organizations o WHERE o.id = $2) AS org_exists
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2
      WHERE u.id = $1`,
    [actorId, orgId]
  );
  const row = res.rows[0];
  if (!row || !row.org_exists) throw new InvitationError(404, 'not_found', 'Organization not found');
  if (row.platform_role === 'super-admin') return PLATFORM_RANK;
  if (!row.org_role) throw new InvitationError(404, 'not_found', 'Organization not found');
  if (!ISSUING_ROLES.includes(row.org_role)) {
    throw new InvitationError(403, 'forbidden', 'Only an owner or an administrator can invite people');
  }
  return ROLE_RANK[row.org_role];
}

const STATUS_SQL = `CASE
    WHEN i.used_at IS NOT NULL THEN 'used'
    WHEN i.revoked_at IS NOT NULL THEN 'revoked'
    WHEN i.expires_at <= now() THEN 'expired'
    ELSE 'pending' END`;

const PUBLIC_COLUMNS = `i.id, i.organization_id, i.role, i.display_name_hint, i.created_by,
    i.created_at, i.expires_at, i.used_at, i.used_by, i.revoked_at, i.revoked_by,
    ${STATUS_SQL} AS status`;

function readLifetime(body) {
  if (body.expires_in_days === undefined) return DEFAULT_LIFETIME_DAYS;
  const days = body.expires_in_days;
  if (!Number.isInteger(days) || days < 1 || days > MAX_LIFETIME_DAYS) {
    throw new InvitationError(
      400,
      'invalid_lifetime',
      `expires_in_days must be a whole number from 1 to ${MAX_LIFETIME_DAYS}`
    );
  }
  return days;
}

function readHint(body) {
  const hint = body.display_name_hint;
  if (hint === undefined || hint === null) return null;
  if (typeof hint !== 'string') throw new InvitationError(400, 'invalid_hint', 'display_name_hint must be text');
  // Control characters have no place in a name and would reach every list and log line.
  const clean = hint.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (clean.length > MAX_HINT_LENGTH) {
    throw new InvitationError(400, 'invalid_hint', `display_name_hint is longer than ${MAX_HINT_LENGTH} characters`);
  }
  return clean || null;
}

async function create({ actorId, orgId, body = {} }) {
  const pool = getPgPool();
  const rank = await issuerRank(pool, actorId, orgId);

  const role = body.role === undefined ? 'member' : body.role;
  if (typeof role !== 'string' || !INVITABLE_ROLES.includes(role)) {
    throw new InvitationError(400, 'invalid_role', 'role must be one of admin, network_admin, auditor, member');
  }
  if (!canInviteInto(rank, role)) {
    throw new InvitationError(403, 'exceeds_your_access', 'You cannot invite someone into a role above your own');
  }
  const days = readLifetime(body);
  const hint = readHint(body);

  const token = crypto.randomBytes(32).toString('base64url');
  const code = deriveCode(token);
  const id = `inv-${crypto.randomUUID()}`;

  const res = await pool.query(
    `INSERT INTO invitations AS i (id, organization_id, token_hash, code_hash, role, display_name_hint,
                                   created_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() + make_interval(days => $8))
     RETURNING ${PUBLIC_COLUMNS}`,
    [id, orgId, sha256Hex(token), await codeHash(code), role, hint, actorId, days]
  );
  return { invitation: res.rows[0], token, code: formatCode(code) };
}

async function list({ actorId, orgId, limit, offset }) {
  const pool = getPgPool();
  await issuerRank(pool, actorId, orgId);
  const total = (await pool.query('SELECT count(*)::int AS n FROM invitations WHERE organization_id = $1', [orgId]))
    .rows[0].n;
  const res = await pool.query(
    `SELECT ${PUBLIC_COLUMNS}, cu.username AS created_by_username, uu.username AS used_by_username
       FROM invitations i
       LEFT JOIN users cu ON cu.id = i.created_by
       LEFT JOIN users uu ON uu.id = i.used_by
      WHERE i.organization_id = $1
      ORDER BY i.created_at DESC, i.id
      LIMIT $2 OFFSET $3`,
    [orgId, limit, offset]
  );
  return { invitations: res.rows, total };
}

async function revoke({ actorId, orgId, invitationId }) {
  const pool = getPgPool();
  const rank = await issuerRank(pool, actorId, orgId);
  const found = await pool.query('SELECT role FROM invitations WHERE id = $1 AND organization_id = $2', [
    invitationId,
    orgId
  ]);
  if (found.rows.length === 0) throw new InvitationError(404, 'not_found', 'Invitation not found');
  // Revoking is granting in reverse (ADR 0030 D5): only someone who could have issued it.
  if (!canInviteInto(rank, found.rows[0].role)) {
    throw new InvitationError(
      403,
      'exceeds_your_access',
      'You cannot withdraw an invitation into a role above your own'
    );
  }
  const res = await pool.query(
    `UPDATE invitations AS i SET revoked_at = now(), revoked_by = $3
      WHERE i.id = $1 AND i.organization_id = $2 AND i.used_at IS NULL AND i.revoked_at IS NULL
      RETURNING ${PUBLIC_COLUMNS}`,
    [invitationId, orgId, actorId]
  );
  if (res.rows.length === 0) {
    throw new InvitationError(409, 'not_pending', 'The invitation was already used or withdrawn');
  }
  return res.rows[0];
}

/**
 * Validates the fields of an acceptance before the secret is looked at, so a malformed
 * request never learns anything about the invitation. Returns which column to match and
 * the raw secret, or throws.
 */
function readAcceptance(body) {
  const { username, password } = body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || password.length === 0) {
    throw new InvitationError(400, 'missing_fields', 'A username and a password are required');
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new InvitationError(
      400,
      'invalid_username',
      'A username is 3 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit'
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new InvitationError(400, 'invalid_password', 'The password is too long');
  }
  const hasToken = body.token !== undefined;
  const hasCode = body.code !== undefined;
  if (hasToken === hasCode) {
    throw new InvitationError(400, 'missing_fields', 'Send either the link token or the short code');
  }
  return { username, password, kind: hasToken ? 'token' : 'code', secret: hasToken ? body.token : body.code };
}

async function secretHash(kind, secret) {
  if (kind === 'token') {
    return typeof secret === 'string' && TOKEN_PATTERN.test(secret) ? sha256Hex(secret) : null;
  }
  const code = normaliseCode(secret);
  return code ? await codeHash(code) : null;
}

async function issuerStillEntitled(client, invitation) {
  if (!invitation.created_by) return false;
  try {
    const rank = await issuerRank(client, invitation.created_by, invitation.organization_id);
    return canInviteInto(rank, invitation.role);
  } catch (err) {
    if (err instanceof InvitationError) return false;
    throw err;
  }
}

async function accept(body) {
  const { username, password, kind, secret } = readAcceptance(body);
  const hash = await secretHash(kind, secret);
  if (!hash) throw invalid();
  const column = kind === 'token' ? 'token_hash' : 'code_hash';

  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The single-use gate. Concurrent acceptances of one invitation queue on its row
    // lock; after the first commits, the others no longer match and get nothing.
    const spent = await client.query(
      `UPDATE invitations SET used_at = now()
        WHERE ${column} = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        RETURNING id, organization_id, role, created_by`,
      [hash]
    );
    const invitation = spent.rows[0];
    if (!invitation || !(await issuerStillEntitled(client, invitation))) {
      await client.query('ROLLBACK');
      throw invalid();
    }

    const userId = `usr-${crypto.randomBytes(8).toString('hex')}`;
    const passwordHash = await bcrypt.hash(password, 10);
    const created = await client.query(
      `INSERT INTO users (id, username, email, password_hash, role, status, bypass_apps, organization_id)
       VALUES ($1, $2, $3, $4, 'user', 'active', '[]'::jsonb, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [userId, username, `${username}@sovereign.local`, passwordHash, invitation.organization_id]
    );
    if (created.rows.length === 0) {
      // The invitation is not spent: the person picks another name and tries again.
      await client.query('ROLLBACK');
      throw new InvitationError(409, 'username_taken', 'That username is already in use. Choose another one.');
    }
    await client.query('INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)', [
      `mem-${crypto.randomBytes(8).toString('hex')}`,
      userId,
      invitation.organization_id,
      invitation.role
    ]);
    await client.query('UPDATE invitations SET used_by = $2 WHERE id = $1', [invitation.id, userId]);
    await client.query('COMMIT');
    return { invitation, user: { id: userId, username } };
  } catch (err) {
    if (!(err instanceof InvitationError)) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  create,
  list,
  revoke,
  accept,
  InvitationError,
  INVALID,
  INVITABLE_ROLES,
  // Exposed for tests.
  deriveCode,
  normaliseCode,
  formatCode
};
