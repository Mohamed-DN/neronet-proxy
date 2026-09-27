const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const request = require('supertest');
const { refreshCookie } = require('./helpers/refreshCookie');
const jwt = require('jsonwebtoken');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

/**
 * OIDC sign-in against a real, local identity provider: discovery, JWKS, a token
 * endpoint that checks client credentials, PKCE and single-use codes, and signs ID
 * tokens with its own RSA key. The console has to redeem codes and verify tokens for
 * any of this to pass; a registry of fake users inside the service would not.
 */

const CLIENT_ID = 'neronet-console-client';
const CLIENT_SECRET = 'test-client-secret-not-a-real-one';
const REDIRECT_URI = 'https://console.neronet.test/auth/callback';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function startIdentityProvider() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'idp-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };

  const codes = new Map(); // code -> { claims, redirectUri, codeChallenge, nonce, tamper }
  const refreshTokens = new Map(); // refresh token -> sub
  const disabled = new Set(); // sub
  let issuer = null;

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function clientAuthenticated(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    const [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
    return id === CLIENT_ID && secret === CLIENT_SECRET;
  }

  function newRefreshToken(sub) {
    const token = b64url(crypto.randomBytes(24));
    refreshTokens.set(token, sub);
    return token;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_basic']
      });
    }
    if (req.method === 'GET' && url.pathname === '/jwks') {
      return json(res, 200, { keys: [jwk] });
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        if (!clientAuthenticated(req)) return json(res, 401, { error: 'invalid_client' });

        if (form.get('grant_type') === 'authorization_code') {
          const entry = codes.get(form.get('code'));
          codes.delete(form.get('code'));
          if (!entry) return json(res, 400, { error: 'invalid_grant' });
          if (form.get('redirect_uri') !== entry.redirectUri) return json(res, 400, { error: 'invalid_grant' });
          const challenge = b64url(
            crypto
              .createHash('sha256')
              .update(form.get('code_verifier') || '')
              .digest()
          );
          if (challenge !== entry.codeChallenge) return json(res, 400, { error: 'invalid_grant' });

          const t = entry.tamper || {};
          const idToken = jwt.sign({ ...entry.claims, nonce: t.nonce || entry.nonce }, t.key || privateKey, {
            algorithm: 'RS256',
            keyid: kid,
            issuer,
            audience: t.audience || CLIENT_ID,
            expiresIn: '5m'
          });
          return json(res, 200, {
            access_token: b64url(crypto.randomBytes(16)),
            token_type: 'Bearer',
            id_token: idToken,
            refresh_token: newRefreshToken(entry.claims.sub)
          });
        }

        if (form.get('grant_type') === 'refresh_token') {
          const sub = refreshTokens.get(form.get('refresh_token'));
          refreshTokens.delete(form.get('refresh_token'));
          if (!sub || disabled.has(sub)) return json(res, 400, { error: 'invalid_grant' });
          return json(res, 200, { access_token: 'x', token_type: 'Bearer', refresh_token: newRefreshToken(sub) });
        }

        return json(res, 400, { error: 'unsupported_grant_type' });
      });
      return undefined;
    }
    return json(res, 404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      issuer = `http://127.0.0.1:${server.address().port}`;
      resolve({
        get issuer() {
          return issuer;
        },
        // What the provider does when the user signs in at authUrl: remember the
        // request and hand back a code for the browser to carry to the console.
        authorize(authUrl, claims, tamper) {
          const params = new URL(authUrl).searchParams;
          assert.strictEqual(params.get('client_id'), CLIENT_ID);
          assert.strictEqual(params.get('code_challenge_method'), 'S256');
          const code = b64url(crypto.randomBytes(16));
          codes.set(code, {
            claims,
            redirectUri: params.get('redirect_uri'),
            codeChallenge: params.get('code_challenge'),
            nonce: params.get('nonce'),
            tamper
          });
          return { code, state: params.get('state') };
        },
        disable(sub) {
          disabled.add(sub);
        },
        close() {
          return new Promise((r) => server.close(r));
        }
      });
    });
  });
}

