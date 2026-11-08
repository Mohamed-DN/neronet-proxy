const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { getPgPool } = require('../db');
const Sessions = require('./ConsoleSessionService');
const { SessionAuthorityError } = require('./SessionAuthority');

const maximumIntent = 18446744073709551615n;
const maximumOperationsPerContext = 64;
const kinds = new Set(['login', 'register', 'mfa', 'refresh', 'lock', 'unlock', 'logout']);
const bindingCookieName = (id) => `nn_ctx_${id}`;
const reject = (status, message, code = null) => {
  throw new SessionAuthorityError(status, message, code);
};
// A session change, distinct from an ordinary 409 conflict of some resource.
const selectionChanged = () => reject(409, 'Browser selection changed', 'browser_selection_changed');
const digest = (value) => crypto.createHash('sha256').update(value).digest();

function requestOrigin(req) {
  if (req.get('X-NeroNet-Browser-Protocol') !== '2') reject(400, 'Unsupported browser protocol');
  const origin = req.get('Origin');
  // The general CORS adapter is not this protocol's CSRF/admission authority.
  // Only explicit configured origins are accepted; '*' is never a browser grant.
  if (!origin || !config.CORS_ORIGINS.filter((value) => value !== '*').includes(origin))
    reject(403, 'Browser origin is not allowed');
  return origin;
}

function proofFromRequest(req, id = req.get('X-NeroNet-Browser-Context')) {
  const origin = requestOrigin(req);
  if (!Sessions.validSessionId(id)) reject(400, 'Invalid browser context');
  const canonicalId = id.toLowerCase();
  return { id: canonicalId, origin, binding: req.cookies?.[bindingCookieName(canonicalId)] || null };
}

function checkBinding(context, proof, missingStatus = 401) {
  if (!proof.binding) reject(missingStatus, 'Browser context binding required');
  if (!/^[a-f0-9]{64}$/.test(proof.binding)) reject(401, 'Invalid browser context binding');
  if (!crypto.timingSafeEqual(digest(proof.binding), Buffer.from(context.binding_hash, 'hex')))
    reject(401, 'Invalid browser context binding');
  if (context.origin !== proof.origin) reject(403, 'Browser context origin changed');
  if (context.expired) reject(401, 'Browser context expired');
}

async function lockedContext(client, proof, missingStatus = 401) {
  const result = await client.query(
    `SELECT c.*, c.latest_intent::text AS latest_intent,
       c.expires_at<=clock_timestamp() AS expired, i.session_id AS selected_session_id
       FROM console_browser_contexts c
       LEFT JOIN console_browser_issuances i ON i.context_id=c.id AND i.id=c.selected_issuance_id
       WHERE c.id=$1 FOR UPDATE OF c`,
    [proof.id]
  );
  const context = result.rows[0];
  if (!context) reject(401, 'Browser context not found');
  // A SELECT projection can precede its LockRows wait. Evaluate expiry again
  // after acquiring the lock so an admission cannot outlive the context lease.
  context.expired = (
    await client.query('SELECT expires_at<=clock_timestamp() AS expired FROM console_browser_contexts WHERE id=$1', [
      proof.id
    ])
  ).rows[0].expired;
  checkBinding(context, proof, missingStatus);
  return context;
}

function snapshot(context) {
  return {
    context_id: context.id,
    latest_intent: context.latest_intent,
    selected: context.selected_issuance_id
      ? { sid: context.selected_session_id, issuance_id: context.selected_issuance_id }
      : null
  };
}

async function bootstrap(proof) {
  return Sessions.transaction(async (client) => {
    // Bounded sweep of expired contexts; their operations and issuances cascade.
    await client.query(
      `DELETE FROM console_browser_contexts WHERE id IN (
         SELECT id FROM console_browser_contexts WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100)`
    );
    const binding = crypto.randomBytes(32).toString('hex');
    const created = await client.query(
      `INSERT INTO console_browser_contexts(id,binding_hash,origin) VALUES($1,$2,$3)
       ON CONFLICT(id) DO NOTHING RETURNING id`,
      [proof.id, digest(binding).toString('hex'), proof.origin]
    );
    if (created.rowCount) {
      const context = await lockedContext(client, { ...proof, binding });
      return { context: snapshot(context), binding };
    }
    // A public ID never recovers the coordination credential. A lost bootstrap
    // without its cookie requires a new context, not a replacement of the old one.
    const context = await lockedContext(client, proof, 409);
    return { context: snapshot(context), binding: null };
  });
}

