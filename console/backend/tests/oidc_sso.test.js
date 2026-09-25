const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

/**
 * WP-303: SSO OIDC with Group-to-Role Mapping & IdP-driven Session Revocation
 */

describe('WP-303: SSO OIDC with Group-to-Role Mapping', () => {
  let dbHelper;
  let pool;
  let app;
  let OidcService;
  let testOrgId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;

    app = createApp();
    OidcService = require('../services/OidcService');

    // Create a test organization
    testOrgId = 'org-sso-test-01';
    await pool.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'SSO Enterprise Org', 'sso-enterprise')
       ON CONFLICT (id) DO NOTHING`,
      [testOrgId]
    );

    // Save OIDC configuration with group mappings
    await OidcService.saveOidcConfig(testOrgId, {
      issuerUrl: 'https://keycloak.enterprise.local/realms/neronet',
      clientId: 'neronet-console-client',
      clientSecret: 'super-secret-client-token',
      groupMappings: {
        'idp-global-admins': 'super-admin',
        'idp-net-admins': 'network_admin',
        'idp-compliance': 'auditor',
        'idp-general': 'member'
      },
      defaultRole: 'member',
      enabled: true
    });
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('1. mapGroupsToRole maps single and conflicting groups according to role hierarchy', () => {
    const mappings = {
      'group-admin': 'admin',
      'group-net': 'network_admin',
      'group-audit': 'auditor',
      'group-super': 'super-admin'
    };

    // Single group mapping
    assert.strictEqual(OidcService.mapGroupsToRole(['group-net'], mappings), 'network_admin');
    assert.strictEqual(OidcService.mapGroupsToRole(['group-audit'], mappings), 'auditor');

    // Conflict resolution: highest privilege role wins
    assert.strictEqual(
      OidcService.mapGroupsToRole(['group-audit', 'group-super', 'group-net'], mappings),
      'super-admin'
    );
    assert.strictEqual(OidcService.mapGroupsToRole(['group-net', 'group-admin'], mappings), 'admin');

    // Unmapped group falls back to defaultRole
    assert.strictEqual(OidcService.mapGroupsToRole(['unknown-contractor-group'], mappings, 'member'), 'member');
  });

  it('2. generateAuthorizationUrl produces valid PKCE parameters and endpoint', async () => {
    const res = await request(app)
      .get('/api/auth/oidc/authorize')
      .query({
        organization_id: testOrgId,
        redirect_uri: 'https://console.neronet.local/auth/callback'
      })
      .expect(200);

    assert.ok(res.body.authUrl, 'authUrl must be present');
    assert.ok(res.body.state, 'state must be present');
    assert.ok(res.body.authUrl.includes('code_challenge='), 'PKCE code_challenge required');
    assert.ok(res.body.authUrl.includes('code_challenge_method=S256'), 'S256 method required');
    assert.ok(res.body.authUrl.includes('client_id=neronet-console-client'));
  });

  it('3. OIDC callback auto-provisions user with mapped role and issues hardened session', async () => {
    // Register mock IdP user
    const mockCode = 'auth-code-alice-admin';
    OidcService.setMockIdpUser(mockCode, {
      sub: 'keycloak-sub-alice-001',
      email: 'alice.admin@enterprise.local',
      name: 'Alice Admin',
      groups: ['idp-global-admins', 'idp-general'],
      active: true
    });

    // Generate state
    const authPrep = await OidcService.generateAuthorizationUrl(
      testOrgId,
      'https://console.neronet.local/auth/callback'
    );

    // Call callback endpoint
    const res = await request(app)
      .post('/api/auth/oidc/callback')
      .send({
        organization_id: testOrgId,
        code: mockCode,
        state: authPrep.state,
        redirect_uri: 'https://console.neronet.local/auth/callback'
      })
      .expect(200);

    assert.ok(res.body.token, 'JWT access token returned');
    assert.ok(res.body.refreshToken, 'Refresh token returned');
    assert.strictEqual(res.body.mappedRole, 'super-admin');
    assert.strictEqual(res.body.user.role, 'super-admin');

    // Verify user in PostgreSQL database
    const userRow = (await pool.query('SELECT * FROM users WHERE oidc_sub = $1', ['keycloak-sub-alice-001'])).rows[0];

    assert.ok(userRow, 'User must be created in PostgreSQL');
    assert.strictEqual(userRow.role, 'super-admin');
    assert.strictEqual(userRow.organization_id, testOrgId);
  });

  it('4. Role is updated on subsequent OIDC login if IdP group membership changes', async () => {
    // Demote Alice to auditor in IdP
    const mockCode2 = 'auth-code-alice-auditor';
    OidcService.setMockIdpUser(mockCode2, {
      sub: 'keycloak-sub-alice-001',
      email: 'alice.admin@enterprise.local',
      name: 'Alice Admin',
      groups: ['idp-compliance'], // Mapped to 'auditor'
      active: true
    });

    const authPrep = await OidcService.generateAuthorizationUrl(
      testOrgId,
      'https://console.neronet.local/auth/callback'
    );

    const res = await request(app)
      .post('/api/auth/oidc/callback')
      .send({
        organization_id: testOrgId,
        code: mockCode2,
        state: authPrep.state,
        redirect_uri: 'https://console.neronet.local/auth/callback'
      })
      .expect(200);

    assert.strictEqual(res.body.mappedRole, 'auditor');

    // Verify database was updated
    const userRow = (await pool.query('SELECT role FROM users WHERE oidc_sub = $1', ['keycloak-sub-alice-001']))
      .rows[0];
    assert.strictEqual(userRow.role, 'auditor');
  });

  it('5. User deactivated on IdP loses session access on subsequent token refresh', async () => {
    const mockCode = 'auth-code-bob-user';
    const sub = 'keycloak-sub-bob-002';

    OidcService.setMockIdpUser(mockCode, {
      sub,
      email: 'bob.member@enterprise.local',
      name: 'Bob Member',
      groups: ['idp-general'],
      active: true
    });

    const authPrep = await OidcService.generateAuthorizationUrl(
      testOrgId,
      'https://console.neronet.local/auth/callback'
    );

    // Initial login
    const loginRes = await request(app)
      .post('/api/auth/oidc/callback')
      .send({
        organization_id: testOrgId,
        code: mockCode,
        state: authPrep.state,
        redirect_uri: 'https://console.neronet.local/auth/callback'
      })
      .expect(200);

    const refreshToken = loginRes.body.refreshToken;
    assert.ok(refreshToken);

    // Deactivate Bob on the IdP
    OidcService.setMockIdpUser(sub, {
      sub,
      email: 'bob.member@enterprise.local',
      active: false // Deactivated on Keycloak/IdP
    });

    // Attempt refresh -> MUST fail with 401 and deactivation reason
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken, refresh_token: refreshToken })
      .expect(401);

    assert.ok(
      refreshRes.body.error.toLowerCase().includes('deactivated') ||
        refreshRes.body.error.toLowerCase().includes('suspended') ||
        refreshRes.body.error.toLowerCase().includes('inactive'),
      'Must refuse refresh for deactivated IdP user'
    );

    // Verify user row was marked suspended
    const userRow = (await pool.query('SELECT status FROM users WHERE oidc_sub = $1', [sub])).rows[0];
    assert.strictEqual(userRow.status, 'suspended');
  });

  it('6. Rejects invalid or expired state parameter', async () => {
    await request(app)
      .post('/api/auth/oidc/callback')
      .send({
        organization_id: testOrgId,
        code: 'any-code',
        state: 'forged-state-parameter',
        redirect_uri: 'https://console.neronet.local/auth/callback'
      })
      .expect(401);
  });
});
