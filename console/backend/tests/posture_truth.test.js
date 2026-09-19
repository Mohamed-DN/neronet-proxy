const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const request = require('supertest');

const testDbPath = path.resolve(__dirname, '../../data/test_posture_truth.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const { seedDatabase } = require('../db/seed');
const { createApp } = require('../server');
const HeartbeatBuffer = require('../services/HeartbeatBuffer');
const MetricsCollector = require('../services/MetricsCollector');

/**
 * Posture reached the console as a schema default: every node compliant, every disk
 * encrypted, on Linux, with nothing measured anywhere. These exercise the path a real
 * node takes -- register, heartbeat with an attestation, flush, read the API -- and
 * assert on what the database holds and what the endpoints answer.
 */

const NODE_KEY = 'a1'.repeat(32);

function registerBody(publicKeyHex) {
  return {
    public_key_hex: publicKeyHex,
    role: 'CLIENT_ORIGIN',
    endpoints: [],
    capability: { enabled: false, country_code: 'IT' }
  };
}

/** The attestation a node built from this branch sends: two nulls, no ASN. */
function attestation(overrides = {}) {
  return {
    node_id: '',
    os_name: 'linux',
    os_version: '12',
    client_version: 'v4.0.0',
    country_code: 'IT',
    asn: 0,
    disk_encrypted: null,
    firewall_active: null,
    is_rootless: true,
    timestamp_utc: new Date().toISOString(),
    ...overrides
  };
}

function storedPosture(db, nodeId) {
  const row = db.prepare('SELECT posture_checks FROM nodes WHERE id = ?').get(nodeId);
  assert.ok(row, `node ${nodeId} is missing`);
  return typeof row.posture_checks === 'string' ? JSON.parse(row.posture_checks) : row.posture_checks;
}

describe('posture reports only what was measured', () => {
  let app;
  let db;
  let token;

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    db = getDatabase(testDbPath);
    runMigrations(db);
    seedDatabase(db);
    app = createApp();

    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin_password' });
    assert.strictEqual(login.status, 200, `admin login failed: ${JSON.stringify(login.body)}`);
    token = login.body.token;
    assert.ok(token, 'no access token in the login response');
  });

  after(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  describe('the schema no longer asserts compliance', () => {
    it('gives a node inserted without a posture an empty document', () => {
      db.prepare(
        `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6)
         VALUES ('nd-default', (SELECT id FROM users WHERE role = 'super-admin' LIMIT 1),
                 'default-posture', ?, '100.64.200.1', 'fd00:dead::1')`
      ).run('de'.repeat(32));

      // The default used to be {"compliant": true, "disk_encrypted": true,
      // "os": "Linux"} -- three claims about a host nobody had looked at.
      assert.deepStrictEqual(storedPosture(db, 'nd-default'), {});

      db.prepare('DELETE FROM nodes WHERE id = ?').run('nd-default');
    });

    it('defaults ip_class to UNKNOWN rather than RESIDENTIAL', () => {
      db.prepare(
        `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6)
         VALUES ('nd-ipclass', (SELECT id FROM users WHERE role = 'super-admin' LIMIT 1),
                 'default-ipclass', ?, '100.64.200.2', 'fd00:dead::2')`
      ).run('1f'.repeat(32));

      const row = db.prepare('SELECT ip_class FROM nodes WHERE id = ?').get('nd-ipclass');
      assert.strictEqual(row.ip_class, 'UNKNOWN');

      db.prepare('DELETE FROM nodes WHERE id = ?').run('nd-ipclass');
    });

    it('resets a row still holding the fabricated default and leaves other rows alone', () => {
      // A database that predates migration 012 holds the old literal. Re-running the
      // SQLite migration over it must clear exactly that value.
      const { SQLITE_MIGRATION_012 } = require('../db/migrator');
      const owner = db.prepare("SELECT id FROM users WHERE role = 'super-admin' LIMIT 1").get().id;

      const insert = db.prepare(
        `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6, posture_checks)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      insert.run(
        'nd-old',
        owner,
        'old-default',
        'ab'.repeat(32),
        '100.64.201.1',
        'fd00:beef::1',
        '{"compliant": true, "disk_encrypted": true, "os": "Linux"}'
      );
      insert.run(
        'nd-spaced',
        owner,
        'old-default-spaced',
        'ac'.repeat(32),
        '100.64.201.2',
        'fd00:beef::2',
        '{"os":"Linux","compliant":true,"disk_encrypted":true}'
      );
      const measured = { os_name: 'linux', os_version: '12', disk_encrypted: true, firewall_active: null };
      insert.run(
        'nd-measured',
        owner,
        'measured',
        'ad'.repeat(32),
        '100.64.201.3',
        'fd00:beef::3',
        JSON.stringify(measured)
      );

      SQLITE_MIGRATION_012.run(db);

      assert.deepStrictEqual(storedPosture(db, 'nd-old'), {}, 'the fabricated default survived the migration');
      assert.deepStrictEqual(
        storedPosture(db, 'nd-spaced'),
        {},
        'the same document written with different key order or spacing was not matched'
      );
      assert.deepStrictEqual(
        storedPosture(db, 'nd-measured'),
        measured,
        'the migration overwrote a row that held a real measurement'
      );

      db.prepare("DELETE FROM nodes WHERE id IN ('nd-old', 'nd-spaced', 'nd-measured')").run();
    });
  });

  describe('the heartbeat stores the attestation', () => {
    let nodeId;

    beforeEach(async () => {
      const reg = await request(app).post('/v4/control/register').send(registerBody(NODE_KEY));
      assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
      nodeId = reg.body.assigned_node_id;
      db.prepare("UPDATE nodes SET posture_checks = '{}' WHERE id = ?").run(nodeId);
    });

    it('writes the measured document, with null for what the node did not measure', async () => {
      const measuredAt = new Date(Date.now() - 1000).toISOString();

      const res = await request(app)
        .post('/v4/control/heartbeat')
        .send({ node_id: nodeId, posture: attestation({ node_id: nodeId, timestamp_utc: measuredAt }) });

      assert.strictEqual(res.status, 200);

      // Buffered, so nothing is in the database until a flush. Calling it directly
      // rather than waiting on the 30-second timer.
      await HeartbeatBuffer.flush();

      const stored = storedPosture(db, nodeId);

      assert.deepStrictEqual(stored, {
        os_name: 'linux',
        os_version: '12',
        client_version: 'v4.0.0',
        disk_encrypted: null,
        firewall_active: null,
        is_rootless: true,
        measured_at: measuredAt
      });
    });

    it('leaves posture_checks empty for a heartbeat that carried no attestation', async () => {
      const res = await request(app).post('/v4/control/heartbeat').send({ node_id: nodeId, cpu_usage_pct: 0 });
      assert.strictEqual(res.status, 200);

      await HeartbeatBuffer.flush();

      assert.deepStrictEqual(storedPosture(db, nodeId), {}, 'a beat with no attestation invented a posture document');
    });

    it('does not convert a missing or non-boolean check into true', async () => {
      await request(app)
        .post('/v4/control/heartbeat')
        .send({
          node_id: nodeId,
          posture: attestation({
            node_id: nodeId,
            disk_encrypted: undefined,
            // A caller that does not speak the contract. Coercing this to true is
            // exactly the failure mode being fixed.
            firewall_active: 'true',
            os_version: '   '
          })
        });

      await HeartbeatBuffer.flush();

      const stored = storedPosture(db, nodeId);
      assert.strictEqual(stored.disk_encrypted, null, 'an absent check became a value');
      assert.strictEqual(stored.firewall_active, null, 'the string "true" was read as a measurement');
      assert.strictEqual(stored.os_version, null, 'whitespace was stored as an OS version');
    });

    it('keeps the stored document when a later beat carries no attestation', async () => {
      await request(app)
        .post('/v4/control/heartbeat')
        .send({ node_id: nodeId, posture: attestation({ node_id: nodeId, disk_encrypted: true }) });
      await HeartbeatBuffer.flush();

      await request(app).post('/v4/control/heartbeat').send({ node_id: nodeId });
      await HeartbeatBuffer.flush();

      assert.strictEqual(
        storedPosture(db, nodeId).disk_encrypted,
        true,
        'a beat without an attestation erased the last measurement'
      );
    });
  });

  describe('posture_status on the node API', () => {
    const owner = () => db.prepare("SELECT id FROM users WHERE role = 'super-admin' LIMIT 1").get().id;
    let octet = 10;

    function insertNodeWithPosture(id, posture) {
      octet += 1;
      db.prepare(
        `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6, posture_checks)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        owner(),
        id,
        id.padEnd(64, '0'),
        `100.64.202.${octet}`,
        `fd00:cafe::${octet}`,
        posture === null ? null : JSON.stringify(posture)
      );
    }

    before(() => {
      db.prepare("DELETE FROM nodes WHERE id LIKE 'nd-status-%'").run();

      insertNodeWithPosture('nd-status-unknown', {
        os_name: 'linux',
        disk_encrypted: null,
        firewall_active: null,
        measured_at: new Date().toISOString()
      });
      insertNodeWithPosture('nd-status-failing', {
        os_name: 'linux',
        disk_encrypted: false,
        firewall_active: true,
        measured_at: new Date().toISOString()
      });
      insertNodeWithPosture('nd-status-passing', {
        os_name: 'linux',
        disk_encrypted: true,
        firewall_active: true,
        measured_at: new Date().toISOString()
      });
      insertNodeWithPosture('nd-status-empty', {});
    });

    after(() => {
      db.prepare("DELETE FROM nodes WHERE id LIKE 'nd-status-%'").run();
    });

    const expected = {
      'nd-status-unknown': 'unverified',
      'nd-status-failing': 'non_compliant',
      'nd-status-passing': 'verified_compliant',
      'nd-status-empty': 'unverified'
    };

    it('reports the status on the node list', async () => {
      const res = await request(app).get('/api/nodes?limit=200').set('Authorization', `Bearer ${token}`);
      assert.strictEqual(res.status, 200);

      for (const [id, want] of Object.entries(expected)) {
        const node = res.body.nodes.find((n) => n.id === id);
        assert.ok(node, `${id} is missing from the list`);
        assert.strictEqual(node.posture_status, want, `${id}: posture_status`);
      }
    });

    it('reports the same status on the node detail', async () => {
      for (const [id, want] of Object.entries(expected)) {
        const res = await request(app).get(`/api/nodes/${id}`).set('Authorization', `Bearer ${token}`);
        assert.strictEqual(res.status, 200, `${id}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.node.posture_status, want, `${id}: posture_status on detail`);
      }
    });

    it('does not claim compliance for a node with an unreadable posture document', async () => {
      db.prepare("UPDATE nodes SET posture_checks = 'not json at all' WHERE id = ?").run('nd-status-empty');

      const res = await request(app).get('/api/nodes/nd-status-empty').set('Authorization', `Bearer ${token}`);

      // The fallback used to be {compliant: true, disk_encrypted: true, os: 'Linux'},
      // so an unparseable column produced a compliant node.
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.node.posture, {});
      assert.strictEqual(res.body.node.posture_status, 'unverified');

      db.prepare("UPDATE nodes SET posture_checks = '{}' WHERE id = ?").run('nd-status-empty');
    });

    it('counts the fleet by posture on the overview and the risk summary', async () => {
      const overview = await request(app).get('/api/stats/overview').set('Authorization', `Bearer ${token}`);
      assert.strictEqual(overview.status, 200);

      const counts = await MetricsCollector.readPostureCounts();
      assert.strictEqual(overview.body.posture_verified_compliant_nodes, counts.verified_compliant);
      assert.strictEqual(overview.body.posture_unverified_nodes, counts.unverified);
      assert.strictEqual(overview.body.posture_non_compliant_nodes, counts.non_compliant);

      // The four fixtures above are one of each of three statuses plus an empty one.
      assert.ok(counts.verified_compliant >= 1);
      assert.ok(counts.non_compliant >= 1);
      assert.ok(counts.unverified >= 2);

      const risk = await request(app).get('/api/risk/summary').set('Authorization', `Bearer ${token}`);
      assert.strictEqual(risk.status, 200);
      assert.deepStrictEqual(risk.body.posture, counts);
    });
  });

  describe('CPU is not reported as zero when nothing measured it', () => {
    before(() => {
      db.prepare('DELETE FROM nodes').run();
    });

    function insertLiveNode(id, cpu) {
      db.prepare(
        `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6, last_heartbeat, cpu_usage_pct)
         VALUES (?, (SELECT id FROM users WHERE role = 'super-admin' LIMIT 1), ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        id,
        id.padEnd(64, '0'),
        `100.64.203.${id.length}`,
        `fd00:c9u::${id.length}`,
        new Date().toISOString(),
        cpu
      );
    }

    it('returns null when every live node reported the unmeasured 0', async () => {
      db.prepare('DELETE FROM nodes').run();
      insertLiveNode('nd-cpu-a', 0);
      insertLiveNode('nd-cpu-bb', 0);

      const res = await request(app).get('/api/stats/overview').set('Authorization', `Bearer ${token}`);

      assert.strictEqual(res.status, 200);
      // 0 here read as "the whole fleet is idle". The node sends 0 to mean it does
      // not sample CPU at all.
      assert.strictEqual(res.body.avg_cpu_pct, null, 'an unmeasured CPU was reported as 0%');
    });

    it('averages only the nodes that did measure something', async () => {
      db.prepare('DELETE FROM nodes').run();
      insertLiveNode('nd-cpu-a', 0);
      insertLiveNode('nd-cpu-bb', 40);
      insertLiveNode('nd-cpu-ccc', 60);

      const res = await request(app).get('/api/stats/overview').set('Authorization', `Bearer ${token}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.avg_cpu_pct, 50, 'the unmeasured 0 was dragged into the average');
    });
  });
});