async function readBoundContext(proof) {
  return Sessions.transaction(async (client) => ({
    context: snapshot(await lockedContext(client, proof)),
    binding: null
  }));
}

function operationInput(body) {
  if (!body || !Sessions.validSessionId(body.operation_id)) reject(400, 'Invalid browser operation');
  if (typeof body.intent !== 'string' || !/^[1-9][0-9]{0,19}$/.test(body.intent))
    reject(400, 'Browser intent must be a canonical decimal string');
  if (BigInt(body.intent) > maximumIntent) reject(400, 'Browser intent exceeds the supported range');
  if (!kinds.has(body.kind)) reject(400, 'Unsupported browser operation');
  if (body.expected_issuance_id !== null && !Sessions.validSessionId(body.expected_issuance_id))
    reject(400, 'Invalid expected browser issuance');
  if (body.kind === 'logout') {
    if (body.successor_issuance_id !== null) reject(400, 'Logout cannot issue a browser credential');
  } else if (!Sessions.validSessionId(body.successor_issuance_id)) reject(400, 'Invalid successor browser issuance');
  return {
    operation_id: body.operation_id.toLowerCase(),
    intent: body.intent,
    kind: body.kind,
    expected_issuance_id: body.expected_issuance_id?.toLowerCase() ?? null,
    successor_issuance_id: body.successor_issuance_id?.toLowerCase() ?? null
  };
}

function operationSnapshot(row) {
  return { operation_id: row.id, intent: String(row.intent), kind: row.kind, state: row.state };
}

async function admitIntent(proof, input) {
  const operation = operationInput(input);
  // This short transaction takes only context/operation locks. Session and MFA
  // mutations must later acquire account -> context -> proof/family/token locks;
  // never retain this context lock while acquiring an account lock.
  return Sessions.transaction(async (client) => {
    const context = await lockedContext(client, proof);
    const incoming = BigInt(operation.intent);
    const current = BigInt(context.latest_intent);
    if (incoming < current) reject(409, 'Browser intent was superseded');
    if (incoming === current) {
      const existing = await client.query(
        `SELECT *,intent::text AS intent,expires_at<=clock_timestamp() AS expired
         FROM console_browser_operations WHERE id=$1 AND context_id=$2`,
        [operation.operation_id, context.id]
      );
      const row = existing.rows[0];
      if (
        !row ||
        row.expired ||
        row.intent !== operation.intent ||
        row.kind !== operation.kind ||
        row.expected_issuance_id !== operation.expected_issuance_id ||
        row.successor_issuance_id !== operation.successor_issuance_id
      )
        reject(409, 'Browser operation does not match its admitted intent');
      return { operation: operationSnapshot(row), families: [] };
    }
    if (context.selected_issuance_id !== operation.expected_issuance_id) selectionChanged();
    await reclaim(client, context);
    // The cap bounds live operations; finished rotations were reclaimed above.
    const capacity = await client.query(
      'SELECT COUNT(*)::integer AS count FROM console_browser_operations WHERE context_id=$1',
      [context.id]
    );
    if (capacity.rows[0].count >= maximumOperationsPerContext) reject(429, 'Browser operation capacity reached');
    const result = await client.query(
      `INSERT INTO console_browser_operations(id,context_id,intent,kind,expected_issuance_id,successor_issuance_id)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *,intent::text AS intent`,
      [
        operation.operation_id,
        context.id,
        operation.intent,
        operation.kind,
        operation.expected_issuance_id,
        operation.successor_issuance_id
      ]
    );
    if (!result.rowCount) reject(409, 'Browser operation or successor was already used');
    await client.query(
      `UPDATE console_browser_operations SET state='superseded'
       WHERE context_id=$1 AND id<>$2 AND state IN ('registered','candidate')`,
      [context.id, operation.operation_id]
    );
    // The lease slides with use, so an active browser is not signed out after 30 days.
    await client.query(
      `UPDATE console_browser_contexts SET latest_intent=$2,
         expires_at=GREATEST(expires_at, clock_timestamp() + INTERVAL '30 days') WHERE id=$1`,
      [context.id, operation.intent]
    );
    return { operation: operationSnapshot(result.rows[0]), families: await orphanFamilies(client, context) };
  });
}

/**
 * Deletes operations that can never grant again: superseded or refused ones,
 * expired ones without an issuance, and parents of retired issuances (their
 * issuance rows cascade). The selected issuance's parent is never touched.
 */
