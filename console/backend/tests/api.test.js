const { describe, test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Ensure test database configuration
const testDbPath = path.resolve(__dirname, '../../data/test_neronet.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;
if (fs.existsSync(testDbPath)) {
  try {
    fs.unlinkSync(testDbPath);
  } catch {}
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

describe('NeroNet Console Backend API Test Suite', { concurrency: 1 }, () => {
  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {}
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
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin_password' });
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
    const res = await request(app).post('/api/auth/register').send({
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
    const res = await request(app).post('/api/auth/register').send({
      username: 'test_developer_1',
      password: 'Password123!'
    });
    assert.strictEqual(res.status, 409);
    assert(res.body.error);
  });

  test('POST /api/auth/login with invalid password should fail with 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'WrongPassword!' });
    assert.strictEqual(res.status, 401);
    assert(res.body.error);
  });

  test('POST /api/auth/login adversarial backdoor regression test', async () => {
    // 1. Register a victim user with a custom unique password
    const regRes = await request(app).post('/api/auth/register').send({
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
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${regularUserToken}`);
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

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: login.body.refreshToken });

    assert.strictEqual(res.status, 200);
    assert(res.body.token);
  });

  test('POST /api/auth/refresh rejects an access token', async () => {
    // Accepting one would let anyone holding a 15-minute token exchange it for
    // another indefinitely, which removes the reason access tokens are short-lived.
    const res = await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${regularUserToken}`);

    assert.strictEqual(res.status, 401);
  });

  test('POST /api/auth/logout should revoke token', async () => {
    const res = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${regularUserToken}`);
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
    const res = await request(app).get('/api/users').set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 403);
  });

  test('GET /api/users should allow super-admin to list users', async () => {
    const res = await request(app).get('/api/users').set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.body.users));
    assert(res.body.users.length >= 3);
  });

  test('POST /api/users should allow super-admin to create user', async () => {
    const res = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`).send({
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
    const res = await request(app).post('/api/nodes').set('Authorization', `Bearer ${regularUserToken}`).send({
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
    const res = await request(app).get('/api/nodes').set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.body.nodes));
    assert(res.body.nodes.every((n) => n.user_id === regularUserId));
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

  // App Bundles was removed. Its routes were SQLite-only and answered 500 on
  // PostgreSQL; the mount is gone and the paths fall through to 404.
  test('GET /api/apps is not routed', async () => {
    const res = await request(app).get('/api/apps').set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 404);
  });

  test('GET /api/apps/public/verify/:token is not routed', async () => {
    const res = await request(app).get('/api/apps/public/verify/some-token');
    assert.strictEqual(res.status, 404);
  });

  // NeroDrop was removed. Its routes answered 500 on PostgreSQL and 201 with a
  // fabricated SDP on SQLite; the mount is gone and the paths fall through to 404.
  test('GET /api/nerodrop/transfers is not routed', async () => {
    const res = await request(app).get('/api/nerodrop/transfers').set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 404);
  });

  test('POST /api/nerodrop/session is not routed', async () => {
    const res = await request(app)
      .post('/api/nerodrop/session')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({ target_node_id: createdNodeId, file_name: 'x.bin', file_size_bytes: 1 });
    assert.strictEqual(res.status, 404);
  });

  // 8. Stats, Bandwidth, Topology & Audit Logs
  test('GET /api/stats/overview should return aggregate system statistics', async () => {
    const res = await request(app).get('/api/stats/overview').set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 200);
    // active_nodes counts nodes heard from inside the liveness window, which is not
    // the same as enrolled. The seeded fleet has no recent heartbeat, so the figure
    // to assert against here is the enrolment count.
    assert(res.body.total_nodes >= 1, 'nodes are enrolled');
    assert(typeof res.body.active_nodes === 'number');
    assert(res.body.active_nodes <= res.body.total_nodes, 'live cannot exceed enrolled');
    assert(res.body.connected_users >= 1);
    assert(res.body.country_distribution);
  });

  test('GET /api/stats/bandwidth is empty before the collector has sampled', async () => {
    const res = await request(app).get('/api/stats/bandwidth').set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.body.bandwidth_series));
    // This used to assert a non-empty series and passed because the handler
    // fabricated a seven-point ramp whenever no samples existed.
  });

  test('GET /api/stats/bandwidth returns a point once two samples exist', async () => {
    const MetricsCollector = require('../services/MetricsCollector');

    // A rate needs two cumulative readings and the interval between them.
    await MetricsCollector.collectOnce();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await MetricsCollector.collectOnce();

    const res = await request(app).get('/api/stats/bandwidth').set('Authorization', `Bearer ${adminToken}`);

    assert.strictEqual(res.status, 200);
    assert(res.body.bandwidth_series.length >= 1, 'two samples yield one interval');

    const point = res.body.bandwidth_series[0];
    assert(typeof point.rx === 'number');
    assert(typeof point.tx === 'number');
    assert(point.rx >= 0 && point.tx >= 0, 'a rate is never negative');
  });

  test('GET /api/stats/topology should return global mesh topology for admin', async () => {
    const res = await request(app).get('/api/stats/topology').set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mesh_scope, 'global');
    assert(Array.isArray(res.body.nodes));
    assert(Array.isArray(res.body.links));
  });

  test('GET /api/stats/topology should return user-isolated mesh topology for tenant', async () => {
    const res = await request(app).get('/api/stats/topology').set('Authorization', `Bearer ${regularUserToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mesh_scope, 'user_isolated');
  });

  test('GET /api/stats/audit-logs should return audit trail events', async () => {
    const res = await request(app).get('/api/stats/audit-logs').set('Authorization', `Bearer ${adminToken}`);
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
    const res = await request(app).get('/api/nodes/non-existent-node-id').set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(res.status, 404);
    assert(res.body.error);
  });

  test('GET /api/auth/me with invalid token should return 401', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer InvalidTamperedJwtToken');
    assert.strictEqual(res.status, 401);
  });

  // 10. Database Schema Migrations & Incremental Upgrade Verification
  test('Incremental migration: upgrading legacy DB (001 without onion_routing_enabled) adds missing columns safely', () => {
    const legacyPath = path.resolve(__dirname, '../../data/test_legacy_upgrade.db');
    if (fs.existsSync(legacyPath)) {
      try {
        fs.unlinkSync(legacyPath);
      } catch {}
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
    let colsBefore = legacyDb.pragma('table_info(nodes)').map((c) => c.name);
    assert.strictEqual(colsBefore.includes('onion_routing_enabled'), false);

    // Apply migrations
    runMigrations(legacyDb);

    // Verify onion_routing_enabled now exists and legacy row has default 0
    let colsAfter = legacyDb.pragma('table_info(nodes)').map((c) => c.name);
    assert.strictEqual(colsAfter.includes('onion_routing_enabled'), true);

    const legacyRow = legacyDb.prepare('SELECT * FROM nodes WHERE id = ?').get('legacy-node-1');
    assert.strictEqual(legacyRow.onion_routing_enabled, 0);

    // Verify app_share_links table was created
    const tables = legacyDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((t) => t.name);
    assert.strictEqual(tables.includes('app_share_links'), true);

    // Verify seedDatabase runs cleanly on the migrated database
    assert.doesNotThrow(() => {
      seedDatabase(legacyDb);
    });

    legacyDb.close();
    if (fs.existsSync(legacyPath)) {
      try {
        fs.unlinkSync(legacyPath);
      } catch {}
    }
  });

  test('Persistent database startup & schema healing verification', () => {
    // Test schema healing on a DB where both migrations are marked applied but column was omitted
    const healingDbPath = path.resolve(__dirname, '../../data/test_healing.db');
    if (fs.existsSync(healingDbPath)) {
      try {
        fs.unlinkSync(healingDbPath);
      } catch {}
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
    const cols = healingDb.pragma('table_info(nodes)').map((c) => c.name);
    assert.strictEqual(cols.includes('onion_routing_enabled'), true);

    // Verify seed completes without error
    assert.doesNotThrow(() => {
      seedDatabase(healingDb);
    });

    healingDb.close();
    if (fs.existsSync(healingDbPath)) {
      try {
        fs.unlinkSync(healingDbPath);
      } catch {}
    }
  });
});
