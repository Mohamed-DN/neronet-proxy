const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getPgPool } = require('../db');
const { signToken, signRefreshToken, signRefreshTokenUntil } = require('./ConsoleTokens');
const { SessionAuthorityError } = require('./SessionAuthority');

const validSessionId = (id) =>
  typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function transaction(work) {
  let client;
  try {
    client = await getPgPool().connect();
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error instanceof SessionAuthorityError) throw error;
    throw new SessionAuthorityError(503, 'Session authority unavailable');
  } finally {
    client?.release();
  }
}

async function currentUser(client, userId) {
  // Every transition locks the account before the family, including logout.
  const result = await client.query('SELECT * FROM users WHERE id=$1 FOR SHARE', [userId]);
  const user = result.rows[0];
  if (!user || user.status !== 'active') throw new SessionAuthorityError(401, 'Account inactive or suspended');
  return user;
}

async function lockFamily(client, userId, sessionId) {
  if (!validSessionId(sessionId)) throw new SessionAuthorityError(401, 'Fresh sign-in required');
  const result = await client.query(
    'SELECT *, expires_at<=clock_timestamp() AS expired FROM console_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
    [sessionId, userId]
  );
  const family = result.rows[0];
  if (!family || family.revoked_at || family.expired)
    throw new SessionAuthorityError(401, 'Session expired or revoked');
  return family;
}

function principal(user, family, root) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    organization_id: user.organization_id || 'org-default',
    compartment_access: root ? 'root' : 'standard',
    sid: family.id,
    ...(root ? { root_grant_id: family.root_grant_id } : {})
  };
}

async function persistPair(client, user, family, ipAddress, root = false) {
  const payload = principal(user, family, root);
  const remaining = Math.floor(new Date(family.expires_at).getTime() / 1000) - Math.floor(Date.now() / 1000);
  if (remaining <= 0) throw new SessionAuthorityError(401, 'Session expired');
  const token = signToken(payload);
  // Refresh rotation cannot extend the absolute lifetime established at sign-in.
  const refreshToken = signRefreshTokenUntil(payload, family.expires_at);
  const expiry = new Date(jwt.decode(refreshToken).exp * 1000);
  await client.query(
    `INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at,ip_address,revoked,revoked_at,session_id)
     VALUES($1,$2,$3,$4,$5,FALSE,NULL,$6)`,
    [
      `tok-${uuidv4()}`,
      user.id,
      crypto.createHash('sha256').update(refreshToken).digest('hex'),
      expiry,
      ipAddress || '127.0.0.1',
      family.id
    ]
  );
  if (root) {
    await client.query('UPDATE console_sessions SET root_grant_expires_at=$2 WHERE id=$1', [
      family.id,
      new Date(Math.min(jwt.decode(token).exp * 1000, new Date(family.expires_at).getTime()))
    ]);
  }
  const { sid, root_grant_id, ...visibleUser } = payload;
  return { token, refreshToken, user: visibleUser };
}

async function issueSession({ user: verifiedUser, ipAddress }) {
  return transaction((client) => issueSessionWithClient(client, { user: verifiedUser, ipAddress }));
}