async function reclaim(client, context) {
  await client.query(
    `DELETE FROM console_browser_operations o WHERE o.context_id=$1
       AND o.id IS DISTINCT FROM (SELECT operation_id FROM console_browser_issuances WHERE id=$2)
       AND NOT EXISTS(SELECT 1 FROM console_browser_issuances s WHERE s.operation_id=o.id AND s.state='selected')
       AND ((o.expires_at<=clock_timestamp()
             AND NOT EXISTS(SELECT 1 FROM console_browser_issuances i WHERE i.operation_id=o.id))
         OR o.state IN ('superseded','refused')
         OR EXISTS(SELECT 1 FROM console_browser_issuances r WHERE r.operation_id=o.id AND r.state='retired'))`,
    [context.id, context.selected_issuance_id]
  );
}

/** Session families of this context that can no longer be selected (excluding the selection's own). */
async function orphanFamilies(client, context) {
  const result = await client.query(
    `SELECT DISTINCT i.session_id FROM console_browser_issuances i
       JOIN console_browser_operations o ON o.id=i.operation_id
      WHERE o.context_id=$1 AND (i.state='retired' OR o.state IN ('superseded','refused'))
        AND i.session_id IS DISTINCT FROM (SELECT session_id FROM console_browser_issuances WHERE id=$2)`,
    [context.id, context.selected_issuance_id]
  );
  return result.rows.map((row) => row.session_id);
}

/**
 * Revokes families whose browser issuances can never be selected again, after the
 * context transaction committed. Each family takes the account lock first, then
 * the family, and is revoked only if no live issuance still refers to it.
 */
async function closeFamilies(sessionIds) {
  for (const sessionId of new Set(sessionIds || [])) {
    await Sessions.transaction(async (client) => {
      const family = (await client.query('SELECT user_id FROM console_sessions WHERE id=$1', [sessionId])).rows[0];
      if (!family) return;
      await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [family.user_id]);
      await client.query('SELECT id FROM console_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      const live = await client.query(
        `SELECT 1 FROM console_browser_issuances i JOIN console_browser_operations o ON o.id=i.operation_id
          WHERE i.session_id=$1 AND (i.state='selected' OR (i.state='candidate' AND o.state IN ('registered','candidate')))
          LIMIT 1`,
        [sessionId]
      );
      if (!live.rowCount) await Sessions.revokeFamily(client, family.user_id, sessionId, 'browser_issuance_retired');
    });
  }
}

/** Fail fast before side effects outside the session transaction (registration). */
async function checkOperation(proof, operationId, allowedKinds) {
  return Sessions.transaction((client) => admitOperation(client, proof, operationId, allowedKinds));
}

/** Whether an issuance is still the selection of its context (open sockets recheck this). */
async function isSelected(contextId, issuanceId) {
  const result = await getPgPool().query(
    `SELECT 1 FROM console_browser_contexts c JOIN console_browser_issuances i ON i.id=c.selected_issuance_id
      WHERE c.id=$1 AND i.id=$2 AND i.state='selected' AND c.expires_at>clock_timestamp()`,
    [contextId, issuanceId]
  );
  return result.rowCount === 1;
}

// ---------------------------------------------------------------------------
// Browser-v2 credentials. Each issuance owns immutable, distinctly named cookies.
// Authority is the server-selected issuance of a bound context; a cookie that is
// merely present (for example from a late, superseded response) grants nothing.
// ---------------------------------------------------------------------------
const accessCookieName = (issuanceId) => `nn_at_${issuanceId}`;
const refreshCookieName = (issuanceId) => `nn_rt_${issuanceId}`;
const hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Returns null for legacy requests, '2' for browser-v2; refuses other versions. */
function browserProtocol(req) {
  const value = req.get ? req.get('X-NeroNet-Browser-Protocol') : req.headers?.['x-neronet-browser-protocol'];
  if (value === undefined) return null;
  if (value !== '2') reject(400, 'Unsupported browser protocol');
  return value;
}

/** Proof for a credential-bearing v2 request: a missing or unbound context is 401. */
function credentialProof(req) {
  const id = req.get('X-NeroNet-Browser-Context');
  if (!Sessions.validSessionId(id)) reject(401, 'Browser context required');
  const origin = req.get('Origin');
  if (origin !== undefined && !config.CORS_ORIGINS.filter((value) => value !== '*').includes(origin))
    reject(403, 'Browser origin is not allowed');
  const canonicalId = id.toLowerCase();
  return { id: canonicalId, origin: origin ?? null, binding: req.cookies?.[bindingCookieName(canonicalId)] || null };
}

