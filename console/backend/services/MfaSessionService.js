const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { getPgPool } = require('../db');
const Sessions = require('./ConsoleSessionService');
const { SessionAuthorityError, resolveAccessToken } = require('./SessionAuthority');
const { CryptoShreddingService } = require('./CryptoShreddingService');
const TotpService = require('./TotpService');
const MfaPolicy = require('./MfaPolicy');
const Browser = require('./BrowserContextService');

const organization = (user) => user.organization_id || 'org-default';
const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');
const deny = (message = 'Fresh password verification required') => {
  throw new SessionAuthorityError(401, message);
};
const parseCodes = (value) => {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

function verifyJwt(token) {
  try {
    return jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    deny('Invalid or expired token');
  }
}

async function lockedUser(client, id) {
  const result = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id]);
  const user = result.rows[0];
  if (!user || user.status !== 'active') deny('Active account required');
  return user;
}

function requireSnapshot(user, snapshot) {
  if (
    organization(user) !== organization(snapshot) ||
    String(user.console_auth_epoch) !== String(snapshot.console_auth_epoch)
  )
    deny();
}

async function challenge(client, token, decoded, user, lock = false) {
  if (decoded.type !== 'mfa_pending' || !Sessions.validSessionId(decoded.jti) || decoded.sub !== user.id) deny();
  const result = await client.query(
    `SELECT *, expires_at<=clock_timestamp() AS expired
    FROM console_mfa_challenges WHERE id=$1 AND user_id=$2 AND token_hash=$3 ${lock ? 'FOR UPDATE' : ''}`,
    [decoded.jti, user.id, digest(token)]
  );
  const row = result.rows[0];
  if (
    !row ||
    row.consumed_at ||
    row.expired ||
    row.issued_organization_id !== organization(user) ||
    String(row.issued_auth_epoch) !== String(user.console_auth_epoch)
  )
    deny();
  return row;
}

async function fullSession(client, token, decoded, user) {
  const family = await Sessions.lockFamily(client, user.id, decoded.sid);
  const revoked = await client.query(
    `SELECT token_hash FROM access_token_revocations WHERE token_hash=$1
    UNION ALL SELECT token_hash FROM refresh_tokens WHERE (token_hash=$1 OR token_hash=$2)
    AND (revoked=TRUE OR revoked_at IS NOT NULL) LIMIT 1`,
    [digest(token), token]
  );
  if (revoked.rowCount) deny('Token has been revoked');
  return family;
}

// Crypto may provision/rewrap an organization key. Finish it before acquiring the
// account lock; revalidate the sealed value and authentication epoch afterwards.
async function openSecret(user, value) {
  return CryptoShreddingService.openForOrg(user.organization_id, value);
}

