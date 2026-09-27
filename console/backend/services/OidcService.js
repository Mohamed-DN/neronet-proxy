/**
 * OidcService — OpenID Connect sign-in for an organisation's identity provider.
 *
 * Authorization code flow with PKCE (RFC 7636) and a nonce:
 *
 *   1. generateAuthorizationUrl() discovers the provider, stores state, nonce and
 *      code verifier server side, and returns the provider's authorization URL.
 *   2. The provider redirects the browser back with a code. exchangeCodeAndAuthenticate()
 *      redeems it at the provider's token endpoint with the client credentials and
 *      the code verifier, then verifies the returned ID token: signature against the
 *      provider's JWKS, issuer, audience, expiry and nonce.
 *   3. The account is found by (provider, subject). It is never linked by e-mail: the
 *      provider is configured by the organisation, and an e-mail claim from it says
 *      nothing about accounts in other organisations.
 *
 * Group claims map to organisation roles only. A provider configured by one tenant
 * cannot grant a platform role such as super-admin.
 *
 * Deactivation on the provider is detected when the console session is refreshed:
 * the stored provider refresh token is redeemed, and a provider that refuses it
 * (invalid_grant) suspends the local account. A provider that issued no refresh
 * token cannot be checked this way; local status then decides.
 *
 * The earlier implementation redeemed nothing. Any code string was accepted, and
 * when it was not a registered test fixture the claims were invented from it, so
 * any organisation with SSO enabled signed in whoever asked.
 */

'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getPgPool } = require('../db/index');
const logger = require('../utils/logger');

// Role precedence, highest first. super-admin is listed so that mapGroupsToRole keeps
// its meaning as a pure function; provisioning never assigns it (see ORG_ROLES).
const ROLE_HIERARCHY = ['super-admin', 'admin', 'network_admin', 'auditor', 'member'];

// Roles an organisation's identity provider may grant: membership roles in that
// organisation, nothing platform wide.
const ORG_ROLES = new Set(['admin', 'network_admin', 'auditor', 'member']);

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 10000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 5000;
const CLOCK_TOLERANCE_S = 60;
const ID_TOKEN_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];

// state -> { organizationId, codeVerifier, nonce, redirectUri, expiresAt }
const pendingStates = new Map();
// issuer -> { doc, jwks, fetchedAt }
const providerCache = new Map();

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken() {
  return base64UrlEncode(crypto.randomBytes(32));
}

function generatePkcePair() {
  const codeVerifier = randomToken();
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/**
 * Map identity provider groups to a role. The highest role any group maps to wins;
 * with no mapped group, defaultRole.
 */
function mapGroupsToRole(userGroups = [], groupMappings = {}, defaultRole = 'member') {
  if (!Array.isArray(userGroups)) {
    userGroups = [userGroups].filter(Boolean);
  }

  const matchedRoles = new Set();
  for (const group of userGroups) {
    if (groupMappings[group]) {
      matchedRoles.add(groupMappings[group]);
    }
  }

  for (const role of ROLE_HIERARCHY) {
    if (matchedRoles.has(role)) {
      return role;
    }
  }

  return defaultRole;
}

/** mapGroupsToRole restricted to the roles an organisation's provider may grant. */
function mapGroupsToOrgRole(userGroups, groupMappings = {}, defaultRole = 'member') {
  const allowed = {};
  for (const [group, role] of Object.entries(groupMappings || {})) {
    if (ORG_ROLES.has(role)) allowed[group] = role;
  }
  return mapGroupsToRole(userGroups, allowed, ORG_ROLES.has(defaultRole) ? defaultRole : 'member');
}

/**
 * Plain HTTP is accepted for loopback only, which is what a provider on the same host
 * during development or in tests looks like. Everything else must be HTTPS.
 */
function assertProviderUrl(value, what) {
  let url;
  try {
    url = new URL(value);
  } catch (err) {
    throw new Error(`OIDC ${what} is not a valid URL`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`OIDC ${what} must use https`);
  }
  return url;
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  return { status: res.status, ok: res.ok, body };
}

/** Provider metadata and signing keys, cached per issuer. */
async function getProvider(issuer, { refreshKeys = false } = {}) {
  const cached = providerCache.get(issuer);
  if (cached && !refreshKeys && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached;
  }

  assertProviderUrl(issuer, 'issuer');
  const discoveryUrl = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const discovery = await httpJson(discoveryUrl);
  if (!discovery.ok || !discovery.body) {
    throw new Error(`OIDC discovery failed (${discovery.status})`);
  }

  const doc = discovery.body;
  // OpenID Connect Discovery 1.0, section 4.3: the issuer must match exactly.
  if (doc.issuer !== issuer) {
    throw new Error('OIDC discovery returned a different issuer');
  }
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!doc[field]) throw new Error(`OIDC discovery document lacks ${field}`);
    assertProviderUrl(doc[field], field);
  }

  const keys = await httpJson(doc.jwks_uri);
  if (!keys.ok || !keys.body || !Array.isArray(keys.body.keys)) {
    throw new Error(`OIDC key set could not be fetched (${keys.status})`);
  }

  const entry = { doc, jwks: keys.body.keys, fetchedAt: Date.now() };
  providerCache.set(issuer, entry);
  return entry;
}