function checkCredentialBinding(context, proof) {
  // Same-origin GET requests carry no Origin header; SameSite=Strict on the binding
  // cookie plus the custom protocol header keep cross-site requests out.
  checkBinding(context, { ...proof, origin: proof.origin ?? context.origin });
}

async function selectedRow(queryable, proof, lock) {
  const result = await queryable.query(
    `SELECT c.*, c.latest_intent::text AS latest_intent, c.expires_at<=clock_timestamp() AS expired,
       i.id AS issuance_id, i.session_id AS issuance_session_id, i.access_jti, i.refresh_jti
       FROM console_browser_contexts c
       LEFT JOIN console_browser_issuances i ON i.context_id=c.id AND i.id=c.selected_issuance_id AND i.state='selected'
       WHERE c.id=$1 ${lock ? 'FOR UPDATE OF c' : ''}`,
    [proof.id]
  );
  const context = result.rows[0];
  if (!context) reject(401, 'Browser context not found');
  checkCredentialBinding(context, proof);
  return context;
}

/**
 * Credential of an authenticated v2 request. The claimed issuance (from the
 * document's own record) must equal the server selection so that a stale document
 * resynchronises instead of acting under another principal.
 */
async function authenticate(req) {
  if (req.headers?.authorization) reject(401, 'Browser protocol does not accept Authorization');
  const proof = credentialProof(req);
  const context = await selectedRow(getPgPool(), proof, false);
  if (!context.issuance_id) reject(401, 'No browser session selected');
  const claimed = req.get('X-NeroNet-Browser-Issuance');
  if (!claimed || claimed.toLowerCase() !== context.issuance_id) selectionChanged();
  const token = req.cookies?.[accessCookieName(context.issuance_id)];
  if (!token) reject(401, 'Browser credential missing');
  return {
    proof,
    token,
    issuance: { id: context.issuance_id, sessionId: context.issuance_session_id, accessJti: context.access_jti }
  };
}

/** Refresh credential of the selected issuance, read before any account lock. */
async function selectedRefresh(req) {
  if (req.headers?.authorization) reject(401, 'Browser protocol does not accept Authorization');
  const proof = credentialProof(req);
  const context = await selectedRow(getPgPool(), proof, false);
  if (!context.issuance_id) reject(401, 'No browser session selected');
  // The document must name the selection it refreshes, exactly like other requests.
  const claimed = req.get('X-NeroNet-Browser-Issuance');
  if (!claimed || claimed.toLowerCase() !== context.issuance_id) selectionChanged();
  const token = req.cookies?.[refreshCookieName(context.issuance_id)];
  if (!token) reject(401, 'Browser credential missing');
  return { proof, token, issuanceId: context.issuance_id };
}

/**
 * Admits a registered operation inside the caller's transaction, after the
 * account lock and before MFA proof/family/token locks.
 */
async function admitOperation(client, proof, operationId, allowedKinds) {
  if (!Sessions.validSessionId(operationId)) reject(400, 'Invalid browser operation');
  const context = await selectedRow(client, proof, true);
  if (context.expired) reject(401, 'Browser context expired');
  const result = await client.query(
    `SELECT *, intent::text AS intent, expires_at<=clock_timestamp() AS expired
       FROM console_browser_operations WHERE id=$1 AND context_id=$2 FOR UPDATE`,
    [operationId.toLowerCase(), context.id]
  );
  const operation = result.rows[0];
  if (!operation || !allowedKinds.includes(operation.kind))
    reject(409, 'Browser operation does not match its admitted intent');
  if (operation.expired) reject(409, 'Browser operation expired');
  if (operation.state !== 'registered' || operation.intent !== context.latest_intent)
    reject(409, 'Browser intent was superseded');
  if ((operation.expected_issuance_id ?? null) !== (context.selected_issuance_id ?? null)) selectionChanged();
  return { context, operation };
}

async function retire(client, context) {
  if (!context.selected_issuance_id) return;
  await client.query(`UPDATE console_browser_issuances SET state='retired' WHERE id=$1 AND context_id=$2`, [
    context.selected_issuance_id,
    context.id
  ]);
}

/**
 * Records the successor issuance of an admitted operation in the same transaction
 * that created its credential pair. Login produces a candidate; refresh and other
 * rotations of the selected session select their successor atomically.
 */
