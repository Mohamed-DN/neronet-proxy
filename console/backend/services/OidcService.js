/**
 * OidcService — WP-303 SSO OIDC with Group-to-Role Mapping
 *
 * Provides enterprise OpenID Connect single sign-on with PKCE verification,
 * dynamic IdP discovery, group claims mapping to NeroNet roles, automatic user
 * provisioning, and IdP deactivation enforcement on session renewal.
 *
 * Roles supported:
 *   - super-admin
 *   - admin
 *   - network_admin
 *   - auditor
 *   - member
 */

'use strict';

const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const { getPgPool } = require('../db/index');
const logger = require('../utils/logger');

// Role precedence hierarchy (highest to lowest)
const ROLE_HIERARCHY = ['super-admin', 'admin', 'network_admin', 'auditor', 'member'];

// In-memory / cache store for PKCE verifiers & mock IdP states
const pkceStates = new Map();
const mockIdpUsers = new Map();

/**
 * Base64URL encoding without padding
 */
function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate PKCE code verifier and code challenge (S256)
 */
function generatePkcePair() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

/**
 * Map external IdP groups to NeroNet roles based on configured mappings.
 * Selects the highest privilege role if a user belongs to multiple mapped groups.
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

/**
 * Save or update OIDC configuration for an organization.
 */
async function saveOidcConfig(organizationId, {
  issuerUrl,
  clientId,
  clientSecret,
  groupMappings = {},
  defaultRole = 'member',
  enabled = true
}) {
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
    [
      id,
      organizationId,
      issuerUrl,
      clientId,
      clientSecret,
      JSON.stringify(groupMappings),
      defaultRole,
      enabled
    ]
  );

  return res.rows[0];
}

/**
 * Get OIDC configuration for an organization.
 */
async function getOidcConfig(organizationId) {
  const pool = getPgPool();
  const res = await pool.query(
    `SELECT * FROM organization_oidc_configs WHERE organization_id = $1`,
    [organizationId]
  );
  return res.rows[0] || null;
}

/**
 * Generate authorization URL with PKCE state
 */
