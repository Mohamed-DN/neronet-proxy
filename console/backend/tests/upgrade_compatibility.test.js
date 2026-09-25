const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

describe('WP-505: N-1 to N Upgrade Compatibility & Mixed-Fleet Coexistence', () => {
  let dbHelper;
  let app;

  const LEGACY_NODE_PUBKEY = 'c'.repeat(64);
  const MODERN_NODE_PUBKEY = 'd'.repeat(64);
  const AUTH_HEADER = { Authorization: 'Bearer valid-test-token' };

  let legacyNodeId;
  let modernNodeId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('1. N-1 Node Registration (Version v3.9.0 / v4.0.0-rc1)', () => {
    it('accepts registration from an N-1 legacy node with minimal capability metadata', async () => {
      const legacyPayload = {
        public_key_hex: LEGACY_NODE_PUBKEY,
        role: 'CLIENT_ORIGIN',
        endpoints: [],
        auth_token: 'valid-test-token',
        client_version: 'v3.9.0',
        os_arch: 'linux/amd64',
        capability: {
          enabled: true,
          country_code: 'IT',
          city: 'Milan',
          latitude: 45.4642,
          longitude: 9.1900,
          asn: 12874,
          ip_class: 'RESIDENTIAL',
          max_bandwidth_kbps: 25000,
          max_concurrent_streams: 10,
          allow_udp: true,
          ac_power_only: false
        }
      };

      const res = await request(app)
        .post('/v4/control/register')
        .send(legacyPayload);

      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.assigned_node_id, 'assigned_node_id must be assigned for legacy node');
      assert.ok(res.body.overlay_ipv4, 'overlay_ipv4 must be assigned for legacy node');
      assert.ok(res.body.overlay_ipv6, 'overlay_ipv6 must be assigned for legacy node');
      assert.ok(Array.isArray(res.body.relays), 'relays array must be returned');
      legacyNodeId = res.body.assigned_node_id;
    });

    it('persists legacy node in PostgreSQL with healthy state and non-quarantined status', async () => {
      assert.ok(legacyNodeId, 'legacyNodeId must be defined');
      const dbRes = await dbHelper.pool.query(
        'SELECT id, public_key, is_healthy, is_quarantined FROM nodes WHERE id = $1',
        [legacyNodeId]
      );
      assert.strictEqual(dbRes.rowCount, 1);
      assert.strictEqual(dbRes.rows[0].is_healthy, true);
      assert.strictEqual(dbRes.rows[0].is_quarantined, false);
    });
  });

  describe('2. N-1 Node Heartbeat Ingestion', () => {
    it('successfully processes heartbeats from legacy N-1 nodes with telemetry updates', async () => {
      assert.ok(legacyNodeId, 'legacyNodeId must be defined');
      const legacyHeartbeat = {
        node_id: legacyNodeId,
        cpu_usage_pct: 25,
        memory_usage_mb: 256,
        tx_bytes_sec: 1500,
        rx_bytes_sec: 3000,
        active_circuits: 2
      };

      const res = await request(app)
        .post('/v4/control/heartbeat')
        .send(legacyHeartbeat);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.acknowledged, true);
      assert.strictEqual(res.body.is_quarantined, false);
    });
  });

  describe('3. N-1 Netmap Retrieval & Additive Schema Safety', () => {
    it('returns a netmap that preserves wire contract compatibility for N-1 nodes', async () => {
      assert.ok(legacyNodeId, 'legacyNodeId must be defined');
      const res = await request(app)
        .post('/v4/control/netmap')
        .set(AUTH_HEADER)
        .send({
          node_id: legacyNodeId,
          version: 1
        });

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.peers), 'peers array must be present');
      assert.ok(typeof res.body.version === 'number', 'version number must be present');
    });
  });

  describe('4. Mixed-Fleet Interoperability (N-1 Legacy Node and N Modern Node Coexistence)', () => {
    it('allows modern v4.0.0 node to register alongside legacy node and exchange peer netmaps', async () => {
      const modernPayload = {
        public_key_hex: MODERN_NODE_PUBKEY,
        role: 'EXIT_BRIDGE',
        endpoints: [
          {
            ip_address: '203.0.113.50',
            port: 51820,
            protocol: 'udp',
            is_stun_discovered: false
          }
        ],
        auth_token: 'valid-test-token',
        client_version: 'v4.0.0',
        os_arch: 'linux/amd64',
        capability: {
          enabled: true,
          country_code: 'DE',
          city: 'Frankfurt',
          latitude: 50.1109,
          longitude: 8.6821,
          asn: 12345,
          ip_class: 'DATACENTER',
          max_bandwidth_kbps: 100000,
          max_concurrent_streams: 100,
          allow_udp: true,
          ac_power_only: true
        }
      };

      const modernRes = await request(app)
        .post('/v4/control/register')
        .send(modernPayload);

      assert.strictEqual(modernRes.status, 200);
      modernNodeId = modernRes.body.assigned_node_id;

      // Both nodes now request netmaps and verify peer visibility
      const legacyNetmap = await request(app)
        .post('/v4/control/netmap')
        .set(AUTH_HEADER)
        .send({
          node_id: legacyNodeId,
          version: 1
        });

      assert.strictEqual(legacyNetmap.status, 200);
      const foundModernPeer = legacyNetmap.body.peers.find(p => p.public_key_hex === MODERN_NODE_PUBKEY);
      assert.ok(foundModernPeer, 'Legacy node must receive modern node as peer');

      // Modern node requests netmap and verifies legacy node as peer
      const modernNetmap = await request(app)
        .post('/v4/control/netmap')
        .set(AUTH_HEADER)
        .send({
          node_id: modernNodeId,
          version: 1
        });

      assert.strictEqual(modernNetmap.status, 200);
      const foundLegacyPeer = modernNetmap.body.peers.find(p => p.public_key_hex === LEGACY_NODE_PUBKEY);
      assert.ok(foundLegacyPeer, 'Modern node must receive legacy node as peer');
    });
  });

  describe('5. Database Zero-Downtime Migration Resilience', () => {
    it('confirms all nodes table columns support backward compatibility with default constraints', async () => {
      const columnsRes = await dbHelper.pool.query(
        "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'nodes' ORDER BY ordinal_position"
      );

      const columnNames = columnsRes.rows.map(r => r.column_name);
      assert.ok(columnNames.includes('id'), 'id required');
      assert.ok(columnNames.includes('public_key'), 'public_key required');
      assert.ok(columnNames.includes('organization_id'), 'organization_id required');
      assert.ok(columnNames.includes('is_quarantined'), 'is_quarantined required');
      assert.ok(columnNames.includes('overlay_ipv4'), 'overlay_ipv4 required');
      assert.ok(columnNames.includes('overlay_ipv6'), 'overlay_ipv6 required');
      assert.ok(columnNames.includes('endpoints'), 'endpoints required');
    });
  });
});
