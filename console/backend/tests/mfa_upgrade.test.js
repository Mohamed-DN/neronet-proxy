const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const config = require('../config/env');
const Sessions = require('../services/ConsoleSessionService');
const TotpService = require('../services/TotpService');
const { CryptoShreddingService } = require('../services/CryptoShreddingService');

describe('MFA authority migration preserves an enrolled 039 installation', () => {
  let db, oldPolicy;
  const password = 'MfaUpgradePassword123!';

  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    assert.equal((await db.pool.query('SELECT current_database() AS name')).rows[0].name, db.dbName);
    oldPolicy = process.env.SOVEREIGN_MFA_MANDATORY;
    process.env.SOVEREIGN_MFA_MANDATORY = 'all';
  });

  after(async () => {
    if (oldPolicy === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = oldPolicy;
    if (db) await db.cleanup();
  });

  it('retains active factors, remaining recovery codes and existing families while requiring fresh password proofs', async () => {
    const orgId = `org-mfa-upgrade-${process.pid}`;
    await db.pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$1,$1)', [orgId]);
    const passwordHash = await bcrypt.hash(password, 4);
    const rootHash = await bcrypt.hash('MfaUpgradeVaultPassword123!', 4);
    const sealedSecret = TotpService.generateSecret();
    const sealedValue = await CryptoShreddingService.sealForOrg(orgId, sealedSecret);
    const pendingValue = await CryptoShreddingService.sealForOrg(orgId, TotpService.generateSecret());
    assert.equal(CryptoShreddingService.isSealed(sealedValue), true);

    // The helper clones the complete current schema. Remove only migration 040's
    // additions inside this verified ephemeral database, retaining the actual 039
    // users, refresh tokens, family constraints, indexes, triggers and org keys.
    await db.pool.query(`
      DROP TRIGGER IF EXISTS users_console_auth_epoch ON users;
      DROP FUNCTION IF EXISTS advance_console_auth_epoch();
      DROP TABLE IF EXISTS console_mfa_challenges;
      ALTER TABLE users
        DROP COLUMN IF EXISTS console_auth_epoch,
        DROP COLUMN IF EXISTS totp_pending_proof_id,
        DROP COLUMN IF EXISTS totp_pending_proof_type,
        DROP COLUMN IF EXISTS totp_pending_expires_at,
        DROP COLUMN IF EXISTS totp_pending_auth_epoch;
    `);
    const schema = (
      await db.pool.query(`
      SELECT
        (SELECT count(*)::int FROM information_schema.columns
         WHERE table_schema='public' AND table_name='users' AND column_name IN
           ('console_auth_epoch','totp_pending_proof_id','totp_pending_proof_type',
            'totp_pending_expires_at','totp_pending_auth_epoch')) AS mfa_columns,
        (SELECT count(*)::int FROM pg_trigger
         WHERE tgrelid='users'::regclass AND tgname='console_root_grant_identity_change') AS family_identity_trigger
    `)
    ).rows[0];
    assert.deepEqual(schema, { mfa_columns: 0, family_identity_trigger: 1 });

    const fixtures = [];
    for (const [index, storedSecret, secret] of [
      [0, sealedValue, sealedSecret],
      [1, TotpService.generateSecret(), null]
    ]) {
      const id = `usr-mfa-upgrade-${process.pid}-${index}`;
      // One recovery code has already been spent; migration must preserve only
      // the two remaining hashes, without restoring the omitted code.
      const recoveryCodes = TotpService.generateRecoveryCodes(3);
      const remaining = recoveryCodes.slice(1).map((code) => TotpService.hashRecoveryCode(code));
      const pendingCodes = TotpService.generateRecoveryCodes(2).map((code) => TotpService.hashRecoveryCode(code));
      await db.pool.query(
        `
        INSERT INTO users(id,username,email,password_hash,password_hash_root,role,status,organization_id,
                          totp_enabled,totp_secret,totp_recovery_codes,totp_pending_secret,totp_pending_recovery_codes)
        VALUES($1,$1,$2,$3,$4,'user','active',$5,TRUE,$6,$7::jsonb,$8,$9::jsonb)`,
        [
          id,
          `${id}@test.local`,
          passwordHash,
          rootHash,
          orgId,
          storedSecret,
          JSON.stringify(remaining),
          pendingValue,
          JSON.stringify(pendingCodes)
        ]
      );
      const session = await Sessions.issueSession({ user: { id }, ipAddress: '127.0.0.1' });
      const sessionId = jwt.decode(session.token).sid;
      // Text retains PostgreSQL microseconds instead of truncating through Date.
      const family = (
        await db.pool.query('SELECT expires_at::text,created_at::text FROM console_sessions WHERE id=$1', [sessionId])
      ).rows[0];
      const refresh = (
        await db.pool.query('SELECT id,expires_at::text,token_hash FROM refresh_tokens WHERE session_id=$1', [
          sessionId
        ])
      ).rows[0];
      const legacyChallenge = jwt.sign(
        {
          sub: id,
          username: id,
          role: 'user',
          type: 'mfa_pending'
        },
        config.JWT_SECRET,
        { expiresIn: '5m', jwtid: randomUUID() }
      );
      fixtures.push({
        id,
        secret: secret || storedSecret,
        storedSecret,
        remaining,
        session,
        sessionId,
        familyExpires: family.expires_at,
        familyCreated: family.created_at,
        refresh,
        legacyChallenge
      });
    }

    // Apply the exact release SQL, as the real migrator does. The helper's
    // _migrations metadata is deliberately untouched because no runner is used.
    const sql = fs.readFileSync(path.join(__dirname, '../db/migrations/040_mfa_challenge_authority.sql'), 'utf8');
    await db.pool.query(sql);
    const app = createApp();

    for (const fixture of fixtures) {
      // Compare sensitive values in PostgreSQL and expose only booleans/counts
      // in assertion failures, never passwords, factor seeds or recovery hashes.
      const retained = (
        await db.pool.query(
          `
        SELECT id=$1 AS same_id, username=$1 AS same_username, organization_id=$2 AS same_org,
          password_hash=$3 AS same_password, password_hash_root=$4 AS same_root_password,
          role='user' AND status='active' AS same_account_state,
          totp_enabled AND totp_secret=$5 AS same_factor,
          totp_recovery_codes=$6::jsonb AS same_remaining_codes,
          jsonb_array_length(totp_recovery_codes)::int AS remaining_count,
          totp_pending_secret IS NULL AND totp_pending_recovery_codes IS NULL
            AND totp_pending_proof_id IS NULL AND totp_pending_proof_type IS NULL
            AND totp_pending_expires_at IS NULL AND totp_pending_auth_epoch IS NULL AS pending_cleared,
          console_auth_epoch=1 AS initial_positive_epoch
        FROM users WHERE id=$1`,
          [fixture.id, orgId, passwordHash, rootHash, fixture.storedSecret, JSON.stringify(fixture.remaining)]
        )
      ).rows[0];
      assert.deepEqual(retained, {
        same_id: true,
        same_username: true,
        same_org: true,
        same_password: true,
        same_root_password: true,
        same_account_state: true,
        same_factor: true,
        same_remaining_codes: true,
        remaining_count: 2,
        pending_cleared: true,
        initial_positive_epoch: true
      });
      const family = (
        await db.pool.query(
          `
        SELECT user_id=$2 AS same_user, issued_organization_id=$3 AS same_org,
          expires_at=$4 AS same_expiry, created_at=$5 AS same_creation,
          revoked_at IS NULL AND revocation_reason IS NULL AS still_active,
          root_grant_id IS NULL AND root_grant_expires_at IS NULL AND root_organization_id IS NULL AS same_standard_tier
        FROM console_sessions WHERE id=$1`,
          [fixture.sessionId, fixture.id, orgId, fixture.familyExpires, fixture.familyCreated]
        )
      ).rows[0];
      assert.deepEqual(family, {
        same_user: true,
        same_org: true,
        same_expiry: true,
        same_creation: true,
        still_active: true,
        same_standard_tier: true
      });
      const refresh = (
        await db.pool.query(
          `
        SELECT id=$2 AS same_id, expires_at=$3 AS same_expiry,token_hash=$4 AS same_credential,
          revoked=FALSE AND revoked_at IS NULL AS still_active
        FROM refresh_tokens WHERE session_id=$1`,
          [fixture.sessionId, fixture.refresh.id, fixture.refresh.expires_at, fixture.refresh.token_hash]
        )
      ).rows;
      assert.deepEqual(refresh, [{ same_id: true, same_expiry: true, same_credential: true, still_active: true }]);
      assert.equal(
        (await request(app).get('/api/auth/me').auth(fixture.session.token, { type: 'bearer' })).status,
        200
      );

      const stale = await request(app)
        .post('/api/auth/mfa/verify')
        .send({
          mfa_token: fixture.legacyChallenge,
          code: TotpService.generateTotp(fixture.secret)
        });
      assert.equal(stale.status, 401);
      assert.equal(stale.headers['set-cookie'], undefined);
      const pending = await request(app).post('/api/auth/login').send({ username: fixture.id, password });
      assert.equal(pending.status, 200);
      assert.equal(pending.body.mfa_required, true);
      assert.equal(pending.body.token, undefined);
      assert.equal(typeof pending.body.mfa_token, 'string');
      const verified = await request(app)
        .post('/api/auth/mfa/verify')
        .send({
          mfa_token: pending.body.mfa_token,
          code: TotpService.generateTotp(fixture.secret)
        });
      assert.equal(verified.status, 200);
      assert.equal((await request(app).get('/api/auth/me').auth(verified.body.token, { type: 'bearer' })).status, 200);
      assert.equal(
        (await request(app).get('/api/auth/me').auth(fixture.session.token, { type: 'bearer' })).status,
        200
      );
      const counts = (
        await db.pool.query('SELECT count(*)::int AS n FROM console_sessions WHERE user_id=$1', [fixture.id])
      ).rows[0];
      assert.equal(counts.n, 2);
    }
  });
});