function findSigningKey(jwks, kid) {
  const candidates = jwks.filter((k) => !k.use || k.use === 'sig');
  if (kid) return candidates.find((k) => k.kid === kid) || null;
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Verify an ID token and return its claims. Throws on any failure.
 */
async function verifyIdToken(idToken, { issuer, clientId, nonce }) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !ID_TOKEN_ALGORITHMS.includes(decoded.header.alg)) {
    throw new Error('ID token is malformed or uses an unaccepted algorithm');
  }

  let provider = await getProvider(issuer);
  let jwk = findSigningKey(provider.jwks, decoded.header.kid);
  if (!jwk) {
    // The provider may have rotated its keys since they were cached.
    provider = await getProvider(issuer, { refreshKeys: true });
    jwk = findSigningKey(provider.jwks, decoded.header.kid);
  }
  if (!jwk) {
    throw new Error('ID token is signed with an unknown key');
  }

  let claims;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    claims = jwt.verify(idToken, key, {
      algorithms: [decoded.header.alg],
      issuer: provider.doc.issuer,
      audience: clientId,
      clockTolerance: CLOCK_TOLERANCE_S
    });
  } catch (err) {
    throw new Error(`ID token rejected: ${err.message}`);
  }

  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) {
    throw new Error('ID token rejected: authorized party mismatch');
  }
  if (nonce !== undefined && claims.nonce !== nonce) {
    throw new Error('ID token rejected: nonce mismatch');
  }
  if (!claims.sub || typeof claims.sub !== 'string') {
    throw new Error('ID token rejected: no subject');
  }

  return claims;
}

/**
 * POST to the provider's token endpoint with the client's credentials.
 * client_secret_basic unless the provider only advertises client_secret_post.
 */
async function tokenRequest(provider, config, params) {
  const body = new URLSearchParams(params);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };

  const methods = provider.doc.token_endpoint_auth_methods_supported;
  if (Array.isArray(methods) && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) {
    body.set('client_id', config.client_id);
    body.set('client_secret', config.client_secret);
  } else {
    const id = encodeURIComponent(config.client_id);
    const secret = encodeURIComponent(config.client_secret);
    headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  }

  return httpJson(provider.doc.token_endpoint, { method: 'POST', headers, body: body.toString() });
}

async function saveOidcConfig(
  organizationId,
  { issuerUrl, clientId, clientSecret, groupMappings = {}, defaultRole = 'member', enabled = true }
) {
  assertProviderUrl(issuerUrl, 'issuer');
  const pool = getPgPool();
  const id = `oidc-${uuidv4().substring(0, 8)}`;

  const res = await pool.query(
    `INSERT INTO organization_oidc_configs
       (id, organization_id, issuer_url, client_id, client_secret, group_mappings, default_role, enabled, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW())
     ON CONFLICT (organization_id) DO UPDATE SET
       issuer_url = EXCLUDED.issuer_url,
       client_id = EXCLUDED.client_id,
       client_secret = EXCLUDED.client_secret,
       group_mappings = EXCLUDED.group_mappings,
       default_role = EXCLUDED.default_role,
       enabled = EXCLUDED.enabled,
       updated_at = NOW()
     RETURNING *`,
    [id, organizationId, issuerUrl, clientId, clientSecret, JSON.stringify(groupMappings), defaultRole, enabled]
  );

  return res.rows[0];
}

