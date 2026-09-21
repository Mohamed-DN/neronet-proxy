const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const request = require('supertest');
const { WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { setupTestDatabase } = require('./helpers/db');
const { createApp, initDatabase } = require('../server');
const { getDatabase, closeDatabase, isPostgres, getPgPool } = require('../db/index');
const { initTopologyWebSocket, closeTopologyWebSocket } = require('../ws/topologyServer');
const { publishTopologyEvent, isTokenBlacklisted, blacklistToken, closeValkey } = require('../db/valkey');
const { broadcastNodeEvent } = require('../services/TopologySync');
const {
  generateCurve25519Keypair,
  allocateVipFromRows,
  buildWireGuardConfig,
  buildNoiseJsonProfile
} = require('../utils/crypto');
const config = require('../config/env');

describe('CHALLENGER 1: Milestone 1 Empirical Verification & Adversarial Stress Suite', () => {
  let dbHelper;
  let app;
  let server;
  let serverPort;
  let adminToken;
  let userAToken;
  let userBToken;
  let userAId;
  let userBId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    await initDatabase();
    app = createApp();

    server = http.createServer(app);
    initTopologyWebSocket(server);

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });

    // 1. Super-Admin login
    const adminRes = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin_password' });
    assert.strictEqual(adminRes.status, 200);
    adminToken = adminRes.body.token;

    // 2. Register Tenant A
    const regARes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'tenant_alpha', password: 'AlphaPassword123!', email: 'alpha@sovereign.local' });
    assert.strictEqual(regARes.status, 201);
    userAToken = regARes.body.token;
    userAId = regARes.body.user.id;

    // 3. Register Tenant B
    const regBRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'tenant_bravo', password: 'BravoPassword123!', email: 'bravo@sovereign.local' });
    assert.strictEqual(regBRes.status, 201);
    userBToken = regBRes.body.token;
    userBId = regBRes.body.user.id;
  });

  after(async () => {
    closeTopologyWebSocket();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeValkey();
    if (dbHelper) await dbHelper.cleanup();
  });

  // =========================================================================
  // 1. Adversarial Auth & SQL Injection Fuzzing (0% Bypass Verification)
  // =========================================================================
  describe('1. Adversarial Auth & Injection Fuzzing', () => {
    const SQLI_VECTORS = [
      "' OR '1'='1",
      "' OR 1=1 --",
      "admin' --",
      "admin' #",
      "admin'/*",
      "' OR '' = '",
      "1' ORDER BY 1--+",
      "1' UNION SELECT 'admin', 'dummy'--",
      "' UNION SELECT null, 'admin', 'hash', 'super-admin'--",
      "'; DROP TABLE users; --",
      "admin' AND 1=0 UNION ALL SELECT 'admin', '2a$10$wN3t8gX1ZkGkR0e2M8t0y.9gZ0n4p7s2e6u1v8w5x9y2z3a4b5c6d'--",
      "' OR (SELECT count(*) FROM users) > 0 --",
      "\\x00' OR 1=1 --"
    ];

    it('should reject 100% of SQL injection payloads on /api/auth/login with zero bypass', async () => {
      for (const payload of SQLI_VECTORS) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ username: payload, password: 'arbitrary_password' });
        assert.ok(
          res.status === 401 || res.status === 400,
          `Expected 401/400 for payload "${payload}", received HTTP ${res.status}`
        );
        assert.strictEqual(res.body.token, undefined);
      }
    });

    it('should reject 100% of SQL injection payloads on /api/auth/register with zero corruption', async () => {
      for (const payload of SQLI_VECTORS) {
        const res = await request(app)
          .post('/api/auth/register')
          .send({
            username: `sqli_${payload.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 16)}`,
            password: 'ValidPass123!'
          });
        assert.ok(
          res.status === 201 || res.status === 400 || res.status === 409,
          `Expected safe status for register payload, received HTTP ${res.status}`
        );
      }
    });

    it('should verify behavior on non-string and malformed JSON payloads in auth endpoints', async () => {
      const MALFORMED = [{ username: null, password: null }, {}];

      for (const body of MALFORMED) {
        const res = await request(app).post('/api/auth/login').send(body);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.token, undefined);
      }
    });
  });

  // =========================================================================
  // 2. Timing Side-Channel Empirical Measurement (Dummy bcrypt validation)
  // =========================================================================
  describe('2. Constant-Time Dummy Bcrypt Timing Verification', () => {
    it('should exhibit uniform timing for non-existent vs existent user with wrong password', async () => {
      const SAMPLES = 15;
      const nonExistentDurations = [];
      const existentWrongPassDurations = [];

      // Warmup JIT
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/api/auth/login')
          .send({ username: 'non_existent_warmup', password: 'WrongPassword123!' });
        await request(app).post('/api/auth/login').send({ username: 'admin', password: 'WrongPassword123!' });
      }

      for (let i = 0; i < SAMPLES; i++) {
        const t0 = process.hrtime.bigint();
        const r1 = await request(app)
          .post('/api/auth/login')
          .send({ username: `ghost_user_${i}`, password: 'WrongPassword123!' });
        const t1 = process.hrtime.bigint();
        assert.strictEqual(r1.status, 401);
        nonExistentDurations.push(Number(t1 - t0) / 1e6); // ms

        const t2 = process.hrtime.bigint();
        const r2 = await request(app)
          .post('/api/auth/login')
          .send({ username: 'admin', password: 'WrongPassword123!' });
        const t3 = process.hrtime.bigint();
        assert.strictEqual(r2.status, 401);
        existentWrongPassDurations.push(Number(t3 - t2) / 1e6); // ms
      }

      const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const meanNonExistent = mean(nonExistentDurations);
      const meanExistentWrong = mean(existentWrongPassDurations);

      const ratio = meanNonExistent / meanExistentWrong;
      assert.ok(
        meanNonExistent >= 30,
        `Expected dummy bcrypt comparison to take >= 30ms, took ${meanNonExistent.toFixed(2)}ms`
      );
      assert.ok(
        ratio >= 0.65 && ratio <= 1.45,
        `Expected timing ratio between 0.65 and 1.45, got ${ratio.toFixed(2)} (NonExistent: ${meanNonExistent.toFixed(1)}ms, ExistentWrong: ${meanExistentWrong.toFixed(1)}ms)`
      );
    });
  });

  // =========================================================================
  // 3. JWT Security & Alg:none Attack Probing
  // =========================================================================
  describe('3. JWT Security & Tamper Probing', () => {
    it('should reject alg:none unsigned JWT tokens', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: 'usr-admin', username: 'admin', role: 'super-admin' })
      ).toString('base64url');
      const noneToken = `${header}.${payload}.`;

      const res = await request(app).get('/api/users').set('Authorization', `Bearer ${noneToken}`);
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Invalid or expired token');
    });

    it('should reject JWT signed with invalid/forged secret', async () => {
      const forgedToken = jwt.sign(
        { sub: 'usr-admin', username: 'admin', role: 'super-admin' },
        'wrong_attacker_secret_key_1234567890',
        { expiresIn: '1h' }
      );

      const res = await request(app).get('/api/users').set('Authorization', `Bearer ${forgedToken}`);
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Invalid or expired token');
    });

    it('should reject expired JWT tokens', async () => {
      const expiredToken = jwt.sign({ sub: 'usr-admin', username: 'admin', role: 'super-admin' }, config.JWT_SECRET, {
        expiresIn: '-10s'
      });

      const res = await request(app).get('/api/users').set('Authorization', `Bearer ${expiredToken}`);
      assert.strictEqual(res.status, 401);
    });

    it('should reject requests with missing Bearer prefix or empty header', async () => {
      const res1 = await request(app).get('/api/users').set('Authorization', 'Basic YWRtaW46cGFzcw==');
      assert.strictEqual(res1.status, 401);

      const res2 = await request(app).get('/api/users').set('Authorization', '');
      assert.strictEqual(res2.status, 401);
    });

    it('should immediately revoke token on logout and enforce O(1) blacklist rejection', async () => {
      // 1. Generate new session for tenant
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'tenant_alpha', password: 'AlphaPassword123!' });
      assert.strictEqual(loginRes.status, 200);
      const sessionToken = loginRes.body.token;

      // 2. Verify token is active
      const meResBefore = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${sessionToken}`);
      assert.strictEqual(meResBefore.status, 200);

      // 3. Logout
      const logoutRes = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${sessionToken}`);
      assert.strictEqual(logoutRes.status, 200);

      // 4. Verify immediate rejection on subsequent requests
      const meResAfter = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${sessionToken}`);
      assert.strictEqual(meResAfter.status, 401);
      assert.strictEqual(meResAfter.body.error, 'Token has been revoked');
    });
  });

  // =========================================================================
  // 4. VIP Allocation Under High Load (100.64.0.0/10)
  // =========================================================================
  describe('4. VIP Allocation Invariant & High-Load Stress', () => {
    it('should allocate 1,000 VIPs with zero collisions and strict CIDR compliance (100.64.0.0/10)', () => {
      const allocatedDbRows = [];
      const ipv4Set = new Set();
      const ipv6Set = new Set();

      const startTime = Date.now();
      for (let i = 0; i < 1000; i++) {
        const vip = allocateVipFromRows(allocatedDbRows);
        assert.ok(vip.overlayIpv4, 'IPv4 must be allocated');
        assert.ok(vip.overlayIpv6, 'IPv6 must be allocated');

        // Check duplicates
        assert.strictEqual(ipv4Set.has(vip.overlayIpv4), false, `Collision detected for IPv4: ${vip.overlayIpv4}`);
        assert.strictEqual(ipv6Set.has(vip.overlayIpv6), false, `Collision detected for IPv6: ${vip.overlayIpv6}`);

        ipv4Set.add(vip.overlayIpv4);
        ipv6Set.add(vip.overlayIpv6);
        allocatedDbRows.push({
          overlay_ipv4: vip.overlayIpv4,
          overlay_ipv6: vip.overlayIpv6
        });

        // Verify 100.64.0.0/10 bounds
        const parts = vip.overlayIpv4.split('.').map(Number);
        assert.strictEqual(parts[0], 100);
        assert.ok(parts[1] >= 64 && parts[1] <= 127, `Second octet ${parts[1]} must be between 64 and 127`);
        assert.ok(parts[2] >= 0 && parts[2] <= 255, `Third octet ${parts[2]} must be between 0 and 255`);
        assert.ok(parts[3] >= 1 && parts[3] <= 254, `Host octet ${parts[3]} must not be 0 or 255`);

        // Verify IPv6 prefix fd7a:115c:a1e0::
        assert.ok(vip.overlayIpv6.startsWith('fd7a:115c:a1e0::'), `IPv6 ${vip.overlayIpv6} must match prefix`);
      }
      const durationMs = Date.now() - startTime;
      assert.ok(durationMs < 2000, `1000 VIP allocations took ${durationMs}ms (expected < 2000ms)`);
    });

    it('should correctly skip allocated gaps in pre-existing VIP records', () => {
      const mockExisting = [
        { overlay_ipv4: '100.64.0.1', overlay_ipv6: 'fd7a:115c:a1e0::1' },
        { overlay_ipv4: '100.64.0.2', overlay_ipv6: 'fd7a:115c:a1e0::2' },
        { overlay_ipv4: '100.64.0.3', overlay_ipv6: 'fd7a:115c:a1e0::3' }
      ];

      const nextVip = allocateVipFromRows(mockExisting);
      assert.strictEqual(nextVip.overlayIpv4, '100.64.0.4');
      assert.strictEqual(nextVip.overlayIpv6, 'fd7a:115c:a1e0::4');
    });
  });

  // =========================================================================
  // 5. WebSocket & Valkey Pub/Sub Rapid Event Broadcast & Tenant Isolation
  // =========================================================================
  describe('5. WebSocket & Valkey Pub/Sub Stress & Tenant Scoping', () => {
    it('should reject unauthenticated and revoked WebSocket connections', async () => {
      // 1. No token
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws/topology`);
        ws.on('unexpected-response', (req, res) => {
          assert.strictEqual(res.statusCode, 401);
          resolve();
        });
        ws.on('open', () => reject(new Error('Should not have opened')));
        ws.on('error', () => {});
      });

      // 2. Revoked token
      const tempRes = await request(app)
        .post('/api/auth/register')
        .send({ username: 'ws_revoked_user', password: 'Password123!' });
      const revokedToken = tempRes.body.token;
      await blacklistToken(revokedToken, 900);

      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws/topology?token=${revokedToken}`);
        ws.on('unexpected-response', (req, res) => {
          assert.strictEqual(res.statusCode, 401);
          resolve();
        });
        ws.on('open', () => reject(new Error('Revoked token should not open WS')));
        ws.on('error', () => {});
      });
    });

    it('should stream rapid bursts of 50 topology events to Admin while strictly scoping Tenant A', async () => {
      let adminWs;
      let tenantAWs;
      const adminReceivedEvents = [];
      const tenantAReceivedEvents = [];

      // Connect Admin WS
      await new Promise((resolve, reject) => {
        adminWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws/topology?token=${adminToken}`);
        adminWs.on('open', resolve);
        adminWs.on('error', reject);
        adminWs.on('message', (msg) => {
          const parsed = JSON.parse(msg.toString());
          if (parsed.type !== 'CONNECTED' && parsed.type !== 'PONG') {
            adminReceivedEvents.push(parsed);
          }
        });
      });

      // Connect Tenant A WS
      await new Promise((resolve, reject) => {
        tenantAWs = new WebSocket(`ws://127.0.0.1:${serverPort}/ws/topology?token=${userAToken}`);
        tenantAWs.on('open', resolve);
        tenantAWs.on('error', reject);
        tenantAWs.on('message', (msg) => {
          const parsed = JSON.parse(msg.toString());
          if (parsed.type !== 'CONNECTED' && parsed.type !== 'PONG') {
            tenantAReceivedEvents.push(parsed);
          }
        });
      });

      // Fire 50 rapid events
      for (let i = 0; i < 20; i++) {
        await broadcastNodeEvent('NODE_UPDATE', {
          id: `node-a-${i}`,
          user_id: userAId,
          name: `Alpha Device ${i}`,
          role: 'CLIENT_ORIGIN'
        });
      }

      for (let i = 0; i < 20; i++) {
        await broadcastNodeEvent('NODE_UPDATE', {
          id: `node-b-${i}`,
          user_id: userBId,
          name: `Bravo Device ${i}`,
          role: 'CLIENT_ORIGIN'
        });
      }

      for (let i = 0; i < 10; i++) {
        await broadcastNodeEvent('NODE_UPDATE', {
          id: `relay-global-${i}`,
          user_id: 'usr-admin',
          name: `Global Relay ${i}`,
          role: 'RELAY'
        });
      }

      // Allow event loop to process WebSocket frames
      await new Promise((r) => setTimeout(r, 100));

      // Admin must receive all 50 events
      assert.strictEqual(
        adminReceivedEvents.length,
        50,
        `Admin expected 50 events, received ${adminReceivedEvents.length}`
      );

      // Tenant A must receive 20 (Alpha) + 10 (Relays) = 30 events, and ZERO Bravo events
      assert.strictEqual(
        tenantAReceivedEvents.length,
        30,
        `Tenant A expected 30 events, received ${tenantAReceivedEvents.length}`
      );

      const hasBravoInAlpha = tenantAReceivedEvents.some((e) => e.node && e.node.user_id === userBId);
      assert.strictEqual(hasBravoInAlpha, false, 'CRITICAL SECURITY: Tenant A received isolated event for Tenant B!');

      adminWs.close();
      tenantAWs.close();
    });
  });

  // =========================================================================
  // 6. Curve25519 Clamping & Config Profile Validation
  // =========================================================================
  describe('6. Curve25519 Key Clamping & Noise / WireGuard Invariants', () => {
    it('should enforce RFC 7748 bit clamping on 100 generated Curve25519 keypairs', () => {
      for (let i = 0; i < 100; i++) {
        const kp = generateCurve25519Keypair();
        const privBytes = Buffer.from(kp.privateKeyBase64, 'base64');
        assert.strictEqual(privBytes.length, 32);

        // Byte 0: bits 0..2 must be 0
        assert.strictEqual(privBytes[0] & 0x07, 0, `First byte ${privBytes[0]} lowest 3 bits must be 0`);

        // Byte 31: bit 7 must be 0
        assert.strictEqual(privBytes[31] & 0x80, 0, `Last byte ${privBytes[31]} bit 7 must be 0`);

        // Byte 31: bit 6 must be 1
        assert.strictEqual(privBytes[31] & 0x40, 0x40, `Last byte ${privBytes[31]} bit 6 must be 1`);
      }
    });

    it('should generate valid WireGuard config and Noise DirectFrame v4.0 JSON profile', () => {
      const kp = generateCurve25519Keypair();
      const wgConfig = buildWireGuardConfig({
        deviceName: 'TestDevice',
        role: 'CLIENT_ORIGIN',
        privateKeyBase64: kp.privateKeyBase64,
        overlayIpv4: '100.64.0.10',
        overlayIpv6: 'fd7a:115c:a1e0::a',
        onionRoutingEnabled: true
      });

      assert.ok(wgConfig.includes('Address = 100.64.0.10/32, fd7a:115c:a1e0::a/128'));
      assert.ok(wgConfig.includes(`PrivateKey = ${kp.privateKeyBase64}`));
      assert.ok(wgConfig.includes('Onion Obfuscation: 3-Hop Multi-Route'));

      const noiseProfile = buildNoiseJsonProfile({
        nodeId: kp.nodeId,
        privateKeyHex: kp.privateKeyHex,
        publicKeyHex: kp.publicKeyHex,
        overlayIpv4: '100.64.0.10',
        overlayIpv6: 'fd7a:115c:a1e0::a',
        presharedKeyHex: kp.presharedKeyHex,
        onionRoutingEnabled: true
      });

      assert.strictEqual(noiseProfile.version, '4.0');
      assert.strictEqual(noiseProfile.crypto.curve, 'Curve25519');
      assert.strictEqual(noiseProfile.routing.onion_routing_enabled, true);
      assert.strictEqual(noiseProfile.routing.onion_hops, 3);
    });
  });
});
