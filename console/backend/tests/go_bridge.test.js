const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');

const testDbPath = path.resolve(__dirname, '../../data/test_go_bridge.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const { seedDatabase } = require('../db/seed');
const { createApp } = require('../server');

/**
 * These exercise the wire contract the Go node actually speaks, taken from the struct
 * tags in pkg/control/server.go. The previous bridge was covered only by tests that
 * spoke its own invented field names, so every one of them passed while no real node
 * could register, hold an address, or land a heartbeat.
 */

const GO_PUBKEY_A = 'a'.repeat(64);
const GO_PUBKEY_B = 'b'.repeat(64);

function registerBody(publicKeyHex, overrides = {}) {
  // Field names as the Go client marshals them.
  return {
    public_key_hex: publicKeyHex,
    role: 'EXIT_BRIDGE',
    endpoints: [],
    auth_token: '',
    client_version: '4.0.0',
    os_arch: 'linux/amd64',
    capability: {
      enabled: true,
      country_code: 'DE',
      ip_class: 'DATACENTER',
      max_bandwidth_kbps: 50000
    },
    ...overrides
  };
}

describe('Go data-plane bridge', () => {
  let app;

  before(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    const db = getDatabase(testDbPath);
    runMigrations(db);
    seedDatabase(db);
    app = createApp();
  });

  after(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  describe('registration', () => {
    it('returns an overlay address in the shape the Go client decodes', async () => {
      const res = await request(app).post('/v4/control/register').send(registerBody(GO_PUBKEY_A));

      assert.strictEqual(res.status, 200);

      // control.RegisterResponse field names. The old bridge answered
      // {NodeID, Status, SecretHex}, so every one of these decoded to its zero value
      // and the node logged "Assigned Overlay VIP: " with nothing after it.
      assert.ok(res.body.assigned_node_id, 'assigned_node_id missing');
      assert.ok(res.body.overlay_ipv4, 'overlay_ipv4 missing: the node cannot join the mesh without one');
      assert.ok(res.body.overlay_ipv6, 'overlay_ipv6 missing');
      assert.match(
        res.body.overlay_ipv4,
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
        'overlay IPv4 outside 100.64.0.0/10'
      );
      assert.ok(Array.isArray(res.body.relays));
      assert.strictEqual(typeof res.body.lease_expiry_utc, 'number');
    });

    it('assigns the same node id the Go client derives locally', async () => {
      const res = await request(app).post('/v4/control/register').send(registerBody(GO_PUBKEY_A));

      // control.GenerateNodeID is fmt.Sprintf("pk_%x", pubKey[:8]).
      assert.strictEqual(res.body.assigned_node_id, `pk_${GO_PUBKEY_A.slice(0, 16)}`);
    });

    it('stores the public key the node sent', async () => {
      await request(app).post('/v4/control/register').send(registerBody(GO_PUBKEY_A));

      const db = getDatabase();
      const row = db.prepare('SELECT public_key FROM nodes WHERE id = ?').get(`pk_${GO_PUBKEY_A.slice(0, 16)}`);

      // The old bridge read req.body.PublicKeyHex, which is not what the node sends,
      // and fell back to a random string -- every node was stored as svrn-go-unknown-
      // with no key at all.
      assert.strictEqual(row.public_key, GO_PUBKEY_A);
    });

    it('gives a second node a distinct overlay address', async () => {
      const first = await request(app).post('/v4/control/register').send(registerBody(GO_PUBKEY_A));
      const second = await request(app).post('/v4/control/register').send(registerBody(GO_PUBKEY_B));

      assert.strictEqual(second.status, 200, `second node rejected: ${JSON.stringify(second.body)}`);

      // overlay_ipv6 was hardcoded to 'fd00::1' on a UNIQUE column, so the second node
      // to ever register hit a constraint violation and got a 500. Only one Go node
      // could exist in the whole system.
      assert.notStrictEqual(second.body.overlay_ipv4, first.body.overlay_ipv4);
      assert.notStrictEqual(second.body.overlay_ipv6, first.body.overlay_ipv6);
    });

    it('returns the existing address when a node re-registers', async () => {
      const first = await request(app).post('/v4/control/register').send(registerBody(GO_PUBKEY_A));
      const again = await request(app).post('/v4/control/register').send(registerBody(GO_PUBKEY_A));

      // A restart must not burn a fresh address and orphan the previous lease.
      assert.strictEqual(again.body.overlay_ipv4, first.body.overlay_ipv4);
      assert.strictEqual(again.body.overlay_ipv6, first.body.overlay_ipv6);
    });

    it('rejects a registration with no usable public key', async () => {
      const res = await request(app).post('/v4/control/register').send(registerBody('not-a-hex-key'));

      assert.strictEqual(res.status, 400);
    });
  });

  describe('heartbeat', () => {
    let nodeId;

    before(async () => {
      const res = await request(app).post('/v4/control/register').send(registerBody(GO_PUBKEY_A));
      nodeId = res.body.assigned_node_id;
    });

    it('acknowledges in the shape the Go client decodes', async () => {
      const res = await request(app).post('/v4/control/heartbeat').send({
        node_id: nodeId,
        sequence_num: 1,
        cpu_usage_pct: 42,
        memory_usage_mb: 128,
        battery_level_pct: 80,
        tx_bytes_sec: 1000,
        rx_bytes_sec: 2000,
        active_circuits: 3
      });

      assert.strictEqual(res.status, 200);
      // control.HeartbeatResponse. The old bridge answered {Status: "ok"}, so
      // hbResp.Acknowledged was always false on the node side.
      assert.strictEqual(res.body.acknowledged, true);
      assert.strictEqual(res.body.is_quarantined, false);
    });

    it('actually records what the heartbeat reported', async () => {
      await request(app).post('/v4/control/heartbeat').send({
        node_id: nodeId,
        cpu_usage_pct: 37,
        memory_usage_mb: 256,
        battery_level_pct: 55,
        tx_bytes_sec: 500,
        rx_bytes_sec: 700
      });

      const db = getDatabase();
      const row = db
        .prepare('SELECT cpu_usage_pct, memory_usage_pct, battery_pct, last_heartbeat FROM nodes WHERE id = ?')
        .get(nodeId);

      assert.strictEqual(row.cpu_usage_pct, 37);
      assert.strictEqual(row.memory_usage_pct, 256);
      assert.strictEqual(row.battery_pct, 55);
      assert.ok(row.last_heartbeat, 'last_heartbeat was never written');
    });

    it('does not invent a latency figure', async () => {
      const db = getDatabase();
      db.prepare('UPDATE nodes SET latency_ms = 0 WHERE id = ?').run(nodeId);

      await request(app).post('/v4/control/heartbeat').send({ node_id: nodeId, cpu_usage_pct: 10 });

      const row = db.prepare('SELECT latency_ms FROM nodes WHERE id = ?').get(nodeId);

      // The old handler wrote floor(random() * 50 + 10) on every beat, so the console
      // displayed a fabricated round-trip time for every node. The node does not
      // measure RTT yet; nothing should appear until it does.
      assert.strictEqual(row.latency_ms, 0, 'a latency value was invented by the control plane');
    });

    it('rejects a heartbeat with no node id instead of silently dropping it', async () => {
      const res = await request(app).post('/v4/control/heartbeat').send({ cpu_usage_pct: 10 });

      // The old handler returned {Status:"ok"} here, so a heartbeat addressed to
      // nothing looked successful to both sides. That is why 47 node rows produced
      // 7 telemetry rows with nobody noticing.
      assert.strictEqual(res.status, 400);
    });

    it('rejects a heartbeat for a node that was never registered', async () => {
      const res = await request(app)
        .post('/v4/control/heartbeat')
        .send({ node_id: 'pk_deadbeefdeadbeef', cpu_usage_pct: 10 });

      assert.strictEqual(res.status, 404);
    });
  });

  describe('discovery', () => {
    // Until this endpoint existed a node enrolled, received an overlay address, and
    // had no way to learn that any other node existed. There was no mesh, only a
    // registration table that the console drew as a topology.
    let bridgeId;

    before(async () => {
      const bridgeKey = 'c'.repeat(64);
      const res = await request(app)
        .post('/v4/control/register')
        .send(
          registerBody(bridgeKey, { role: 'EXIT_BRIDGE', capability: { country_code: 'DE', ip_class: 'DATACENTER' } })
        );
      bridgeId = res.body.assigned_node_id;

      await request(app).post('/v4/control/heartbeat').send({ node_id: bridgeId, cpu_usage_pct: 5 });
    });

    it('returns bridges in the shape the Go client decodes', async () => {
      const res = await request(app).post('/v4/control/discover').send({ limit: 10 });

      assert.strictEqual(res.status, 200);
      // control.DiscoverResponse / DiscoveredBridgeInfo field names.
      assert.ok(Array.isArray(res.body.bridges));

      const bridge = res.body.bridges.find((b) => b.node_id === bridgeId);
      assert.ok(bridge, 'the registered exit bridge was not discoverable');
      assert.ok(bridge.public_key_hex, 'public_key_hex missing');
      assert.ok(bridge.overlay_ipv4, 'overlay_ipv4 missing');
      assert.ok(Array.isArray(bridge.endpoints));
      assert.strictEqual(typeof bridge.capability.country_code, 'string');
      assert.strictEqual(typeof bridge.score, 'number');
    });

    it('filters by country', async () => {
      const de = await request(app).post('/v4/control/discover').send({ target_country: 'DE' });
      const jp = await request(app).post('/v4/control/discover').send({ target_country: 'JP' });

      assert.ok(de.body.bridges.some((b) => b.node_id === bridgeId));
      assert.ok(de.body.bridges.every((b) => b.capability.country_code === 'DE'));
      assert.strictEqual(jp.body.bridges.length, 0);
    });

    it('honours the limit', async () => {
      const res = await request(app).post('/v4/control/discover').send({ limit: 1 });
      assert.strictEqual(res.body.bridges.length, 1);
    });

    it('does not offer client origins as bridges', async () => {
      const clientKey = 'd'.repeat(64);
      const reg = await request(app)
        .post('/v4/control/register')
        .send(registerBody(clientKey, { role: 'CLIENT_ORIGIN' }));

      const res = await request(app).post('/v4/control/discover').send({ limit: 100 });

      // A client origin has nothing to offer another node; listing one would send
      // traffic to a dead end.
      assert.ok(!res.body.bridges.some((b) => b.node_id === reg.body.assigned_node_id));
    });

    it('does not offer quarantined nodes', async () => {
      const db = getDatabase();
      db.prepare('UPDATE nodes SET is_quarantined = 1 WHERE id = ?').run(bridgeId);

      const res = await request(app).post('/v4/control/discover').send({ limit: 100 });
      assert.ok(!res.body.bridges.some((b) => b.node_id === bridgeId), 'a quarantined node was offered as a bridge');

      db.prepare('UPDATE nodes SET is_quarantined = 0 WHERE id = ?').run(bridgeId);
    });

    it('requires the enrolment token when one is configured', async () => {
      process.env.SOVEREIGN_REGISTRATION_TOKEN = 'discovery-token';
      try {
        const denied = await request(app).post('/v4/control/discover').send({ limit: 5 });
        assert.strictEqual(denied.status, 401, 'discovery enumerated the node inventory without a token');

        // The Go client sends it as a bearer header; only RegisterRequest has a body
        // field for it.
        const allowed = await request(app)
          .post('/v4/control/discover')
          .set('Authorization', 'Bearer discovery-token')
          .send({ limit: 5 });
        assert.strictEqual(allowed.status, 200);
      } finally {
        delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
      }
    });
  });

  describe('enrolment authentication', () => {
    it('rejects a wrong token when one is configured', async () => {
      process.env.SOVEREIGN_REGISTRATION_TOKEN = 'the-real-token';
      try {
        const res = await request(app)
          .post('/v4/control/register')
          .send(registerBody(crypto.randomBytes(32).toString('hex'), { auth_token: 'wrong' }));

        assert.strictEqual(res.status, 401);
      } finally {
        delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
      }
    });

    it('accepts the correct token', async () => {
      process.env.SOVEREIGN_REGISTRATION_TOKEN = 'the-real-token';
      try {
        const res = await request(app)
          .post('/v4/control/register')
          .send(registerBody(crypto.randomBytes(32).toString('hex'), { auth_token: 'the-real-token' }));

        assert.strictEqual(res.status, 200);
      } finally {
        delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
      }
    });
  });
});