// MFA consumption and session creation must commit on the same connection.
// The caller owns the transaction; this function never commits or acquires a pool client.
async function issueSessionWithClient(client, { user: verifiedUser, ipAddress }) {
  const user = await currentUser(client, verifiedUser.id);
  const organization = user.organization_id || 'org-default';
  const root =
    verifiedUser.compartment_access === 'root' &&
    (verifiedUser.organization_id || 'org-default') === organization &&
    verifiedUser.password_hash_root === user.password_hash_root;
  const family = { id: uuidv4(), root_grant_id: root ? uuidv4() : null };
  const initialRefresh = signRefreshToken(principal(user, family, root));
  family.expires_at = new Date(jwt.decode(initialRefresh).exp * 1000);
  await client.query(
    `INSERT INTO console_sessions(id,user_id,issued_organization_id,expires_at,root_grant_id,root_grant_expires_at,root_organization_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      family.id,
      user.id,
      organization,
      family.expires_at,
      family.root_grant_id,
      root ? family.expires_at : null,
      root ? organization : null
    ]
  );
  return persistPair(client, user, family, ipAddress, root);
}

async function revokeFamily(client, userId, sessionId, reason) {
  await client.query('UPDATE console_sessions SET revoked_at=NOW(), revocation_reason=$3 WHERE id=$1 AND user_id=$2', [
    sessionId,
    userId,
    reason
  ]);
  await client.query('UPDATE refresh_tokens SET revoked=TRUE,revoked_at=NOW() WHERE session_id=$1 AND user_id=$2', [
    sessionId,
    userId
  ]);
}

async function rotateSession({ decoded, refreshToken, ipAddress }) {
  const userId = decoded.sub || decoded.id;
  if (!validSessionId(decoded.sid) || typeof userId !== 'string')
    throw new SessionAuthorityError(401, 'Fresh sign-in required');
  return transaction(async (client) => {
    const user = await currentUser(client, userId);
    const family = await lockFamily(client, userId, decoded.sid);
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const result = await client.query(
      `SELECT *,expires_at<=clock_timestamp() AS expired FROM refresh_tokens
       WHERE user_id=$1 AND session_id=$2 AND token_hash=$3 FOR UPDATE`,
      [userId, family.id, hash]
    );
    const credential = result.rows[0];
    if (!credential) throw new SessionAuthorityError(401, 'Refresh token not recognized');
    if (credential.revoked || credential.revoked_at) {
      await revokeFamily(client, userId, family.id, 'refresh_replay');
      // Returning an error decision commits the revocation; throwing would roll it back.
      return { replay: true, userId };
    }
    if (credential.expired) throw new SessionAuthorityError(401, 'Refresh token expired');
    const consumed = await client.query(
      'UPDATE refresh_tokens SET revoked=TRUE,revoked_at=NOW() WHERE id=$1 AND revoked=FALSE AND revoked_at IS NULL',
      [credential.id]
    );
    if (consumed.rowCount !== 1) throw new SessionAuthorityError(401, 'Refresh token already used');
    await client.query(
      'UPDATE console_sessions SET root_grant_id=NULL,root_grant_expires_at=NULL,root_organization_id=NULL WHERE id=$1',
      [family.id]
    );
    return persistPair(client, user, family, ipAddress);
  });
}

async function changeRootGrant({ userId, sessionId, root, verifiedRootHash, organizationIdAtIssue, ipAddress }) {
  return transaction((client) =>
    changeRootGrantWithClient(client, {
      userId,
      sessionId,
      root,
      verifiedRootHash,
      organizationIdAtIssue,
      ipAddress
    })
  );
}

async function changeRootGrantWithClient(
  client,
  { userId, sessionId, root, verifiedRootHash, organizationIdAtIssue, ipAddress }
) {
  const user = await currentUser(client, userId);
  const family = await lockFamily(client, userId, sessionId);
  if (
    root &&
    (!verifiedRootHash ||
      user.password_hash_root !== verifiedRootHash ||
      organizationIdAtIssue !== (user.organization_id || 'org-default'))
  ) {
    throw new SessionAuthorityError(401, 'Fresh vault password verification required');
  }
  family.root_grant_id = root ? uuidv4() : null;
  await client.query(
    'UPDATE console_sessions SET root_grant_id=$2,root_grant_expires_at=$3,root_organization_id=$4 WHERE id=$1',
    [
      family.id,
      family.root_grant_id,
      root ? family.expires_at : null,
      root ? user.organization_id || 'org-default' : null
    ]
  );
  await client.query('UPDATE refresh_tokens SET revoked=TRUE,revoked_at=NOW() WHERE session_id=$1 AND user_id=$2', [
    family.id,
    userId
  ]);
  return persistPair(client, user, family, ipAddress, root);
}

async function revokeUserSessions(userId) {
  return transaction(async (client) => {
    // Exclusive account admission serializes the cut with creation of new families.
    const user = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    if (!user.rowCount) throw new SessionAuthorityError(404, 'User not found');
    await client.query(
      `UPDATE users SET console_auth_epoch=console_auth_epoch+1,
      totp_pending_secret=NULL,totp_pending_recovery_codes=NULL,
      totp_pending_proof_id=NULL,totp_pending_proof_type=NULL,
      totp_pending_expires_at=NULL,totp_pending_auth_epoch=NULL WHERE id=$1`,
      [userId]
    );
    await client.query('SELECT id FROM console_sessions WHERE user_id=$1 ORDER BY id FOR UPDATE', [userId]);
    await client.query(
      `UPDATE console_sessions SET revoked_at=COALESCE(revoked_at,NOW()),
       revocation_reason=COALESCE(revocation_reason,'account_revocation') WHERE user_id=$1`,
      [userId]
    );
    const result = await client.query(
      'UPDATE refresh_tokens SET revoked=TRUE,revoked_at=NOW() WHERE user_id=$1 AND (revoked=FALSE OR revoked IS NULL)',
      [userId]
    );
    return result.rowCount || 0;
  });
}

module.exports = {
  issueSession,
  issueSessionWithClient,
  rotateSession,
  changeRootGrant,
  changeRootGrantWithClient,
  revokeUserSessions,
  transaction,
  currentUser,
  lockFamily,
  revokeFamily,
  validSessionId
};
