const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const corsMiddleware = require('../middleware/cors');
const requestLogger = require('../middleware/logger');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');

const healthRoutes = require('../routes/health');
const authRoutes = require('../routes/auth');
const usersRoutes = require('../routes/users');
const nodesRoutes = require('../routes/nodes');
const configsRoutes = require('../routes/configs');
const statsRoutes = require('../routes/stats');
const nukeRouter = require('../routes/nuke');
const canaryRouter = require('../routes/canary');

const { setupTestDatabase } = require('./helpers/db');
const { initValkey, closeValkey } = require('../db/valkey');
const NukeEngine = require('../services/NukeEngine');
const CanaryService = require('../services/CanaryService');

function createNukeTestApp() {
  const app = express();

  app.use(corsMiddleware);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // Mount Core Sub-Routers
  app.use('/api', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/nodes', nodesRoutes);
  app.use('/api/configs', configsRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/audit', statsRoutes);

  // Mount NeroNuke & Warrant Canary Sub-Routers, as server.js mounts them: the nuke
  // router only under /api/nuke, the canary also at the root.
  app.use('/api/nuke', nukeRouter);
  app.use('/api/nuke', canaryRouter);
  app.use('/', canaryRouter);

  // Error Handlers
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

describe('Milestone 3: NeroNuke 3-Tier Self-Destruct & Dead Man Switch Engine', () => {
  let app;
  let dbHelper;
  let server;
  let adminToken;
  let userToken;
  let victimToken;
  let victimUserId;
  let victimUsername;

  before(async () => {
    dbHelper = await setupTestDatabase();
    await CanaryService.initCanaryService();

    app = createNukeTestApp();

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    // 1. Authenticate super-admin
    const adminRes = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin_password' });
    assert.strictEqual(adminRes.status, 200, 'Admin login should succeed');
    adminToken = adminRes.body.token;

    // 2. Authenticate regular user
    const userRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice_homelab', password: 'Password123!' });
    assert.strictEqual(userRes.status, 200, 'Alice login should succeed');
    userToken = userRes.body.token;

    // 3. Register a dedicated victim user for instant self-destruct tests
    victimUsername = `victim_${crypto.randomBytes(4).toString('hex')}`;
    const victimReg = await request(app)
      .post('/api/auth/register')
      .send({ username: victimUsername, password: 'Password123!', email: `${victimUsername}@darknero.com` });
    assert.strictEqual(victimReg.status, 201, 'Victim registration should succeed');
    victimToken = victimReg.body.token;
    victimUserId = victimReg.body.user.id;

    // Register a node for victim user
    await request(app)
      .post('/api/nodes')
      .set('Authorization', `Bearer ${victimToken}`)
      .send({ name: 'Victim-Workstation-1' });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeValkey();
    if (dbHelper) {
      await dbHelper.cleanup();
    }
  });

  // ===========================================================================
  // TIER 1: User Account Self-Destruct Tests
  // ===========================================================================
  describe('Tier 1: User Account Self-Destruct (Instant & Scheduled Kill)', () => {
    it('should reject instant kill when confirmation phrase is incorrect', async () => {
      const res = await request(app)
        .post('/api/nuke/user/self-destruct')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({
          confirmation_text: 'please delete me',
          disclaimer_accepted: true
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, "Confirmation phrase 'DELETE MY ACCOUNT' and disclaimer acceptance required");
    });

    it('should reject instant kill when legal disclaimer is not accepted', async () => {
      const res = await request(app)
        .post('/api/nuke/user/self-destruct')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({
          confirmation_text: 'DELETE MY ACCOUNT',
          disclaimer_accepted: false
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, "Confirmation phrase 'DELETE MY ACCOUNT' and disclaimer acceptance required");
    });

    it('should reject instant kill when unauthenticated', async () => {
      const res = await request(app).post('/api/nuke/user/self-destruct').send({
        confirmation_text: 'DELETE MY ACCOUNT',
        disclaimer_accepted: true
      });

      assert.strictEqual(res.status, 401);
    });

    it('should schedule future user account destruction with live countdown state', async () => {
      const futureDate = new Date(Date.now() + 86400 * 1000 * 30).toISOString();
      const res = await request(app)
        .post('/api/nuke/user/schedule')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({
          scheduled_deletion_at: futureDate
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.active, true);
      assert.strictEqual(res.body.scheduled_deletion_at, futureDate);
      assert.strictEqual(res.body.persistent_red_button_state, 'ACTIVE_COUNTDOWN');

      // Verify status query
      const statusRes = await request(app).get('/api/nuke/user/status').set('Authorization', `Bearer ${victimToken}`);
      assert.strictEqual(statusRes.status, 200);
      assert.strictEqual(statusRes.body.active, true);
      assert.strictEqual(statusRes.body.persistent_red_button_state, 'ACTIVE_COUNTDOWN');
    });

    it('should reject scheduling deletion with past or invalid timestamp', async () => {
      const resPast = await request(app)
        .post('/api/nuke/user/schedule')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({ scheduled_deletion_at: 'PAST_DATE' });
      assert.strictEqual(resPast.status, 400);

      const resInvalid = await request(app)
        .post('/api/nuke/user/schedule')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({ scheduled_deletion_at: '1999-01-01T00:00:00Z' });
      assert.strictEqual(resInvalid.status, 400);
    });

    it('should cancel scheduled user account destruction', async () => {
      const res = await request(app)
        .post('/api/nuke/user/cancel-scheduled')
        .set('Authorization', `Bearer ${victimToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.active, false);

      // Verify status query
      const statusRes = await request(app).get('/api/nuke/user/status').set('Authorization', `Bearer ${victimToken}`);
      assert.strictEqual(statusRes.status, 200);
      assert.strictEqual(statusRes.body.active, false);
      assert.strictEqual(statusRes.body.persistent_red_button_state, 'INACTIVE');
    });

    it('should execute instant account destruction: hard delete user, nodes, and blacklist token', async () => {
      const res = await request(app)
        .post('/api/nuke/user/self-destruct')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({
          confirmation_text: 'DELETE MY ACCOUNT',
          disclaimer_accepted: true
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.message, 'User account cryptographically wiped');

      // Subsequent request with the victim token should be rejected (revoked / blacklisted)
      const testTokenRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${victimToken}`);
      assert.strictEqual(testTokenRes.status, 401);

      // User lookup by admin should return 404 Not Found
      const userLookup = await request(app)
        .get(`/api/users/${victimUserId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(userLookup.status, 404);
    });
  });

  // ===========================================================================
  // TIER 1b: Per-User Personal Dead Man's Switch Tests (Silent / Invisible)
  // ===========================================================================
  describe("Tier 1b: Per-User Personal Dead Man's Switch (Silent / Invisible)", () => {
    let dmsUserToken;
    let dmsUserId;

    before(async () => {
      const dmsUsername = `dms_user_${crypto.randomBytes(4).toString('hex')}`;
      const regRes = await request(app)
        .post('/api/auth/register')
        .send({ username: dmsUsername, password: 'Password123!', email: `${dmsUsername}@darknero.com` });
      dmsUserToken = regRes.body.token;
      dmsUserId = regRes.body.user.id;
    });

    it('should reject setup with missing passphrase or invalid interval', async () => {
      const res1 = await request(app)
        .post('/api/nuke/personal-dms/setup')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ passphrase: 'secret_passphrase' }); // missing interval
      assert.strictEqual(res1.status, 400);

      const res2 = await request(app)
        .post('/api/nuke/personal-dms/setup')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ passphrase: 'secret_passphrase', heartbeat_interval_seconds: -50 });
      assert.strictEqual(res2.status, 400);
      assert.strictEqual(res2.body.error, 'heartbeat_interval_seconds must be positive');
    });

    it('should reject unlock request when no Personal DMS is configured for user', async () => {
      const res = await request(app)
        .post('/api/nuke/personal-dms/unlock')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ stego_credentials: 'any_credential' });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'No Personal DMS configured');
    });

    it('should successfully configure Personal DMS silently', async () => {
      const res = await request(app)
        .post('/api/nuke/personal-dms/setup')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({
          passphrase: 'mypassword123',
          heartbeat_interval_seconds: 86400 * 7,
          steganography_mode: 'reverse_password'
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.message, "Personal Dead Man's Switch activated silently");
    });

    it('should reject steganographic unlock with incorrect reversed credentials', async () => {
      const res = await request(app)
        .post('/api/nuke/personal-dms/unlock')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ stego_credentials: 'incorrect_guess' });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Steganographic verification failed');
    });

    it('should unlock Personal DMS with valid reverse password steganographic credentials', async () => {
      const res = await request(app)
        .post('/api/nuke/personal-dms/unlock')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ stego_credentials: '321drowssapym' }); // 'mypassword123' reversed

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.unlocked, true);
      assert.strictEqual(res.body.heartbeat_interval_seconds, 86400 * 7);
      assert.ok(res.body.seconds_remaining > 0);
    });

    it('should reset Personal DMS heartbeat countdown', async () => {
      const res = await request(app)
        .post('/api/nuke/personal-dms/heartbeat')
        .set('Authorization', `Bearer ${dmsUserToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.last_heartbeat_at !== undefined);
    });

    it('should support shadow_password steganography mode', async () => {
      await request(app).post('/api/nuke/personal-dms/setup').set('Authorization', `Bearer ${dmsUserToken}`).send({
        passphrase: 'normal_passphrase',
        heartbeat_interval_seconds: 3600,
        steganography_mode: 'shadow_password',
        steganography_secret: 'shadow_secret_2026'
      });

      const unlockRes = await request(app)
        .post('/api/nuke/personal-dms/unlock')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ stego_credentials: 'shadow_secret_2026' });

      assert.strictEqual(unlockRes.status, 200);
      assert.strictEqual(unlockRes.body.unlocked, true);
    });

    it('accepts the credential under the field name the console sends', async () => {
      const secret = crypto.randomBytes(9).toString('hex');
      await request(app)
        .post('/api/nuke/personal-dms/setup')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({
          passphrase: crypto.randomBytes(9).toString('hex'),
          heartbeat_interval_seconds: 3600,
          steganography_mode: 'shadow_password',
          steganography_secret: secret
        });

      const ok = await request(app)
        .post('/api/nuke/personal-dms/auth')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ method: 'shadow_password', credential: secret });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.body.unlocked, true);

      const wrong = await request(app)
        .post('/api/nuke/personal-dms/auth')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ method: 'shadow_password', credential: crypto.randomBytes(9).toString('hex') });
      assert.strictEqual(wrong.status, 401);
    });

    it('should support mobile_otp steganography mode', async () => {
      await request(app).post('/api/nuke/personal-dms/setup').set('Authorization', `Bearer ${dmsUserToken}`).send({
        passphrase: 'otp_passphrase',
        heartbeat_interval_seconds: 7200,
        steganography_mode: 'mobile_otp',
        steganography_secret: '123456'
      });

      const unlockRes = await request(app)
        .post('/api/nuke/personal-dms/unlock')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ stego_credentials: '123456' });

      assert.strictEqual(unlockRes.status, 200);
      assert.strictEqual(unlockRes.body.unlocked, true);
    });

    it('should support split_reverse steganography mode', async () => {
      await request(app).post('/api/nuke/personal-dms/setup').set('Authorization', `Bearer ${dmsUserToken}`).send({
        passphrase: 'mypassword',
        heartbeat_interval_seconds: 7200,
        steganography_mode: 'split_reverse'
      });

      // 'mypassword' length 10, mid 5: 'mypas' reversed -> 'sapym' + 'sword' => 'sapymsword'
      const unlockRes = await request(app)
        .post('/api/nuke/personal-dms/access')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ stego_credentials: 'sapymsword' });

      assert.strictEqual(unlockRes.status, 200);
      assert.strictEqual(unlockRes.body.unlocked, true);
    });

    it('should support hardware_key steganography mode', async () => {
      await request(app).post('/api/nuke/personal-dms/setup').set('Authorization', `Bearer ${dmsUserToken}`).send({
        passphrase: 'hw_passphrase',
        heartbeat_interval_seconds: 7200,
        steganography_mode: 'hardware_key',
        steganography_secret: 'fido2_yubikey_tap'
      });

      const unlockRes = await request(app)
        .post('/api/nuke/personal-dms/unlock')
        .set('Authorization', `Bearer ${dmsUserToken}`)
        .send({ stego_credentials: 'fido2_yubikey_tap' });

      assert.strictEqual(unlockRes.status, 200);
      assert.strictEqual(unlockRes.body.unlocked, true);
    });

    it('should query Personal DMS status via GET /api/nuke/personal-dms/status', async () => {
      const res = await request(app)
        .get('/api/nuke/personal-dms/status')
        .set('Authorization', `Bearer ${dmsUserToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.configured, true);
      assert.strictEqual(res.body.status, 'active');
      assert.strictEqual(res.body.steganography_mode, 'hardware_key');
      assert.strictEqual(res.body.heartbeat_interval_seconds, 7200);
      assert.ok(res.body.seconds_remaining > 0);
    });
  });

  // ===========================================================================
  // TIER 2: Network Owner Dead Man's Switch Tests (Global Cascading Wipe)
  // ===========================================================================
  describe("Tier 2: Network Owner Dead Man's Switch (Global Cascading Disaster Wipe)", () => {
    it('should forbid non-super-admin user from configuring Owner Dead Man Switch', async () => {
      const res = await request(app)
        .post('/api/nuke/owner-dms/setup')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          passphrase: 'unauthorized_attempt',
          heartbeat_interval_seconds: 86400
        });

      assert.strictEqual(res.status, 403);
    });

    it('should forbid non-super-admin user from sending owner heartbeat', async () => {
      const res = await request(app)
        .post('/api/nuke/owner-dms/heartbeat')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          passphrase: 'unauthorized_attempt'
        });

      assert.strictEqual(res.status, 403);
    });

    it('should allow Super-Admin to configure Owner Dead Man Switch with custom webhook', async () => {
      const res = await request(app)
        .post('/api/nuke/owner-dms/setup')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          passphrase: 'super_secret_owner_passphrase_2026',
          heartbeat_interval_seconds: 86400 * 30,
          webhook_url: 'https://matrix.internal.darknero.com/webhook'
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.message, "Owner Dead Man's Switch configured");
    });

    it('should reject owner heartbeat with incorrect passphrase', async () => {
      const res = await request(app)
        .post('/api/nuke/owner-dms/heartbeat')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          passphrase: 'wrong_passphrase_attempt'
        });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Invalid owner passphrase');
    });

    it('should accept owner heartbeat with valid passphrase and refresh Warrant Canary', async () => {
      const res = await request(app)
        .post('/api/nuke/owner-dms/heartbeat')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          passphrase: 'super_secret_owner_passphrase_2026'
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.last_heartbeat_at !== undefined);
    });

    it('should return Owner DMS status for Super-Admin', async () => {
      const res = await request(app).get('/api/nuke/owner-dms/status').set('Authorization', `Bearer ${adminToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.configured, true);
      assert.strictEqual(res.body.status, 'active');
      assert.strictEqual(res.body.heartbeat_interval_seconds, 86400 * 30);
      assert.strictEqual(res.body.webhook_url_configured, true);
    });
  });

  // ===========================================================================
  // TIER 3: Warrant Canary Tests (Ed25519 Cryptographic Verification)
  // ===========================================================================
  describe('Tier 3: Warrant Canary (Ed25519 Transparency Declaration)', () => {
    it('should serve cryptographically signed canary at /.well-known/canary.txt', async () => {
      const res = await request(app).get('/.well-known/canary.txt');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.valid, true);
      assert.ok(res.body.raw.includes('BEGIN NERONET WARRANT CANARY'));
      assert.ok(res.body.raw.includes('END NERONET WARRANT CANARY'));
      assert.ok(res.body.signature.length > 30);
      assert.ok(res.body.signer_public_key.length > 30);
    });

    it('should serve JSON canary declaration at /api/nuke/canary', async () => {
      const res = await request(app).get('/api/nuke/canary');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.valid, true);
      assert.ok(res.body.statement_text.includes('NERONET SOVEREIGN MESH WARRANT CANARY'));
      assert.ok(res.body.signature);
      assert.ok(res.body.signer_public_key);
    });

    it('should independently verify Ed25519 signature validity against statement', async () => {
      const canary = await CanaryService.getLatestCanary();
      const isValid = CanaryService.verifyCanary(
        canary.statement_text,
        canary.ed25519_signature,
        canary.signer_public_key
      );
      assert.strictEqual(isValid, true, 'Original canary signature must be valid');
    });

    it('should reject tampered statement text during Ed25519 verification', async () => {
      const canary = await CanaryService.getLatestCanary();
      const tamperedStatement = canary.statement_text + ' [TAMPERED_INJECTED_DATA]';
      const isTamperedValid = CanaryService.verifyCanary(
        tamperedStatement,
        canary.ed25519_signature,
        canary.signer_public_key
      );
      assert.strictEqual(isTamperedValid, false, 'Tampered canary text must be cryptographically rejected');
    });

    it('should reject forged public key during Ed25519 verification', async () => {
      const canary = await CanaryService.getLatestCanary();
      const fakePubKey = crypto.randomBytes(32).toString('base64');
      const isFakeValid = CanaryService.verifyCanary(canary.statement_text, canary.ed25519_signature, fakePubKey);
      assert.strictEqual(isFakeValid, false, 'Canary with forged public key must fail verification');
    });

    it('should serve raw plain text canary when Accept text/plain header is sent', async () => {
      const res = await request(app).get('/.well-known/canary.txt').set('Accept', 'text/plain');
      assert.strictEqual(res.status, 200);
      assert.ok(typeof res.text === 'string');
      assert.ok(res.text.includes('BEGIN NERONET WARRANT CANARY'));
      assert.ok(res.text.includes('END NERONET WARRANT CANARY'));
    });

    it('should execute checkExpiredDeadManSwitches without errors', async () => {
      await assert.doesNotReject(async () => {
        await NukeEngine.checkExpiredDeadManSwitches();
      });
    });

    it('should invalidate warrant canary and wipe tables upon full cascading disaster drill', async () => {
      // Create a drill user
      const drillUser = `drill_${crypto.randomBytes(4).toString('hex')}`;
      await request(app)
        .post('/api/auth/register')
        .send({ username: drillUser, password: 'Password123!', email: `${drillUser}@darknero.com` });

      // Trigger global disaster wipe
      const wipeRes = await NukeEngine.executeOwnerGlobalCascadingWipe();
      assert.strictEqual(wipeRes.success, true);
      assert.strictEqual(wipeRes.message, 'Global cascading wipe completed');

      // Verify database tables are wiped
      const userRes = await dbHelper.pool.query('SELECT count(*) as count FROM users');
      assert.strictEqual(parseInt(userRes.rows[0].count, 10), 0, 'All users must be wiped after disaster wipe');

      const nodeRes = await dbHelper.pool.query('SELECT count(*) as count FROM nodes');
      assert.strictEqual(parseInt(nodeRes.rows[0].count, 10), 0, 'All nodes must be wiped after disaster wipe');
    });
  });
});