async function recordIssuance(client, admitted, session, { select }) {
  const { context, operation } = admitted;
  const access = jwt.decode(session.token);
  const refresh = jwt.decode(session.refreshToken);
  const credential = await client.query(
    'SELECT id, expires_at FROM refresh_tokens WHERE session_id=$1 AND token_hash=$2',
    [access.sid, hex(session.refreshToken)]
  );
  if (!credential.rowCount) reject(503, 'Session authority unavailable');
  await client.query(
    `INSERT INTO console_browser_issuances
       (id,context_id,operation_id,session_id,refresh_token_id,access_jti,refresh_jti,state,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      operation.successor_issuance_id,
      context.id,
      operation.id,
      access.sid,
      credential.rows[0].id,
      access.jti,
      refresh.jti,
      select ? 'selected' : 'candidate',
      credential.rows[0].expires_at
    ]
  );
  if (select) {
    await retire(client, context);
    await client.query('UPDATE console_browser_contexts SET selected_issuance_id=$2 WHERE id=$1', [
      context.id,
      operation.successor_issuance_id
    ]);
  }
  await client.query('UPDATE console_browser_operations SET state=$2 WHERE id=$1', [
    operation.id,
    select ? 'selected' : 'candidate'
  ]);
  return { sid: access.sid, issuance_id: operation.successor_issuance_id };
}

/** Logout: retire the selected issuance of an admitted logout operation. */
async function recordLogout(client, admitted) {
  await retire(client, admitted.context);
  await client.query('UPDATE console_browser_contexts SET selected_issuance_id=NULL WHERE id=$1', [
    admitted.context.id
  ]);
  await client.query(`UPDATE console_browser_operations SET state='selected' WHERE id=$1`, [admitted.operation.id]);
}

/** Compare-and-set adoption of a login candidate against intent and predecessor. */
async function selectCandidate(proof, body) {
  if (!body || !Sessions.validSessionId(body.operation_id) || !Sessions.validSessionId(body.issuance_id))
    reject(400, 'Invalid browser selection');
  if (typeof body.intent !== 'string' || !/^[1-9][0-9]{0,19}$/.test(body.intent))
    reject(400, 'Browser intent must be a canonical decimal string');
  return Sessions.transaction(async (client) => {
    const context = await lockedContext(client, proof);
    const result = await client.query(
      `SELECT o.*, o.intent::text AS intent, i.state AS issuance_state, i.session_id,
         o.expires_at<=clock_timestamp() AS expired,
         s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() AS family_closed
         FROM console_browser_operations o
         JOIN console_browser_issuances i ON i.operation_id=o.id AND i.id=o.successor_issuance_id
         JOIN console_sessions s ON s.id=i.session_id
        WHERE o.id=$1 AND o.context_id=$2 FOR UPDATE OF o, i`,
      [body.operation_id.toLowerCase(), context.id]
    );
    const row = result.rows[0];
    if (
      !row ||
      row.successor_issuance_id !== body.issuance_id.toLowerCase() ||
      row.intent !== body.intent ||
      !['login', 'register'].includes(row.kind)
    )
      reject(409, 'Browser selection does not match its candidate');
    if (row.state !== 'candidate' || row.issuance_state !== 'candidate' || row.intent !== context.latest_intent)
      reject(409, 'Browser intent was superseded');
    if (row.expired) reject(409, 'Browser candidate expired');
    if ((row.expected_issuance_id ?? null) !== (context.selected_issuance_id ?? null)) selectionChanged();
    if (row.family_closed) reject(409, 'Browser candidate session is no longer valid');
    // A predecessor of another family can never be selected again: close it after commit.
    const families =
      context.selected_session_id && context.selected_session_id !== row.session_id
        ? [context.selected_session_id]
        : [];
    await retire(client, context);
    await client.query(`UPDATE console_browser_issuances SET state='selected' WHERE id=$1`, [
      row.successor_issuance_id
    ]);
    await client.query('UPDATE console_browser_contexts SET selected_issuance_id=$2 WHERE id=$1', [
      context.id,
      row.successor_issuance_id
    ]);
    await client.query(`UPDATE console_browser_operations SET state='selected' WHERE id=$1`, [row.id]);
    return {
      context_id: context.id,
      selected: { sid: row.session_id, issuance_id: row.successor_issuance_id },
      families
    };
  });
}

module.exports = {
  bindingCookieName,
  accessCookieName,
  refreshCookieName,
  browserProtocol,
  proofFromRequest,
  credentialProof,
  bootstrap,
  readBoundContext,
  admitIntent,
  admitOperation,
  recordIssuance,
  recordLogout,
  selectCandidate,
  closeFamilies,
  checkOperation,
  isSelected,
  authenticate,
  selectedRefresh,
  lockedContext,
  snapshot
};
