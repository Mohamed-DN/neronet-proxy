const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const testDbPath = path.resolve(__dirname, '../../data/test_stats_truth.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const MetricsCollector = require('../services/MetricsCollector');

/**
 * The console reported a constant 88.4 MB/s of throughput and a constant health
 * score of 98.4, and its geographic matrix listed six countries whatever the fleet
 * contained. These tests pin the figures to the database.
 */

let addressCounter = 0;

function insertNode(db, { id, country, role, heartbeatSecondsAgo, rx = 0, tx = 0, quarantined = 0 }) {
  addressCounter += 1;
  const hb = heartbeatSecondsAgo === null ? null : new Date(Date.now() - heartbeatSecondsAgo * 1000).toISOString();

  db.prepare(
    `
    INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6,
                       role, country_code, last_heartbeat, rx_bytes, tx_bytes, is_quarantined)
    VALUES (?, 'usr-test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    id,
    id.padEnd(64, '0'),
    `100.64.9.${addressCounter}`,
    `fd00::${addressCounter}`,
    role,
    country,
    hb,
    rx,
    tx,
    quarantined
  );
}

describe('statistics report the fleet, not constants', () => {
  let db;

  before(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = getDatabase();
    runMigrations(db);
    db.prepare('DELETE FROM nodes').run();
    db.prepare('DELETE FROM system_metrics').run();

    // nodes.user_id is a foreign key; the owner has to exist before its devices do.
    db.prepare(
      `
      INSERT INTO users (id, username, email, password_hash, role)
      VALUES ('usr-test', 'stats-fixture', 'stats@test.local', 'x', 'user')`
    ).run();
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('counts a node as live only inside the liveness window', async () => {
    db.prepare('DELETE FROM nodes').run();
    insertNode(db, { id: 'n-fresh', country: 'IT', role: 'CLIENT_ORIGIN', heartbeatSecondsAgo: 5 });
    insertNode(db, { id: 'n-stale', country: 'IT', role: 'CLIENT_ORIGIN', heartbeatSecondsAgo: 3600 });
    insertNode(db, { id: 'n-never', country: 'IT', role: 'CLIENT_ORIGIN', heartbeatSecondsAgo: null });

    const state = await MetricsCollector.readFleetState();

    assert.strictEqual(state.enrolledNodes, 3, 'all three are enrolled');
    assert.strictEqual(state.liveNodes, 1, 'only the one heard from recently is live');
  });

  it('sums the bandwidth counters the nodes actually reported', async () => {
    db.prepare('DELETE FROM nodes').run();
    insertNode(db, { id: 'n-a', country: 'DE', role: 'RELAY', heartbeatSecondsAgo: 5, rx: 1000, tx: 500 });
    insertNode(db, { id: 'n-b', country: 'DE', role: 'RELAY', heartbeatSecondsAgo: 5, rx: 2000, tx: 750 });

    const state = await MetricsCollector.readFleetState();

    assert.strictEqual(state.rxBytes, 3000);
    assert.strictEqual(state.txBytes, 1250);
  });

  it('scores health from liveness instead of returning 98.4', () => {
    assert.strictEqual(
      MetricsCollector.computeHealthScore(0, 10, 0),
      0,
      'a fleet with nothing running does not score 98.4'
    );
    assert.strictEqual(MetricsCollector.computeHealthScore(10, 10, 0), 100);
    assert.strictEqual(MetricsCollector.computeHealthScore(10, 10, 5), 50, 'quarantined nodes are not healthy');
    assert.strictEqual(MetricsCollector.computeHealthScore(0, 0, 0), 100, 'owning no devices is not a fault');
  });

  it('records a sample that reflects the fleet at that moment', async () => {
    db.prepare('DELETE FROM nodes').run();
    db.prepare('DELETE FROM system_metrics').run();
    insertNode(db, { id: 'n-live', country: 'FR', role: 'EXIT_BRIDGE', heartbeatSecondsAgo: 2, rx: 42, tx: 24 });

    await MetricsCollector.collectOnce();

    const row = db.prepare('SELECT * FROM system_metrics ORDER BY timestamp DESC LIMIT 1').get();
    assert.ok(row, 'a sample was written');
    assert.strictEqual(row.active_nodes, 1);
    assert.strictEqual(Number(row.total_bandwidth_rx), 42);
    assert.strictEqual(Number(row.total_bandwidth_tx), 24);
    assert.strictEqual(row.network_health_score, 100);
  });
});