// browser: optional { proof, operationId } of a browser-v2 login. Its context is locked
// after the account and before any family/token row, in this same transaction.
async function signIn({ verifiedUser, passwordColumn, accessTier, providedOtp, ipAddress, browser = null }) {
  const secret =
    verifiedUser.totp_enabled && providedOtp ? await openSecret(verifiedUser, verifiedUser.totp_secret) : null;
  return Sessions.transaction(async (client) => {
    const user = await lockedUser(client, verifiedUser.id);
    requireSnapshot(user, verifiedUser);
    if (!passwordColumn || !verifiedUser[passwordColumn] || verifiedUser[passwordColumn] !== user[passwordColumn])
      deny();
    const admitted = browser
      ? await Browser.admitOperation(client, browser.proof, browser.operationId, ['login', 'register'])
      : null;
    if (await MfaPolicy.isMfaRequired(user, client)) {
      if (user.totp_enabled && providedOtp) {
        if (user.totp_secret !== verifiedUser.totp_secret || !TotpService.verifyTotp(String(providedOtp), secret))
          deny('Invalid TOTP code');
        await recordLoginStep(client, user.id, secret, providedOtp);
      } else {
        const id = crypto.randomUUID();
        const token = jwt.sign({ sub: user.id, type: 'mfa_pending' }, config.JWT_SECRET, {
          expiresIn: '5m',
          jwtid: id
        });
        await client.query(
          `INSERT INTO console_mfa_challenges(id,user_id,token_hash,issued_organization_id,
          issued_auth_epoch,access_tier,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            user.id,
            digest(token),
            organization(user),
            user.console_auth_epoch,
            accessTier === 'root' ? 'root' : 'standard',
            new Date(jwt.decode(token).exp * 1000)
          ]
        );
        return { mfa_required: true, mfa_setup_required: !user.totp_enabled, mfa_token: token };
      }
    }
    const session = await Sessions.issueSessionWithClient(client, {
      user: { ...user, compartment_access: accessTier },
      ipAddress
    });
    if (admitted) session.browser = await Browser.recordIssuance(client, admitted, session, { select: false });
    return session;
  });
}

async function resolveCaller(token) {
  try {
    const decoded = verifyJwt(token);
    const passwordStepOnly = decoded.type === 'mfa_pending';
    if (!passwordStepOnly) await resolveAccessToken(token);
    const result = await getPgPool().query('SELECT * FROM users WHERE id=$1', [decoded.sub || decoded.id]);
    const user = result.rows[0];
    if (!user || user.status !== 'active') deny('Active account required');
    if (passwordStepOnly) await challenge(getPgPool(), token, decoded, user);
    return { token, decoded, user, passwordStepOnly };
  } catch (error) {
    if (error instanceof SessionAuthorityError) throw error;
    throw new SessionAuthorityError(503, 'MFA authority unavailable');
  }
}

async function callerLocked(client, caller, browser = null) {
  const decoded = verifyJwt(caller.token); // Recheck expiry after waiting for a SQL lock.
  const user = await lockedUser(client, caller.user.id);
  verifyJwt(caller.token);
  const now = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
  if (decoded.exp && decoded.exp * 1000 <= now) deny('Invalid or expired token');
  requireSnapshot(user, caller.user);
  // Lock order: account -> browser context -> MFA proof -> family -> token.
  const admitted = browser
    ? await Browser.admitOperation(
        client,
        browser.proof,
        browser.operationId,
        caller.passwordStepOnly ? ['login', 'register'] : ['mfa']
      )
    : null;
  const proof = caller.passwordStepOnly
    ? await challenge(client, caller.token, decoded, user, true)
    : await fullSession(client, caller.token, decoded, user);
  return { user, proof, decoded, now, admitted };
}

async function setup(caller, currentCode, { returnAuditContext = false } = {}) {
  const priorSecret = caller.user.totp_enabled ? await openSecret(caller.user, caller.user.totp_secret) : null;
  const secret = TotpService.generateSecret(20);
  const qr = await TotpService.generateQrCode(caller.user.username, secret);
  const recoveryCodes = TotpService.generateRecoveryCodes(8);
  const sealed = await CryptoShreddingService.sealForOrg(caller.user.organization_id, secret);
  const auditUser = await Sessions.transaction(async (client) => {
    const { user, proof, decoded, now } = await callerLocked(client, caller);
    if (user.totp_enabled) {
      if (caller.passwordStepOnly)
        throw new SessionAuthorityError(
          409,
          'An authenticator is already enrolled. Sign in with it, then replace it from your account.'
        );
      if (
        user.totp_secret !== caller.user.totp_secret ||
        !currentCode ||
        !TotpService.verifyTotp(String(currentCode), priorSecret)
      )
        deny('A current code from the enrolled authenticator is required');
    }
    const proofId = caller.passwordStepOnly ? decoded.jti : decoded.sid;
    const proofType = caller.passwordStepOnly ? 'challenge' : 'session';
    const expiresAt = new Date(
      Math.min(decoded.exp ? decoded.exp * 1000 : Infinity, new Date(proof.expires_at).getTime(), now + 10 * 60 * 1000)
    );
    // Repeating setup from the same proof replaces its QR. A separate sign-in
    // cannot overwrite an enrollment that is still being confirmed.
    if (
      user.totp_pending_proof_id &&
      user.totp_pending_proof_id !== proofId &&
      new Date(user.totp_pending_expires_at).getTime() > now
    )
      throw new SessionAuthorityError(409, 'An authenticator setup is already pending in another sign-in');
    await client.query(
      `UPDATE users SET totp_pending_secret=$2,totp_pending_recovery_codes=$3::jsonb,
      totp_pending_proof_id=$4,totp_pending_proof_type=$5,totp_pending_expires_at=$6,totp_pending_auth_epoch=$7 WHERE id=$1`,
      [
        user.id,
        sealed,
        JSON.stringify(recoveryCodes.map((code) => TotpService.hashRecoveryCode(code))),
        proofId,
        proofType,
        expiresAt,
        user.console_auth_epoch
      ]
    );
    return {
      id: user.id,
      username: user.username,
      organization_id: user.organization_id,
      totp_enabled: user.totp_enabled
    };
  });
  const setup = { secret, ...qr, recoveryCodes };
  return returnAuditContext ? { setup, auditUser } : setup;
}

async function complete(caller, { code, recovery_code, ipAddress }, browser = null) {
  const confirmingPending = !(caller.passwordStepOnly && caller.user.totp_enabled);
  const sealed = confirmingPending ? caller.user.totp_pending_secret : caller.user.totp_secret;
  const secret = recovery_code && !confirmingPending ? null : await openSecret(caller.user, sealed);
  return Sessions.transaction(async (client) => {
    const { user, proof, decoded, now, admitted } = await callerLocked(client, caller, browser);
    let sessionUser = user;
    if (confirmingPending) {
      if (!user.totp_pending_secret) throw new SessionAuthorityError(400, 'No authenticator is being enrolled');
      const proofId = caller.passwordStepOnly ? decoded.jti : decoded.sid;
      const type = caller.passwordStepOnly ? 'challenge' : 'session';
      if (
        user.totp_pending_proof_id !== proofId ||
        user.totp_pending_proof_type !== type ||
        String(user.totp_pending_auth_epoch) !== String(user.console_auth_epoch) ||
        !user.totp_pending_expires_at ||
        new Date(user.totp_pending_expires_at).getTime() <= now
      )
        deny('Authenticator setup expired or belongs to another sign-in');
      if (!code) throw new SessionAuthorityError(400, 'Missing code');
      if (sealed !== user.totp_pending_secret || !TotpService.verifyTotp(String(code), secret))
        deny('Invalid TOTP code');
      const updated = await client.query(
        `UPDATE users SET totp_secret=totp_pending_secret,
        totp_recovery_codes=COALESCE(totp_pending_recovery_codes,'[]'::jsonb),totp_enabled=TRUE,
        totp_pending_secret=NULL,totp_pending_recovery_codes=NULL,totp_pending_proof_id=NULL,
        totp_pending_proof_type=NULL,totp_pending_expires_at=NULL,totp_pending_auth_epoch=NULL WHERE id=$1 RETURNING *`,
        [user.id]
      );
      sessionUser = updated.rows[0];
    } else if (recovery_code) {
      const consumed = TotpService.verifyAndConsumeRecoveryCode(recovery_code, parseCodes(user.totp_recovery_codes));
      if (!consumed.valid) deny('Invalid recovery code');
      await client.query('UPDATE users SET totp_recovery_codes=$2::jsonb WHERE id=$1', [
        user.id,
        JSON.stringify(consumed.remainingCodes)
      ]);
    } else if (code) {
      if (sealed !== user.totp_secret || !TotpService.verifyTotp(String(code), secret)) deny('Invalid TOTP code');
      await recordLoginStep(client, user.id, secret, code);
    } else throw new SessionAuthorityError(400, 'Missing code or recovery_code');

    let session;
    if (caller.passwordStepOnly) {
      const result = await client.query(
        'UPDATE console_mfa_challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL',
        [proof.id]
      );
      if (result.rowCount !== 1) deny();
      session = await Sessions.issueSessionWithClient(client, {
        user: { ...sessionUser, compartment_access: proof.access_tier },
        ipAddress
      });
    } else {
      session = await Sessions.changeRootGrantWithClient(client, {
        userId: user.id,
        sessionId: decoded.sid,
        root: false,
        ipAddress
      });
    }
    // A sign-in yields a candidate; rotating the selected session selects atomically.
    if (admitted)
      session.browser = await Browser.recordIssuance(client, admitted, session, { select: !caller.passwordStepOnly });
    return { session, confirmingPending };
  });
}

// A fresh second-factor proof for a person who is already signed in, for one sensitive step
// (approving an app). It opens no session. It is judged in two parts so that it can be part of the
// caller's transaction: prepareFreshProof runs first and may touch the organisation's key (it must
// finish before the account lock is taken), applyFreshProof runs inside the transaction, with the
// account locked, and spends what the proof spends (a recovery code, or the time step of a code)
// there. If the transaction then fails for any other reason nothing was spent.
//
// Results: 'ok', 'required' (no code given), 'invalid' (wrong, or a code already used once), and
// 'setup' (the account must have a second factor and has none enrolled).
async function prepareFreshProof(userId) {
  const snapshot = (await getPgPool().query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
  if (!snapshot || snapshot.status !== 'active') return { state: 'invalid' };
  if (!(await MfaPolicy.isMfaRequired(snapshot))) return { state: 'ok' };
  if (!snapshot.totp_enabled) return { state: 'setup' };
  return { state: 'needed', sealed: snapshot.totp_secret, secret: await openSecret(snapshot, snapshot.totp_secret) };
}

const TOTP_STEP_MS = 30000;

/** The time step a code belongs to (the console accepts one step either side), or null. */
function totpStepOf(secret, code) {
  const counter = Math.floor(Date.now() / TOTP_STEP_MS);
  const clean = String(code).trim();
  for (let i = -1; i <= 1; i++) {
    if (TotpService.generateTotp(secret, { time: (counter + i) * TOTP_STEP_MS }) === clean) return counter + i;
  }
  return null;
}

/**
 * A code used to sign in is recorded too, so that it cannot then approve an app. Two sign-ins with the
 * same code at the same moment both pass (the step only moves forward), and a later step is never
 * held back by an earlier one.
 */
async function recordLoginStep(client, userId, secret, code) {
  const step = totpStepOf(secret, code);
  if (step === null) return;
  await client.query(
    'UPDATE users SET totp_last_used_step = GREATEST(COALESCE(totp_last_used_step, 0), $2) WHERE id = $1',
    [userId, step]
  );
}

async function applyFreshProof(client, userId, prepared, { code, recovery_code } = {}) {
  if (prepared.state === 'ok') return 'ok';
  if (prepared.state === 'setup') return 'setup';
  if (prepared.state !== 'needed') return 'invalid';
  const hasCode = typeof code === 'string' && code.length > 0;
  const hasRecovery = typeof recovery_code === 'string' && recovery_code.length > 0;
  if (!hasCode && !hasRecovery) return 'required';
  const user = await lockedUser(client, userId);
  // The factor must be the one the secret was opened for.
  if (!user.totp_enabled || user.totp_secret !== prepared.sealed) return 'invalid';
  if (hasRecovery) {
    const consumed = TotpService.verifyAndConsumeRecoveryCode(recovery_code, parseCodes(user.totp_recovery_codes));
    if (!consumed.valid) return 'invalid';
    await client.query('UPDATE users SET totp_recovery_codes=$2::jsonb WHERE id=$1', [
      userId,
      JSON.stringify(consumed.remainingCodes)
    ]);
    return 'ok';
  }
  const matched = totpStepOf(prepared.secret, code);
  if (matched === null) return 'invalid';
  // A code is good once: the step must be later than the last one accepted for this account.
  const spent = await client.query(
    'UPDATE users SET totp_last_used_step=$2 WHERE id=$1 AND (totp_last_used_step IS NULL OR totp_last_used_step < $2)',
    [userId, matched]
  );
  return spent.rowCount === 1 ? 'ok' : 'invalid';
}

module.exports = { signIn, resolveCaller, setup, complete, prepareFreshProof, applyFreshProof };
