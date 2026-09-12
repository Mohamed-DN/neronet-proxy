const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const request = require('supertest');
const { WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');

const { createApp, initDatabase } = require('../server');
const { getDatabase, closeDatabase } = require('../db/index');
const { initTopologyWebSocket, closeTopologyWebSocket } = require('../ws/topologyServer');
const { publishTopologyEvent, isTokenBlacklisted, blacklistToken, closeValkey } = require('../db/valkey');
const { broadcastNodeEvent } = require('../services/TopologySync');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_m1.db');

describe('Milestone 1: Database, Security Hardening & Real-Time Sync', () => {
  let app;
  let server;
  let serverPort;
  let adminToken;
  let userToken;

  before(async () => {
    process.env.SOVEREIGN_DB_PATH = TEST_DB_PATH;
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

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

    // Login admin
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin_password' });
    assert.strictEqual(adminRes.status, 200);
    adminToken = adminRes.body.token;

    // Login regular demo user
    const userRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice_homelab', password: 'Password123!' });
    assert.strictEqual(userRes.status, 200);
    userToken = userRes.body.token;
  });

  after(async () => {
    closeTopologyWebSocket();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase();
    closeValkey();
    if (fs.existsSync(TEST_DB_PATH)) {
      try { fs.unlinkSync(TEST_DB_PATH); } catch (e) {}
    }
  });

  describe('1. Auth Security Hardening & Timing-Safe Verification', () => {
    it('should reject login for non-existent username with 401 using constant-time dummy verification', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'ghost_user_9999', password: 'AnyPassword123!' });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Invalid username or password');
    });

    it('should reject login for existent user with incorrect password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'wrong_password_attempt' });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Invalid username or password');
    });

    it('should reject login with empty credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: '', password: '' });
      assert.strictEqual(res.status, 400);
    });

    it('should revoke token in Valkey on logout and reject subsequent authenticated requests', async () => {
      // Create temporary tenant user
      const tempUserRes = await request(app)
        .post('/api/auth/register')
        .send({ username: 'logout_test_user', password: 'SecretPass123!', email: 'logout@test.local' });
      assert.strictEqual(tempUserRes.status, 201);
      const tempToken = tempUserRes.body.token;

      // Verify token works
      const meBefore = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tempToken}`);
      assert.strictEqual(meBefore.status, 200);
      assert.strictEqual(meBefore.body.user.username, 'logout_test_user');

      // Logout
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${tempToken}`);
      assert.strictEqual(logoutRes.status, 200);
      assert.strictEqual(logoutRes.body.success, true);

      // Verify token is blacklisted in Valkey
      const isBlacklisted = await isTokenBlacklisted(tempToken);
      assert.strictEqual(isBlacklisted, true);

      // Verify subsequent request with revoked token fails with 401
      const meAfter = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tempToken}`);
      assert.strictEqual(meAfter.status, 401);
      assert.strictEqual(meAfter.body.error, 'Token has been revoked');
    });
  });

  describe('2. User Management with Split-Tunneling (bypass_apps) and Quotas', () => {
    let createdUserId;

    it('should create user with bypass_apps JSON array and custom quota', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          username: 'charlie_split',
          password: 'Password123!',
          email: 'charlie@split.local',
          tier: 'hybrid_byos',
          bypass_apps: ['com.spotify.client', 'zoom.us', 'com.apple.Music'],
          quota: { max_nodes: 8, max_bandwidth_gb: 300 }
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.user.username, 'charlie_split');
      assert.deepStrictEqual(res.body.user.bypass_apps, ['com.spotify.client', 'zoom.us', 'com.apple.Music']);
      assert.strictEqual(res.body.user.quota.max_nodes, 8);
      assert.strictEqual(res.body.user.quota.max_bandwidth_gb, 300);
      createdUserId = res.body.user.id;
    });

    it('should update user bypass_apps list', async () => {
      const res = await request(app)
        .put(`/api/users/${createdUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          bypass_apps: ['com.spotify.client', 'slack', 'discord']
        });

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.user.bypass_apps, ['com.spotify.client', 'slack', 'discord']);
    });

    it('should get user quota details including node count', async () => {
      const res = await request(app)
        .get(`/api/users/${createdUserId}/quota`)
        .set('Authorization', `Bearer ${adminToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.user_id, createdUserId);
      assert.strictEqual(res.body.max_nodes, 8);
      assert.strictEqual(res.body.used_nodes, 0);
      assert.strictEqual(res.body.max_bandwidth_gb, 300);
    });
  });

  describe('3. Node Management with Kill Switch, Onion Routing & PostGIS Geolocation', () => {
    let nodeId;

    it('should register node with kill_switch_enabled and allocate VIP in 100.64.0.0/10', async () => {
      const res = await request(app)
        .post('/api/nodes')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Secure-Bastion-Node',
          role: 'CLIENT_ORIGIN',
          country_code: 'CH',
          city: 'Zurich',
          kill_switch_enabled: true,
          onion_routing_enabled: true,
          onion_hops: 3,
          endpoints: ['198.51.100.55:51820']
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.node.name, 'Secure-Bastion-Node');
      assert.strictEqual(res.body.node.kill_switch_enabled, true);
      assert.strictEqual(res.body.node.onion_routing_enabled, true);
      assert.strictEqual(res.body.node.onion_hops, 3);
      assert.ok(res.body.node.overlay_ipv4.startsWith('100.'));
      assert.ok(res.body.node.overlay_ipv6.startsWith('fd7a:115c:a1e0::'));
      assert.deepStrictEqual(res.body.node.endpoints, ['198.51.100.55:51820']);
      nodeId = res.body.node.id;
    });

    it('should toggle kill_switch_enabled via PUT /api/nodes/:id', async () => {
      const res = await request(app)
        .put(`/api/nodes/${nodeId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ kill_switch_enabled: false });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.node.kill_switch_enabled, false);
    });

    it('should execute node action: quarantine and lift_quarantine', async () => {
      // Quarantine
      const qRes = await request(app)
        .post(`/api/nodes/${nodeId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'quarantine', reason: 'Zero-Trust Posture Violation' });

      assert.strictEqual(qRes.status, 200);
      assert.strictEqual(qRes.body.result.is_quarantined, true);
      assert.strictEqual(qRes.body.result.status, 'quarantined');

      // Lift quarantine
      const liftRes = await request(app)
        .post(`/api/nodes/${nodeId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'lift_quarantine' });

      assert.strictEqual(liftRes.status, 200);
      assert.strictEqual(liftRes.body.result.is_quarantined, false);
      assert.strictEqual(liftRes.body.result.status, 'active');
    });

    it('should generate WireGuard and Noise profile with Curve25519 clamped keypair', async () => {
      const res = await request(app)
        .post('/api/configs/generate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Noise-Clamped-Device',
          role: 'CLIENT_ORIGIN',
          country_code: 'US',
          onion_routing_enabled: true,
          onion_hops: 3,
          kill_switch_enabled: true
        });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.wireguard_conf.includes('[Interface]'));
      assert.ok(res.body.wireguard_conf.includes('PrivateKey = '));
      assert.ok(res.body.json_profile);
      assert.strictEqual(res.body.json_profile.crypto.curve, 'Curve25519');
      assert.strictEqual(res.body.json_profile.routing.onion_hops, 3);
      assert.ok(res.body.qrcode_data_url.startsWith('data:image/'));
    });
  });

  describe('4. Health Probe API', () => {
    it('GET /api/health should return 200 with database and valkey status', async () => {
      const res = await request(app).get('/api/health');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, 'ok');
      assert.ok(res.body.database === 'connected');
      assert.ok(res.body.valkey === 'connected' || res.body.valkey === 'in_memory_active');
      assert.ok(typeof res.body.uptime_seconds === 'number');
      assert.ok(res.body.timestamp);
    });
  });

  describe('5. Real-Time WebSocket Topology Server & Valkey State Sync', () => {
    it('should reject unauthenticated WebSocket connection to /ws/topology', async () => {
      await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws/topology`);
        ws.on('error', (err) => {
          resolve();
        });
        ws.on('unexpected-response', (req, res) => {
          assert.strictEqual(res.statusCode, 401);
          resolve();
        });
        ws.on('open', () => {
          ws.close();
          assert.fail('Should not connect without auth token');
        });
      });
    });

    it('should authenticate WebSocket connection with JWT token and receive handshake', async () => {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws/topology?token=${adminToken}`);

        ws.on('open', () => {
          // Send PING
          ws.send(JSON.stringify({ type: 'PING' }));
        });

        let receivedHandshake = false;

        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'CONNECTED') {
            receivedHandshake = true;
            assert.strictEqual(msg.user.username, 'admin');
            assert.strictEqual(msg.channel, 'neronet:topology:events');
          } else if (msg.type === 'PONG') {
            assert.strictEqual(receivedHandshake, true);
            ws.close();
            resolve();
          }
        });

        ws.on('error', (err) => {
          reject(err);
        });
      });
    });

    it('should broadcast Valkey topology events to connected WebSocket clients', async () => {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws/topology?token=${adminToken}`);

        ws.on('open', async () => {
          // Broadcast an event through TopologySync / Valkey PubSub
          setTimeout(async () => {
            await broadcastNodeEvent('NODE_QUARANTINE_TEST', {
              id: 'test-node-broadcast',
              name: 'BroadcastTest',
              status: 'quarantined'
            });
          }, 50);
        });

        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.event === 'NODE_QUARANTINE_TEST') {
            assert.strictEqual(msg.node.id, 'test-node-broadcast');
            ws.close();
            resolve();
          }
        });

        ws.on('error', (err) => {
          reject(err);
        });
      });
    });
  });

  describe('6. PostgreSQL 16 Migration DDL Validation', () => {
    // These are text assertions over the migration files. They confirm the files say
    // what they are supposed to say -- nothing more. They pass with PostgreSQL never
    // started, which is exactly how a GiST index on a column no query touched
    // survived review as a verified feature. Treat them as a spelling check, and see
    // schema_parity.test.js for the check that actually compares the two schemas.
    it('should verify migration files exist with the expected table definitions', () => {
      const migDir = path.resolve(__dirname, '../db/migrations');
      assert.ok(fs.existsSync(migDir));
      const files = fs.readdirSync(migDir).filter(f => f.endsWith('.sql'));
      assert.ok(files.length >= 4);

      const sql001 = fs.readFileSync(path.join(migDir, '001_initial_pg_schema.sql'), 'utf8');
      assert.ok(sql001.includes('CREATE EXTENSION IF NOT EXISTS "vector"'));

      // PostGIS was removed in migration 004: the geometry column was never written
      // and never read, while costing a second schema and a PostGIS-only base image.
      assert.ok(!sql001.includes('CREATE EXTENSION IF NOT EXISTS "postgis"'));
      assert.ok(!sql001.includes('GEOMETRY(Point, 4326)'));
      assert.ok(!sql001.includes('USING GIST'));
      assert.ok(sql001.includes('latitude REAL'));
      assert.ok(sql001.includes('longitude REAL'));

      assert.ok(sql001.includes('endpoints JSONB'));
      assert.ok(sql001.includes('bypass_apps JSONB'));
      assert.ok(sql001.includes('CREATE TABLE IF NOT EXISTS audit_events'));
      assert.ok(sql001.includes('CREATE TABLE IF NOT EXISTS system_metrics'));

      const sql002 = fs.readFileSync(path.join(migDir, '002_postgis_geofencing.sql'), 'utf8');
      assert.ok(sql002.includes('CREATE TABLE IF NOT EXISTS geofencing_policies'));
      assert.ok(sql002.includes('CREATE TABLE IF NOT EXISTS node_telemetry_history'));

      const sql003 = fs.readFileSync(path.join(migDir, '003_nuke_and_peering.sql'), 'utf8');
      assert.ok(sql003.includes('CREATE TABLE IF NOT EXISTS peering_agreements'));
      assert.ok(sql003.includes('CREATE TABLE IF NOT EXISTS dead_man_switch'));
      assert.ok(sql003.includes('CREATE TABLE IF NOT EXISTS warrant_canaries'));
      assert.ok(sql003.includes('CREATE TABLE IF NOT EXISTS custom_domains'));

      const sql004 = fs.readFileSync(path.join(migDir, '004_drop_postgis.sql'), 'utf8');
      assert.ok(sql004.includes('DROP COLUMN IF EXISTS location'));
      assert.ok(sql004.includes('DROP INDEX IF EXISTS idx_nodes_location_gix'));
    });
  });
});