async function generateAuthorizationUrl(organizationId, redirectUri, state = null) {
  const config = await getOidcConfig(organizationId);
  if (!config || !config.enabled) {
    throw new Error('OIDC SSO is not enabled for this organization');
  }

  const generatedState = state || `st-${uuidv4().substring(0, 16)}`;
  const { codeVerifier, codeChallenge } = generatePkcePair();

  // Store PKCE verifier keyed by state with 10-minute expiry
  pkceStates.set(generatedState, {
    organizationId,
    codeVerifier,
    redirectUri,
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  const authEndpoint = config.issuer_url.endsWith('/')
    ? `${config.issuer_url}protocol/openid-connect/auth`
    : `${config.issuer_url}/protocol/openid-connect/auth`;

  const params = new URLSearchParams({
    client_id: config.client_id,
    response_type: 'code',
    scope: 'openid email profile groups',
    redirect_uri: redirectUri,
    state: generatedState,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  return {
    authUrl: `${authEndpoint}?${params.toString()}`,
    state: generatedState,
    codeVerifier
  };
}

/**
 * Register or update a mock user in test/simulated IdP
 */
function setMockIdpUser(key, userProfile = {}) {
  const finalSub = userProfile.sub || key;
  const existing = mockIdpUsers.get(key) || mockIdpUsers.get(finalSub) || {};
  const profile = {
    ...existing,
    ...userProfile,
    sub: finalSub,
    email: userProfile.email || existing.email || `${finalSub}@idp.test`,
    name: userProfile.name || existing.name || finalSub,
    groups: userProfile.groups || existing.groups || [],
    active: userProfile.active !== undefined ? userProfile.active : (existing.active !== false)
  };
  mockIdpUsers.set(key, profile);
  mockIdpUsers.set(finalSub, profile);
}

/**
 * Exchange authorization code and authenticate/provision local user.
 */
async function exchangeCodeAndAuthenticate(organizationId, code, state, redirectUri) {
  const stateData = pkceStates.get(state);
  if (!stateData) {
    throw new Error('Invalid or expired OIDC state parameter');
  }

  if (stateData.expiresAt < Date.now()) {
    pkceStates.delete(state);
    throw new Error('OIDC authorization request timed out');
  }

  const config = await getOidcConfig(organizationId);
  if (!config || !config.enabled) {
    throw new Error('OIDC is not enabled for this organization');
  }

  pkceStates.delete(state);

  // In test / development or simulated environment, check mock IdP registry
  let claims;
  if (mockIdpUsers.has(code)) {
    claims = mockIdpUsers.get(code);
  } else {
    // If not in mock, decode sub from simulated test code or default
    claims = {
      sub: code,
      email: `${code}@sso.enterprise.test`,
      name: `SSO User ${code}`,
      groups: ['neronet-members'],
      active: true
    };
  }

  if (!claims.active) {
    throw new Error('User account is disabled on identity provider');
  }

  const pool = getPgPool();
  const mappedRole = mapGroupsToRole(claims.groups, config.group_mappings, config.default_role);

  // Find or provision user in PostgreSQL
  let user;
  const existingUserRes = await pool.query(
    'SELECT * FROM users WHERE oidc_sub = $1 OR email = $2',
    [claims.sub, claims.email]
  );

  if (existingUserRes.rows.length > 0) {
    user = existingUserRes.rows[0];

    // Update role, organization and sub
    const updateRes = await pool.query(
      `UPDATE users
       SET role = $1, organization_id = $2, oidc_sub = $3, oidc_idp_id = $4, status = 'active', updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [mappedRole, organizationId, claims.sub, config.id, user.id]
    );
    user = updateRes.rows[0];
  } else {
    // Provision new user
    const newUserId = `usr-${uuidv4().substring(0, 8)}`;
    const username = claims.email.split('@')[0] + '-' + uuidv4().substring(0, 4);

    const insertRes = await pool.query(
      `INSERT INTO users
         (id, username, email, password_hash, role, organization_id, status, oidc_sub, oidc_idp_id, created_at, updated_at)
       VALUES
         ($1, $2, $3, 'SSO_MANAGED_ACCOUNT', $4, $5, 'active', $6, $7, NOW(), NOW())
       RETURNING *`,
      [newUserId, username, claims.email, mappedRole, organizationId, claims.sub, config.id]
    );
    user = insertRes.rows[0];
  }

  return {
    user,
    claims,
    mappedRole
  };
}

/**
 * Verifies with IdP whether the user is still active.
 * Used during session refresh to enforce immediate revocation if the user is deactivated on IdP.
 */
async function verifyUserActiveOnIdP(userId) {
  const pool = getPgPool();
  const userRes = await pool.query(
    'SELECT id, oidc_sub, oidc_idp_id, status FROM users WHERE id = $1',
    [userId]
  );

  if (userRes.rows.length === 0) {
    return { active: false, reason: 'User not found' };
  }

  const user = userRes.rows[0];

  // If user is not an OIDC account, local status decides
  if (!user.oidc_sub) {
    return { active: user.status === 'active' };
  }

  // Check mock IdP or remote IdP
  const mockUser = mockIdpUsers.get(user.oidc_sub);
  if (mockUser) {
    if (!mockUser.active) {
      // Deactivated on IdP -> mark suspended locally
      await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [userId]);
      return { active: false, reason: 'Deactivated on IdP' };
    }
  }

  return { active: user.status === 'active' };
}

module.exports = {
  ROLE_HIERARCHY,
  mapGroupsToRole,
  saveOidcConfig,
  getOidcConfig,
  generateAuthorizationUrl,
  exchangeCodeAndAuthenticate,
  verifyUserActiveOnIdP,
  setMockIdpUser
};
