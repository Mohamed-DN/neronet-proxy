const { describe, test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Ensure test database configuration
const testDbPath = path.resolve(__dirname, '../../data/test_neronet.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;
if (fs.existsSync(testDbPath)) {
  try { fs.unlinkSync(testDbPath); } catch {}
}

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const { seedDatabase } = require('../db/seed');
const { createApp } = require('../server');

// Initialize database
const db = getDatabase(testDbPath);
runMigrations(db);
seedDatabase(db);

const app = createApp();

let adminToken = '';
let regularUserToken = '';
let regularUserId = '';
let createdNodeId = '';
let createdAppId = '';
let createdDropSessionId = '';
let createdShareLinkId = '';
let createdShareToken = '';

describe('NeroNet Console Backend API Test Suite', { concurrency: 1 }, () => {

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  });

  // 1. Health Checks
  test('GET /api/health should return liveness and database status', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.database, 'connected');
    assert.strictEqual(res.body.version, '4.0.0');
    assert(typeof res.body.uptime_seconds === 'number');
    assert(res.body.timestamp);
  });

  test('POST /api/auth/login with admin credentials should succeed', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin_password' });
    assert.strictEqual(res.status, 200);
    assert(res.body.token);
    assert.strictEqual(res.body.user.role, 'super-admin');
    assert.strictEqual(res.body.user.username, 'admin');
    adminToken = res.body.token;
  });

  test('POST /api/auth/login with seeded demo user (alice_homelab) should succeed', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice_homelab', password: 'Password123!' });
    assert.strictEqual(res.status, 200);
    assert(res.body.token);
    assert.strictEqual(res.body.user.username, 'alice_homelab');
  });

  test('POST /api/auth/register should create new tenant user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'test_developer_1',
        password: 'Password123!'
      });
    assert.strictEqual(res.status, 201);
    assert(res.body.token);
    assert.strictEqual(res.body.user.username, 'test_developer_1');
    regularUserToken = res.body.token;
    regularUserId = res.body.user.id;
  });

  test('POST /api/auth/register with duplicate username should fail with 409', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'test_developer_1',
        password: 'Password123!'
      });
    assert.strictEqual(res.status, 409);
    assert(res.body.error);
  });

  test('POST /api/auth/login with invalid password should fail with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'WrongPassword!' });
    assert.strictEqual(res.status, 401);
    assert(res.body.error);
  });

  test('POST /api/auth/login adversarial backdoor regression test', async () => {
    // 1. Register a victim user with a custom unique password
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'victim_tenant_sec',
        password: 'SuperSecretUniquePass!2026'
      });
    assert.strictEqual(regRes.status, 201);

    // 2. Attempt login with common backdoor/fallback password 'Password123!' -> MUST fail 401
    const backdoorAttempt = await request(app)
      .post('/api/auth/login')
      .send({ username: 'victim_tenant_sec', password: 'Password123!' });
    assert.strictEqual(backdoorAttempt.status, 401);

    // 3. Attempt login with admin backdoor password 'admin123' -> MUST fail 401
    const adminBackdoorAttempt = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });
    assert.strictEqual(adminBackdoorAttempt.status, 401);

    // 4. Attempt login with genuine custom password -> MUST succeed 200
    const genuineLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'victim_tenant_sec', password: 'SuperSecretUniquePass!2026' });
    assert.strictEqual(genuineLogin.status, 200);
    assert(genuineLogin.body.token);
  });

  test('GET /api/auth/me should return current authenticated user', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.username, 'test_developer_1');
    assert.strictEqual(res.body.user.id, regularUserId);
  });

  test('POST /api/auth/refresh should return refreshed JWT token', async () => {
    // Log in to obtain a real refresh token. This test used to send the access
    // token, which passed only because /refresh accepted either -- the defect it
    // was supposed to be exercising.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice_homelab', password: 'Password123!' });

    assert.ok(login.body.refreshToken, 'login must issue a refresh token');

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });

    assert.strictEqual(res.status, 200);
    assert(res.body.token);
  });

  test('POST /api/auth/refresh rejects an access token', async () => {
    // Accepting one would let anyone holding a 15-minute token exchange it for
    // another indefinitely, which removes the reason access tokens are short-lived.
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${regularUserToken}`);

    assert.strictEqual(res.status, 401);
  });

  test('POST /api/auth/logout should revoke token', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  // Re-login regular user for subsequent tests
  test('Re-login regular user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'test_developer_1', password: 'Password123!' });
    assert.strictEqual(res.status, 200);
    regularUserToken = res.body.token;
  });

  // 3. User Management & RBAC
  test('GET /api/users should forbid regular user with 403', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 403);
  });

  test('GET /api/users should allow super-admin to list users', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.body.users));
    assert(res.body.users.length >= 3);
  });

  test('POST /api/users should allow super-admin to create user', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        username: 'managed_user_2',
        password: 'Password123!',
        role: 'user'
      });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.user.username, 'managed_user_2');
  });

  test('GET /api/users/:id/quota reports usage, not entitlement', async () => {
    const res = await request(app)
      .get(`/api/users/${regularUserId}/quota`)
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user_id, regularUserId);
    // No tiers and no caps: how many nodes an account has is still worth
    // reporting, what it is allowed is no longer a thing that exists.
    assert(typeof res.body.used_nodes === 'number');
    assert.strictEqual(res.body.max_nodes, undefined);
    assert(typeof res.body.used_nodes === 'number');
  });

  // 4. Node Management & Quick Actions
  test('POST /api/nodes should register a new node with VIP allocation', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({
        name: 'Work-MacBook-M3',
        role: 'CLIENT_ORIGIN',
        country_code: 'US'
      });
    assert.strictEqual(res.status, 201);
    assert(res.body.node.id);
    assert.strictEqual(res.body.node.name, 'Work-MacBook-M3');
    assert(res.body.node.overlay_ipv4.startsWith('100.64.0.'));
    createdNodeId = res.body.node.id;
  });

  test('GET /api/nodes should return user-scoped nodes for regular user', async () => {
    const res = await request(app)
      .get('/api/nodes')
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.body.nodes));
    assert(res.body.nodes.every(n => n.user_id === regularUserId));
  });

  test('POST /api/nodes/:id/action with ping should return RTT latency', async () => {
    const res = await request(app)
      .post(`/api/nodes/${createdNodeId}/action`)
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({ action: 'ping' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert(res.body.result.rtt_ms > 0);
  });

  test('POST /api/nodes/:id/action with set_exit should designate node as exit bridge', async () => {
    const res = await request(app)
      .post(`/api/nodes/${createdNodeId}/action`)
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({ action: 'set_exit' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.result.is_exit_node, true);
  });

  test('POST /api/nodes/:id/action with toggle_onion should toggle 3-hop onion obfuscation', async () => {
    const toggleOnRes = await request(app)
      .post(`/api/nodes/${createdNodeId}/action`)
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({ action: 'toggle_onion' });
    assert.strictEqual(toggleOnRes.status, 200);
    assert.strictEqual(toggleOnRes.body.success, true);
    assert.strictEqual(Boolean(toggleOnRes.body.onion_routing_enabled), true);
    assert.strictEqual(toggleOnRes.body.onion_hops, 3);
    assert.strictEqual(Boolean(toggleOnRes.body.result.onion_routing_enabled), true);
    assert.strictEqual(toggleOnRes.body.result.onion_hops, 3);

    const toggleOffRes = await request(app)
      .post(`/api/nodes/${createdNodeId}/action`)
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({ action: 'toggle_onion' });
    assert.strictEqual(toggleOffRes.status, 200);
    assert.strictEqual(Boolean(toggleOffRes.body.onion_routing_enabled), false);
    assert.strictEqual(toggleOffRes.body.onion_hops, 0);
  });

  test('POST /api/nodes/:id/action with quarantine should isolate node', async () => {
    const res = await request(app)
      .post(`/api/nodes/${createdNodeId}/action`)
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({ action: 'quarantine', reason: 'High packet loss anomaly' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.result.is_quarantined, true);
    assert.strictEqual(res.body.result.status, 'quarantined');
  });

  test('POST /api/nodes/:id/heartbeat should update node telemetry', async () => {
    const res = await request(app)
      .post(`/api/nodes/${createdNodeId}/heartbeat`)
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({
        latency_ms: 18.5,
        rx_bytes: 5242880,
        tx_bytes: 1048576,
        cpu_usage_pct: 14.2
      });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  // 5. Config Generator & Curve25519 Clamping
  test('POST /api/configs/generate should produce Curve25519 clamped WireGuard and Noise profile', async () => {
    const res = await request(app)
      .post('/api/configs/generate')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({
        name: 'iPhone-Mobile-Client',
        role: 'CLIENT_ORIGIN',
        country_code: 'US'
      });
    assert.strictEqual(res.status, 200);
    assert(res.body.node_id);
    assert(res.body.private_key);
    assert(res.body.public_key);
    assert(res.body.wireguard_conf.includes('[Interface]'));
    assert(res.body.wireguard_conf.includes('[Peer]'));
    assert.strictEqual(res.body.json_profile.version, '4.0');
    assert(res.body.qrcode_data_url.startsWith('data:image/'));

    // Check Curve25519 bit clamping
    const privBuffer = Buffer.from(res.body.private_key, 'base64');
    assert.strictEqual(privBuffer.length, 32);
    assert.strictEqual(privBuffer[0] & 7, 0, 'Lowest 3 bits of first byte must be 0');
    assert.strictEqual(privBuffer[31] & 128, 0, 'Highest bit of 32nd byte must be 0');
    assert.strictEqual(privBuffer[31] & 64, 64, 'Second highest bit of 32nd byte must be 1');
  });

  test('POST /api/configs/generate with onion_routing_enabled should configure 3-hop Noise DirectFrame circuit', async () => {
    const res = await request(app)
      .post('/api/configs/generate')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({
        name: 'Tor-Obfuscated-MacBook',
        role: 'CLIENT_ORIGIN',
        country_code: 'DE',
        onion_routing_enabled: true
      });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(Boolean(res.body.onion_routing_enabled), true);
    assert.strictEqual(res.body.onion_hops, 3);
    assert.strictEqual(res.body.json_profile.routing.onion_routing_enabled, true);
    assert.strictEqual(res.body.json_profile.routing.onion_hops, 3);
    assert(res.body.wireguard_conf.includes('3-Hop Multi-Route'));
  });

  test('GET /api/configs/wireguard/:id should retrieve WireGuard config', async () => {
    const res = await request(app)
      .get(`/api/configs/wireguard/${createdNodeId}`)
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert(res.body.wireguard_conf.includes('[Interface]'));
  });

  test('GET /api/configs/noise/:id should retrieve Noise DirectFrame JSON profile', async () => {
    const res = await request(app)
      .get(`/api/configs/noise/${createdNodeId}`)
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.json_profile.version, '4.0');
    assert.strictEqual(res.body.json_profile.crypto.curve, 'Curve25519');
    assert.strictEqual(typeof res.body.json_profile.routing.onion_hops, 'number');
  });

  // 6. App Bundles Lifecycle & Fast SSO Wakeup
  test('POST /api/apps should provision a new app bundle', async () => {
    const res = await request(app)
      .post('/api/apps')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({
        name: 'My Guacamole Gateway',
        type: 'guacamole',
        memory_mb: 4096,
        storage_gb: 50
      });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.app.type, 'guacamole');
    assert.strictEqual(res.body.app.status, 'stopped');
    createdAppId = res.body.app.id;
  });

  test('POST /api/apps with invalid type should fail with 400', async () => {
    const res = await request(app)
      .post('/api/apps')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({
        name: 'Invalid App',
        type: 'unsupported_app_type'
      });
    assert.strictEqual(res.status, 400);
  });

  test('POST /api/apps/:id/start and stop should transition states', async () => {
    const startRes = await request(app)
      .post(`/api/apps/${createdAppId}/start`)
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(startRes.status, 200);
    assert.strictEqual(startRes.body.app.status, 'running');

    const stopRes = await request(app)
      .post(`/api/apps/${createdAppId}/stop`)
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(stopRes.status, 200);
    assert.strictEqual(stopRes.body.app.status, 'stopped');
  });

  test('POST /api/apps/:id/scale-to-zero should hibernate app', async () => {
    const res = await request(app)
      .post(`/api/apps/${createdAppId}/scale-to-zero`)
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.app.status, 'hibernated');
  });

  test('GET /api/apps/:id/launch should wake hibernated app and return SSO token', async () => {
    const res = await request(app)
      .get(`/api/apps/${createdAppId}/launch`)
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'running');
    assert(res.body.sso_token.startsWith('sso_'));
    assert(res.body.launch_url.includes('darknero.com'));
  });

  // 6.1 Guacamole Public Share Links (Clientless RDP)
  test('POST /api/apps/:id/share should generate a clientless public share link', async () => {
    const res = await request(app)
      .post(`/api/apps/${createdAppId}/share`)
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({
        auth_mode: 'temporary_password',
        expires_in_hours: 24,
        max_uses: 5
      });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert(res.body.share_link.id);
    assert(res.body.share_link.share_token);
    assert(res.body.share_link.public_url.includes(res.body.share_link.share_token));
    assert.strictEqual(res.body.share_link.auth_mode, 'temporary_password');
    assert(res.body.share_link.temporary_password.startsWith('SVRN-'));
    assert.strictEqual(res.body.share_link.max_uses, 5);
    assert.strictEqual(res.body.share_link.use_count, 0);
    assert.strictEqual(res.body.share_link.is_revoked, false);
    createdShareLinkId = res.body.share_link.id;
    createdShareToken = res.body.share_link.share_token;
  });

  test('GET /api/apps/:id/share-links should list active share links for app', async () => {
    const res = await request(app)
      .get(`/api/apps/${createdAppId}/share-links`)
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.body.share_links));
    assert(res.body.share_links.length >= 1);
    const found = res.body.share_links.find(l => l.id === createdShareLinkId);
    assert(found);
    assert.strictEqual(found.share_token, createdShareToken);
  });

  test('GET /api/apps/public/verify/:token (unauthenticated) should verify share token and return RDP gateway details', async () => {
    const res = await request(app)
      .get(`/api/apps/public/verify/${createdShareToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.valid, true);
    assert.strictEqual(res.body.app_id, createdAppId);
    assert.strictEqual(res.body.gateway_protocol, 'guacamole_clientless_rdp');
    assert.strictEqual(res.body.auth_mode, 'temporary_password');
    assert.strictEqual(res.body.requires_password, true);
    assert(res.body.websocket_endpoint.includes('guac-tunnel'));
    assert(res.body.session_token.startsWith('sess_pub_'));
    assert.strictEqual(res.body.use_count, 1);
  });

  test('DELETE /api/apps/:id/share-links/:linkId should revoke share link', async () => {
    const res = await request(app)
      .delete(`/api/apps/${createdAppId}/share-links/${createdShareLinkId}`)
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  test('GET /api/apps/public/verify/:token with revoked token should fail with 403', async () => {
    const res = await request(app)
      .get(`/api/apps/public/verify/${createdShareToken}`);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.valid, false);
    assert.strictEqual(res.body.is_revoked, true);
  });

  // 7. NeroDrop P2P File Transfer Signaling
  test('POST /api/nerodrop/session should initiate P2P file transfer session', async () => {
    const res = await request(app)
      .post('/api/nerodrop/session')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({
        target_node_id: createdNodeId,
        file_name: 'production_database_backup.tar.gz',
        file_size_bytes: 104857600
      });
    assert.strictEqual(res.status, 201);
    assert(res.body.session_id);
    assert.strictEqual(res.body.status, 'ready');
    assert(res.body.webrtc_signal.sdp);
    createdDropSessionId = res.body.session_id;
  });

  test('PUT /api/nerodrop/transfers/:id/progress should update chunk progress', async () => {
    const res = await request(app)
      .put(`/api/nerodrop/transfers/${createdDropSessionId}/progress`)
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({
        transferred_chunks: 800,
        bytes_transferred: 52428800,
        status: 'transferring'
      });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.session.transferred_chunks, 800);
  });

  test('POST /api/nerodrop/transfers/:id/cancel should cancel transfer session', async () => {
    const res = await request(app)
      .post(`/api/nerodrop/transfers/${createdDropSessionId}/cancel`)
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'cancelled');
  });

  // 8. Stats, Bandwidth, Topology & Audit Logs
  test('GET /api/stats/overview should return aggregate system statistics', async () => {
    const res = await request(app)
      .get('/api/stats/overview')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 200);
    assert(res.body.active_nodes >= 1);
    assert(res.body.connected_users >= 1);
    assert(res.body.country_distribution);
  });

  test('GET /api/stats/bandwidth should return time-series metrics', async () => {
    const res = await request(app)
      .get('/api/stats/bandwidth')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.body.bandwidth_series));
    assert(res.body.bandwidth_series.length > 0);
  });

  test('GET /api/stats/topology should return global mesh topology for admin', async () => {
    const res = await request(app)
      .get('/api/stats/topology')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mesh_scope, 'global');
    assert(Array.isArray(res.body.nodes));
    assert(Array.isArray(res.body.links));
  });

  test('GET /api/stats/topology should return user-isolated mesh topology for tenant', async () => {
    const res = await request(app)
      .get('/api/stats/topology')
      .set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mesh_scope, 'user_isolated');
  });

  test('GET /api/stats/audit-logs should return audit trail events', async () => {
    const res = await request(app)
      .get('/api/stats/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.body.audit_logs));
    assert(res.body.audit_logs.length > 0);
  });

  // 9. Negative & Error Handling
  test('GET /api/nonexistent_endpoint should return 404', async () => {
    const res = await request(app).get('/api/nonexistent_endpoint');
    assert.strictEqual(res.status, 404);
    assert(res.body.error);
  });

  test('GET /api/nodes/:id with non-existent id should return 404', async () => {
    const res = await request(app)
      .get('/api/nodes/non-existent-node-id')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 404);
    assert(res.body.error);
  });

  test('GET /api/auth/me with invalid token should return 401', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer InvalidTamperedJwtToken');
    assert.strictEqual(res.status, 401);
  });

  // 10. Database Schema Migrations & Incremental Upgrade Verification
  test('Incremental migration: upgrading legacy DB (001 without onion_routing_enabled) adds missing columns safely', () => {
    const legacyPath = path.resolve(__dirname, '../../data/test_legacy_upgrade.db');
    if (fs.existsSync(legacyPath)) {
      try { fs.unlinkSync(legacyPath); } catch {}
    }
    const legacyDb = getDatabase(legacyPath);
    
    // Simulate a database from Milestone 5 that had 001_initial_schema without onion_routing_enabled
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO _migrations (name) VALUES ('001_initial_schema');

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        tier TEXT NOT NULL DEFAULT 'free_core',
        status TEXT NOT NULL DEFAULT 'active',
        bandwidth_quota_gb INTEGER NOT NULL DEFAULT 100,
        bandwidth_used_bytes INTEGER NOT NULL DEFAULT 0,
        max_nodes INTEGER NOT NULL DEFAULT 5,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL UNIQUE,
        preshared_key TEXT,
        overlay_ipv4 TEXT NOT NULL UNIQUE,
        overlay_ipv6 TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'CLIENT_ORIGIN',
        ip_class TEXT NOT NULL DEFAULT 'RESIDENTIAL',
        country_code TEXT NOT NULL DEFAULT 'US',
        city TEXT DEFAULT '',
        asn INTEGER DEFAULT 0,
        endpoints TEXT DEFAULT '[]',
        is_healthy INTEGER NOT NULL DEFAULT 1,
        is_quarantined INTEGER NOT NULL DEFAULT 0,
        quarantine_reason TEXT,
        last_heartbeat DATETIME,
        latency_ms REAL NOT NULL DEFAULT 0.0,
        tx_bytes INTEGER NOT NULL DEFAULT 0,
        rx_bytes INTEGER NOT NULL DEFAULT 0,
        cpu_usage_pct REAL DEFAULT 0.0,
        memory_usage_pct REAL DEFAULT 0.0,
        battery_pct REAL DEFAULT 100.0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_bundles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'managed_cloud',
        status TEXT NOT NULL DEFAULT 'stopped',
        endpoint_url TEXT NOT NULL,
        internal_port INTEGER NOT NULL DEFAULT 8080,
        cpu_cores REAL NOT NULL DEFAULT 2.0,
        memory_mb INTEGER NOT NULL DEFAULT 2048,
        storage_gb INTEGER NOT NULL DEFAULT 50,
        scale_to_zero INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        actor_user_id TEXT,
        actor_username TEXT,
        target_id TEXT,
        target_type TEXT,
        message TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        metadata_json TEXT DEFAULT '{}',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS system_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        active_nodes INTEGER NOT NULL DEFAULT 0,
        active_users INTEGER NOT NULL DEFAULT 0,
        total_bandwidth_rx INTEGER NOT NULL DEFAULT 0,
        total_bandwidth_tx INTEGER NOT NULL DEFAULT 0,
        cpu_usage_pct REAL NOT NULL DEFAULT 0.0,
        memory_usage_mb REAL NOT NULL DEFAULT 0.0,
        active_circuits INTEGER NOT NULL DEFAULT 0,
        network_health_score INTEGER NOT NULL DEFAULT 100
      );

      INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6)
      VALUES ('legacy-node-1', 'usr-admin', 'Legacy-Worker-Node', 'pk-legacy-1111', '100.64.0.99', 'fd7a:115c:a1e0::99');
    `);

    // Verify onion_routing_enabled does NOT exist before migration
    let colsBefore = legacyDb.pragma('table_info(nodes)').map(c => c.name);
    assert.strictEqual(colsBefore.includes('onion_routing_enabled'), false);

    // Apply migrations
    runMigrations(legacyDb);

    // Verify onion_routing_enabled now exists and legacy row has default 0
    let colsAfter = legacyDb.pragma('table_info(nodes)').map(c => c.name);
    assert.strictEqual(colsAfter.includes('onion_routing_enabled'), true);

    const legacyRow = legacyDb.prepare('SELECT * FROM nodes WHERE id = ?').get('legacy-node-1');
    assert.strictEqual(legacyRow.onion_routing_enabled, 0);

    // Verify app_share_links table was created
    const tables = legacyDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    assert.strictEqual(tables.includes('app_share_links'), true);

    // Verify seedDatabase runs cleanly on the migrated database
    assert.doesNotThrow(() => {
      seedDatabase(legacyDb);
    });

    legacyDb.close();
    if (fs.existsSync(legacyPath)) {
      try { fs.unlinkSync(legacyPath); } catch {}
    }
  });

  test('Persistent database startup & schema healing verification', () => {
    // Test schema healing on a DB where both migrations are marked applied but column was omitted
    const healingDbPath = path.resolve(__dirname, '../../data/test_healing.db');
    if (fs.existsSync(healingDbPath)) {
      try { fs.unlinkSync(healingDbPath); } catch {}
    }
    const healingDb = getDatabase(healingDbPath);

    healingDb.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO _migrations (name) VALUES ('001_initial_schema'), ('002_onion_and_share_links');

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        tier TEXT NOT NULL DEFAULT 'free_core',
        status TEXT NOT NULL DEFAULT 'active',
        bandwidth_quota_gb INTEGER NOT NULL DEFAULT 100,
        bandwidth_used_bytes INTEGER NOT NULL DEFAULT 0,
        max_nodes INTEGER NOT NULL DEFAULT 5,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL UNIQUE,
        preshared_key TEXT,
        overlay_ipv4 TEXT NOT NULL UNIQUE,
        overlay_ipv6 TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'CLIENT_ORIGIN',
        ip_class TEXT NOT NULL DEFAULT 'RESIDENTIAL',
        country_code TEXT NOT NULL DEFAULT 'US',
        city TEXT DEFAULT '',
        asn INTEGER DEFAULT 0,
        endpoints TEXT DEFAULT '[]',
        is_healthy INTEGER NOT NULL DEFAULT 1,
        is_quarantined INTEGER NOT NULL DEFAULT 0,
        quarantine_reason TEXT,
        last_heartbeat DATETIME,
        latency_ms REAL NOT NULL DEFAULT 0.0,
        tx_bytes INTEGER NOT NULL DEFAULT 0,
        rx_bytes INTEGER NOT NULL DEFAULT 0,
        cpu_usage_pct REAL DEFAULT 0.0,
        memory_usage_pct REAL DEFAULT 0.0,
        battery_pct REAL DEFAULT 100.0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_bundles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'managed_cloud',
        status TEXT NOT NULL DEFAULT 'stopped',
        endpoint_url TEXT NOT NULL,
        internal_port INTEGER NOT NULL DEFAULT 8080,
        cpu_cores REAL NOT NULL DEFAULT 2.0,
        memory_mb INTEGER NOT NULL DEFAULT 2048,
        storage_gb INTEGER NOT NULL DEFAULT 50,
        scale_to_zero INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        actor_user_id TEXT,
        actor_username TEXT,
        target_id TEXT,
        target_type TEXT,
        message TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        metadata_json TEXT DEFAULT '{}',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS system_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        active_nodes INTEGER NOT NULL DEFAULT 0,
        active_users INTEGER NOT NULL DEFAULT 0,
        total_bandwidth_rx INTEGER NOT NULL DEFAULT 0,
        total_bandwidth_tx INTEGER NOT NULL DEFAULT 0,
        cpu_usage_pct REAL NOT NULL DEFAULT 0.0,
        memory_usage_mb REAL NOT NULL DEFAULT 0.0,
        active_circuits INTEGER NOT NULL DEFAULT 0,
        network_health_score INTEGER NOT NULL DEFAULT 100
      );
    `);

    // Run migrations (which executes ensureSchemaIntegrity)
    runMigrations(healingDb);

    // Verify onion_routing_enabled is restored
    const cols = healingDb.pragma('table_info(nodes)').map(c => c.name);
    assert.strictEqual(cols.includes('onion_routing_enabled'), true);

    // Verify seed completes without error
    assert.doesNotThrow(() => {
      seedDatabase(healingDb);
    });

    healingDb.close();
    if (fs.existsSync(healingDbPath)) {
      try { fs.unlinkSync(healingDbPath); } catch {}
    }
  });
});