describe('OIDC sign-in', () => {
  let dbHelper;
  let pool;
  let app;
  let idp;
  let OidcService;
  const orgId = 'org-sso-test-01';

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    OidcService = require('../services/OidcService');
    if (OidcService.resetCaches) OidcService.resetCaches();

    idp = await startIdentityProvider();

    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'SSO Enterprise Org', 'sso-enterprise')
       ON CONFLICT (id) DO NOTHING`,
      [orgId]
    );
    await OidcService.saveOidcConfig(orgId, {
      issuerUrl: idp.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      groupMappings: {
        'idp-global-admins': 'super-admin',
        'idp-org-admins': 'admin',
        'idp-net-admins': 'network_admin',
        'idp-compliance': 'auditor',
        'idp-general': 'member'
      },
      defaultRole: 'member',
      enabled: true
    });
  });

  after(async () => {
    if (idp) await idp.close();
    if (dbHelper) await dbHelper.cleanup();
  });

  async function startSignIn() {
    const res = await request(app)
      .get('/api/auth/oidc/authorize')
      .query({ organization_id: orgId, redirect_uri: REDIRECT_URI });
    assert.strictEqual(res.status, 200);
    return res.body;
  }

  async function signIn(claims, tamper) {
    const { authUrl } = await startSignIn();
    const { code, state } = idp.authorize(authUrl, claims, tamper);
    return request(app)
      .post('/api/auth/oidc/callback')
      .send({ organization_id: orgId, code, state, redirect_uri: REDIRECT_URI });
  }

  async function membershipRole(sub) {
    const res = await pool.query(
      `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE u.oidc_sub = $1 AND m.organization_id = $2`,
      [sub, orgId]
    );
    return res.rows[0] ? res.rows[0].role : null;
  }

  it('maps groups by precedence, and never to a platform role for an organisation', () => {
    const mappings = { 'g-admin': 'admin', 'g-net': 'network_admin', 'g-audit': 'auditor', 'g-super': 'super-admin' };

    assert.strictEqual(OidcService.mapGroupsToRole(['g-net'], mappings), 'network_admin');
    assert.strictEqual(OidcService.mapGroupsToRole(['g-audit', 'g-super', 'g-net'], mappings), 'super-admin');
    assert.strictEqual(OidcService.mapGroupsToRole(['unknown'], mappings, 'member'), 'member');

    assert.strictEqual(OidcService.mapGroupsToOrgRole(['g-audit', 'g-super', 'g-net'], mappings), 'network_admin');
    assert.strictEqual(OidcService.mapGroupsToOrgRole(['g-super'], mappings), 'member');
    assert.strictEqual(OidcService.mapGroupsToOrgRole([], {}, 'super-admin'), 'member');
  });

  it('sends the browser to the provider with PKCE and a nonce, and keeps the verifier', async () => {
    const body = await startSignIn();
    const url = new URL(body.authUrl);

    assert.strictEqual(url.origin + url.pathname, `${idp.issuer}/authorize`);
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.ok(url.searchParams.get('nonce'));
    assert.strictEqual(url.searchParams.get('state'), body.state);
    assert.strictEqual(body.codeVerifier, undefined, 'the PKCE verifier must not leave the server');
  });

  it('provisions the account with the mapped organisation role', async () => {
    const res = await signIn({
      sub: 'idp-sub-alice',
      email: 'alice@enterprise.test',
      groups: ['idp-org-admins', 'idp-general']
    });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.token);
    assert.strictEqual(res.body.mappedRole, 'admin');
    assert.strictEqual(res.body.user.role, 'user', 'platform role stays user');

    const row = (await pool.query('SELECT * FROM users WHERE oidc_sub = $1', ['idp-sub-alice'])).rows[0];
    assert.strictEqual(row.organization_id, orgId);
    assert.strictEqual(row.role, 'user');
    assert.strictEqual(await membershipRole('idp-sub-alice'), 'admin');
  });

  it('follows group changes on the next sign-in', async () => {
    const res = await signIn({ sub: 'idp-sub-alice', email: 'alice@enterprise.test', groups: ['idp-compliance'] });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mappedRole, 'auditor');
    assert.strictEqual(await membershipRole('idp-sub-alice'), 'auditor');
  });

  it("does not let an organisation's provider grant platform super-admin", async () => {
    const res = await signIn({
      sub: 'idp-sub-mallory',
      email: 'mallory@enterprise.test',
      groups: ['idp-global-admins']
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.role, 'user');
    const row = (await pool.query('SELECT role FROM users WHERE oidc_sub = $1', ['idp-sub-mallory'])).rows[0];
    assert.strictEqual(row.role, 'user');
  });

  it('refuses a code the provider never issued', async () => {
    const { state } = await startSignIn();
    const usersBefore = (await pool.query('SELECT count(*) AS n FROM users')).rows[0].n;

    const res = await request(app)
      .post('/api/auth/oidc/callback')
      .send({ organization_id: orgId, code: 'made-up-code', state, redirect_uri: REDIRECT_URI });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.token, undefined);
    assert.strictEqual((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n, usersBefore);
  });

  it('refuses an ID token signed by another key', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const res = await signIn({ sub: 'idp-sub-forged', email: 'forged@enterprise.test' }, { key: privateKey });
    assert.strictEqual(res.status, 401);
  });

  it('refuses an ID token issued for another client', async () => {
    const res = await signIn({ sub: 'idp-sub-aud', email: 'aud@enterprise.test' }, { audience: 'some-other-client' });
    assert.strictEqual(res.status, 401);
  });

  it('refuses an ID token whose nonce belongs to another sign-in', async () => {
    const res = await signIn({ sub: 'idp-sub-nonce', email: 'nonce@enterprise.test' }, { nonce: 'replayed' });
    assert.strictEqual(res.status, 401);
  });

  it('refuses a state it did not issue, and a state used twice', async () => {
    const forged = await request(app)
      .post('/api/auth/oidc/callback')
      .send({ organization_id: orgId, code: 'any', state: 'forged-state', redirect_uri: REDIRECT_URI });
    assert.strictEqual(forged.status, 401);

    const { authUrl } = await startSignIn();
    const { code, state } = idp.authorize(authUrl, { sub: 'idp-sub-once', email: 'once@enterprise.test' });
    const first = await request(app)
      .post('/api/auth/oidc/callback')
      .send({ organization_id: orgId, code, state, redirect_uri: REDIRECT_URI });
    assert.strictEqual(first.status, 200);
    const second = await request(app)
      .post('/api/auth/oidc/callback')
      .send({ organization_id: orgId, code, state, redirect_uri: REDIRECT_URI });
    assert.strictEqual(second.status, 401);
  });

  it('never takes over an existing account by e-mail address', async () => {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-local-victim', 'localvictim', 'victim@elsewhere.test', 'hash', 'super-admin', 'org-default')`
    );

    const res = await signIn({ sub: 'idp-sub-claims-victim', email: 'victim@elsewhere.test', groups: [] });

    assert.strictEqual(res.status, 401);
    const row = (await pool.query("SELECT * FROM users WHERE id = 'usr-local-victim'")).rows[0];
    assert.strictEqual(row.organization_id, 'org-default');
    assert.strictEqual(row.role, 'super-admin');
    assert.strictEqual(row.oidc_sub, null);
  });

  it('ends the session when the provider has deactivated the user', async () => {
    const login = await signIn({ sub: 'idp-sub-bob', email: 'bob@enterprise.test', groups: ['idp-general'] });
    assert.strictEqual(login.status, 200);

    const ok = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: refreshCookie(login) });
    assert.strictEqual(ok.status, 200, 'refresh works while the provider still knows the user');

    idp.disable('idp-sub-bob');

    const refused = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: refreshCookie(ok) });
    assert.strictEqual(refused.status, 401);
    assert.match(refused.body.error, /deactivated/i);

    const row = (await pool.query('SELECT status FROM users WHERE oidc_sub = $1', ['idp-sub-bob'])).rows[0];
    assert.strictEqual(row.status, 'suspended');
  });

  it('does not lift a local suspension when the user signs in at the provider', async () => {
    await pool.query("UPDATE users SET status = 'suspended' WHERE oidc_sub = 'idp-sub-alice'");

    const res = await signIn({ sub: 'idp-sub-alice', email: 'alice@enterprise.test', groups: ['idp-org-admins'] });

    assert.strictEqual(res.status, 401);
    const row = (await pool.query('SELECT status FROM users WHERE oidc_sub = $1', ['idp-sub-alice'])).rows[0];
    assert.strictEqual(row.status, 'suspended');
  });
});