async function getOidcConfig(organizationId) {
  const pool = getPgPool();
  const res = await pool.query(`SELECT * FROM organization_oidc_configs WHERE organization_id = $1`, [organizationId]);
  return res.rows[0] || null;
}

function prunePendingStates() {
  const now = Date.now();
  for (const [state, data] of pendingStates) {
    if (data.expiresAt < now) pendingStates.delete(state);
  }
  // The authorize endpoint is public; keep what it can make us hold bounded.
  while (pendingStates.size >= MAX_PENDING_STATES) {
    pendingStates.delete(pendingStates.keys().next().value);
  }
}

/**
 * Start a sign-in. The code verifier and nonce stay on the server; only the state
 * travels with the browser.
 */
async function generateAuthorizationUrl(organizationId, redirectUri) {
  const config = await getOidcConfig(organizationId);
  if (!config || !config.enabled) {
    throw new Error('OIDC SSO is not enabled for this organization');
  }

  let redirect;
  try {
    redirect = new URL(redirectUri);
  } catch (err) {
    throw new Error('redirect_uri must be an absolute URL');
  }
  if (!['https:', 'http:'].includes(redirect.protocol)) {
    throw new Error('redirect_uri must be an http(s) URL');
  }

  const provider = await getProvider(config.issuer_url);

  prunePendingStates();
  const state = randomToken();
  const nonce = randomToken();
  const { codeVerifier, codeChallenge } = generatePkcePair();
  pendingStates.set(state, {
    organizationId,
    codeVerifier,
    nonce,
    redirectUri,
    expiresAt: Date.now() + STATE_TTL_MS
  });

  const authUrl = new URL(provider.doc.authorization_endpoint);
  authUrl.searchParams.set('client_id', config.client_id);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile groups offline_access');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return { authUrl: authUrl.toString(), state };
}

function fallbackEmail(configId, sub) {
  const digest = crypto.createHash('sha256').update(`${configId}:${sub}`).digest('hex').slice(0, 24);
  return `oidc-${digest}@sso.invalid`;
}

/**
 * Redeem an authorization code and sign the user in, provisioning the account on
 * first use.
 */
