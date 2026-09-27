const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const TotpService = require('../services/TotpService');
const OidcService = require('../services/OidcService');
const { CryptoShreddingService, KeyShreddedError } = require('../services/CryptoShreddingService');

// Crypto-shredding destroyed an organisation's data key, but nothing real was ever
// encrypted with it (AUDIT-SEC SHRED-2), and the key that wrapped it was SHA-256 of
// the JWT secret with a literal committed to the repository as the fallback
// (SHRED-1). The organisation's secrets -- its identity-provider client secret, its
// users' TOTP seeds and identity-provider refresh tokens -- sat in plain columns.

describe('Crypto-shredding covers the secrets an organisation stores', () => {
  let dbHelper;
  let pool;
  let app;
  const ORG = 'org-shred-real';
  const PASSWORD = 'Shred-Real-Password-1!';
  let totpSeed;
  const savedKek = { secret: config.SHRED_KEK_SECRET, previous: config.SHRED_KEK_PREVIOUS };

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Shred Real', 'shred-real')`, [ORG]);
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id, status)
       VALUES ('usr-shred-real', 'shred_real', 'real@shred.test', $1, 'user', $2, 'active')`,
      [await bcrypt.hash(PASSWORD, 10), ORG]
    );
  });

  after(async () => {
    config.SHRED_KEK_SECRET = savedKek.secret;
    config.SHRED_KEK_PREVIOUS = savedKek.previous;
    if (dbHelper) await dbHelper.cleanup();
  });

  it('stores a TOTP seed enrolled through the API sealed, and signs in with it', async () => {
    const step = await request(app).post('/api/auth/login').send({ username: 'shred_real', password: PASSWORD });
    process.env.SOVEREIGN_MFA_MANDATORY = 'all';
    let mfa;
    try {
      mfa = await request(app).post('/api/auth/login').send({ username: 'shred_real', password: PASSWORD });
    } finally {
      delete process.env.SOVEREIGN_MFA_MANDATORY;
    }
    assert.ok(step.body.token, 'no MFA required yet');
    const setup = await request(app).post('/api/auth/mfa/setup').send({ mfa_token: mfa.body.mfa_token });
    assert.strictEqual(setup.status, 200, JSON.stringify(setup.body));
    totpSeed = setup.body.secret;

    const verify = await request(app)
      .post('/api/auth/mfa/verify')
      .send({ mfa_token: mfa.body.mfa_token, code: TotpService.generateTotp(totpSeed) });
    assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));

    const row = (await pool.query("SELECT totp_secret FROM users WHERE id = 'usr-shred-real'")).rows[0];
    assert.ok(!row.totp_secret.includes(totpSeed), 'the seed is stored in the clear');
    assert.ok(CryptoShreddingService.isSealed(row.totp_secret));

    const again = await request(app)
      .post('/api/auth/login')
      .send({ username: 'shred_real', password: PASSWORD, totp_code: TotpService.generateTotp(totpSeed) });
    assert.strictEqual(again.status, 200);
    assert.ok(again.body.token);
  });

  it("stores the identity provider's client secret sealed", async () => {
    await OidcService.saveOidcConfig(ORG, {
      issuerUrl: 'https://idp.shred.test',
      clientId: 'neronet',
      clientSecret: 'idp-client-secret-value'
    });
    const row = (
      await pool.query('SELECT client_secret FROM organization_oidc_configs WHERE organization_id = $1', [ORG])
    ).rows[0];
    assert.ok(!row.client_secret.includes('idp-client-secret-value'));
    assert.strictEqual((await OidcService.getOidcConfig(ORG)).client_secret, 'idp-client-secret-value');
  });

  it('seals secrets stored before sealing existed', async () => {
    await pool.query("UPDATE users SET oidc_refresh_token = 'legacy-plain-refresh' WHERE id = 'usr-shred-real'");
    assert.ok((await CryptoShreddingService.sealLegacySecrets()) >= 1);
    const row = (await pool.query("SELECT oidc_refresh_token FROM users WHERE id = 'usr-shred-real'")).rows[0];
    assert.ok(CryptoShreddingService.isSealed(row.oidc_refresh_token));
    assert.strictEqual(await CryptoShreddingService.openForOrg(ORG, row.oidc_refresh_token), 'legacy-plain-refresh');
  });

  it('does not derive the key-encryption key from the JWT secret', async () => {
    const wrapped = (await pool.query('SELECT encrypted_dek FROM organization_keys WHERE organization_id = $1', [ORG]))
      .rows[0].encrypted_dek;
    const savedJwt = config.JWT_SECRET;
    config.JWT_SECRET = 'a-different-jwt-secret';
    try {
      assert.ok(CryptoShreddingService.unwrapDEK(wrapped, ORG).dek.length === 32);
    } finally {
      config.JWT_SECRET = savedJwt;
    }
    config.SHRED_KEK_SECRET = null;
    try {
      assert.throws(() => CryptoShreddingService.unwrapDEK(wrapped, ORG), /SOVEREIGN_SHRED_KEK_SECRET/);
    } finally {
      config.SHRED_KEK_SECRET = savedKek.secret;
    }
  });

  it('makes them unreadable after a shred, and a pre-shred backup unreadable once the KEK is rotated', async () => {
    const backup = {
      dek: (await pool.query('SELECT encrypted_dek FROM organization_keys WHERE organization_id = $1', [ORG])).rows[0]
        .encrypted_dek,
      totp: (await pool.query("SELECT totp_secret FROM users WHERE id = 'usr-shred-real'")).rows[0].totp_secret
    };

    const result = await CryptoShreddingService.executeOrgShred(ORG, { initiatorId: 'a', approverId: 'b' });
    assert.strictEqual(result.key_status, 'destroyed');

    await assert.rejects(() => CryptoShreddingService.openForOrg(ORG, backup.totp), KeyShreddedError);
    const user = (await pool.query("SELECT status, totp_secret FROM users WHERE id = 'usr-shred-real'")).rows[0];
    assert.strictEqual(user.status, 'revoked');
    assert.strictEqual(user.totp_secret, null);
    assert.strictEqual(
      (await pool.query('SELECT count(*)::int AS n FROM organization_oidc_configs WHERE organization_id = $1', [ORG]))
        .rows[0].n,
      0
    );
    const org = (await pool.query('SELECT destroyed_at FROM organizations WHERE id = $1', [ORG])).rows[0];
    assert.ok(org.destroyed_at);

    // The backup's wrapped key still opens under the KEK that wrapped it...
    assert.strictEqual(CryptoShreddingService.unwrapDEK(backup.dek, ORG).dek.length, 32);

    // ...until that KEK is rotated out and destroyed.
    config.SHRED_KEK_PREVIOUS = savedKek.secret;
    config.SHRED_KEK_SECRET = 'rotated-kek-secret-for-the-test';
    await CryptoShreddingService.rewrapAllDataKeys();
    config.SHRED_KEK_PREVIOUS = null;
    assert.throws(() => CryptoShreddingService.unwrapDEK(backup.dek, ORG), /not configured/);
  });

  it('never creates a new data key for a shredded organisation', async () => {
    await assert.rejects(() => CryptoShreddingService.sealForOrg(ORG, 'anything'), KeyShreddedError);
    const never = 'org-shred-never-keyed';
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Never', 'never-keyed')`, [never]);
    await CryptoShreddingService.executeOrgShred(never, { initiatorId: 'a', approverId: 'b' });
    await assert.rejects(() => CryptoShreddingService.sealForOrg(never, 'anything'), KeyShreddedError);
  });
});