async function exchangeCodeAndAuthenticate(organizationId, code, state, redirectUri) {
  const stateData = pendingStates.get(state);
  // Single use, whatever happens next.
  pendingStates.delete(state);

  if (!stateData) {
    throw new Error('Invalid or expired OIDC state parameter');
  }
  if (stateData.expiresAt < Date.now()) {
    throw new Error('OIDC authorization request timed out');
  }
  if (stateData.organizationId !== organizationId) {
    throw new Error('OIDC state was issued for another organization');
  }
  if (redirectUri && redirectUri !== stateData.redirectUri) {
    throw new Error('OIDC redirect_uri does not match the authorization request');
  }

  const config = await getOidcConfig(organizationId);
  if (!config || !config.enabled) {
    throw new Error('OIDC is not enabled for this organization');
  }

  const provider = await getProvider(config.issuer_url);
  const tokenRes = await tokenRequest(provider, config, {
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: stateData.redirectUri,
    code_verifier: stateData.codeVerifier
  });
  if (!tokenRes.ok || !tokenRes.body || !tokenRes.body.id_token) {
    const reason = tokenRes.body && tokenRes.body.error ? tokenRes.body.error : `status ${tokenRes.status}`;
    throw new Error(`Identity provider refused the authorization code (${reason})`);
  }

  const claims = await verifyIdToken(tokenRes.body.id_token, {
    issuer: config.issuer_url,
    clientId: config.client_id,
    nonce: stateData.nonce
  });

  const groups = Array.isArray(claims.groups) ? claims.groups : [];
  const mappedRole = mapGroupsToOrgRole(groups, config.group_mappings, config.default_role);
  const idpRefreshToken = tokenRes.body.refresh_token || null;

  const pool = getPgPool();
  const existingRes = await pool.query('SELECT * FROM users WHERE oidc_idp_id = $1 AND oidc_sub = $2', [
    config.id,
    claims.sub
  ]);

  let user;
  if (existingRes.rows.length > 0) {
    user = existingRes.rows[0];
    // A local suspension outranks the provider: signing in there does not undo it.
    if (user.status !== 'active') {
      throw new Error('Account is suspended or revoked');
    }
    const updateRes = await pool.query(
      `UPDATE users SET oidc_refresh_token = COALESCE($1, oidc_refresh_token), updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [idpRefreshToken, user.id]
    );
    user = updateRes.rows[0];
  } else {
    const email = claims.email || fallbackEmail(config.id, claims.sub);
    const clash = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (clash.rows.length > 0) {
      // Linking here would let any organisation's provider take over the account
      // that owns this address, in whichever organisation it lives.
      throw new Error('An account with this e-mail address already exists and is not linked to this identity provider');
    }

    const newUserId = `usr-${uuidv4().substring(0, 8)}`;
    const localPart =
      email
        .split('@')[0]
        .replace(/[^a-zA-Z0-9._-]/g, '')
        .slice(0, 40) || 'sso';
    const username = `${localPart}-${uuidv4().substring(0, 4)}`;

    const insertRes = await pool.query(
      `INSERT INTO users
         (id, username, email, password_hash, role, organization_id, status, oidc_sub, oidc_idp_id,
          oidc_refresh_token, created_at, updated_at)
       VALUES
         ($1, $2, $3, 'SSO_MANAGED_ACCOUNT', 'user', $4, 'active', $5, $6, $7, NOW(), NOW())
       RETURNING *`,
      [newUserId, username, email, organizationId, claims.sub, config.id, idpRefreshToken]
    );
    user = insertRes.rows[0];
  }

  await pool.query(
    `INSERT INTO memberships (id, user_id, organization_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role`,
    [`mem-${uuidv4().substring(0, 8)}`, user.id, organizationId, mappedRole]
  );

  return { user, claims, mappedRole };
}

/**
 * Whether the account may keep its session. Called on every console session refresh.
 */
async function verifyUserActiveOnIdP(userId) {
  const pool = getPgPool();
  const userRes = await pool.query(
    'SELECT id, oidc_sub, oidc_idp_id, oidc_refresh_token, status FROM users WHERE id = $1',
    [userId]
  );
  if (userRes.rows.length === 0) {
    return { active: false, reason: 'User not found' };
  }

  const user = userRes.rows[0];
  if (user.status !== 'active') {
    return { active: false, reason: 'Account inactive or suspended' };
  }
  if (!user.oidc_sub) {
    return { active: true };
  }

  const cfgRes = await pool.query('SELECT * FROM organization_oidc_configs WHERE id = $1', [user.oidc_idp_id]);
  const config = cfgRes.rows[0];
  if (!config || !config.enabled) {
    return { active: false, reason: 'Identity provider is no longer configured for this organization' };
  }
  if (!user.oidc_refresh_token) {
    // Nothing to ask the provider with. Local status decides.
    return { active: true };
  }

  let tokenRes;
  try {
    const provider = await getProvider(config.issuer_url);
    tokenRes = await tokenRequest(provider, config, {
      grant_type: 'refresh_token',
      refresh_token: user.oidc_refresh_token
    });
  } catch (err) {
    // Fail closed without suspending: the session ends, the account does not.
    logger.warn(`OIDC refresh for ${userId} could not reach the identity provider: ${err.message}`);
    return { active: false, reason: 'Identity provider unreachable' };
  }

  if (tokenRes.ok) {
    if (tokenRes.body && tokenRes.body.refresh_token) {
      await pool.query('UPDATE users SET oidc_refresh_token = $1 WHERE id = $2', [tokenRes.body.refresh_token, userId]);
    }
    return { active: true };
  }

  if (tokenRes.body && tokenRes.body.error === 'invalid_grant') {
    await pool.query("UPDATE users SET status = 'suspended', oidc_refresh_token = NULL WHERE id = $1", [userId]);
    return { active: false, reason: 'Account deactivated on identity provider' };
  }

  logger.warn(`OIDC refresh for ${userId} failed with status ${tokenRes.status}`);
  return { active: false, reason: 'Identity provider refused the session refresh' };
}

/** Forget cached provider metadata and pending sign-ins. For tests. */
function resetCaches() {
  pendingStates.clear();
  providerCache.clear();
}

module.exports = {
  ROLE_HIERARCHY,
  mapGroupsToRole,
  mapGroupsToOrgRole,
  saveOidcConfig,
  getOidcConfig,
  generateAuthorizationUrl,
  exchangeCodeAndAuthenticate,
  verifyIdToken,
  verifyUserActiveOnIdP,
  resetCaches
};
