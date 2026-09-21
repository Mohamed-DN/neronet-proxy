const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { setupTestDatabase } = require('./helpers/db');
const MetricsCollector = require('../services/MetricsCollector');

/**
 * The console reported a constant 88.4 MB/s of throughput and a constant health
 * score of 98.4, and its geographic matrix listed six countries whatever the fleet
 * contained. These tests pin the figures to the database.
 */

let addressCounter = 0;

async function insertNode(dbHelper, { id, country, role, heartbeatSecondsAgo, rx = 0, tx = 0, quarantined = false }) {
  addressCounter += 1;
  const hb = heartbeatSecondsAgo === null ? null : new Date(Date.now() - heartbeatSecondsAgo * 1000).toISOString();

  await dbHelper.pool.query(
    `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6,
                       role, country_code, last_heartbeat, rx_bytes, tx_bytes, is_quarantined)
     VALUES ($1, 'usr-test', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
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
      Boolean(quarantined)
    ]
  );
}

describe('statistics report the fleet, not constants', () => {
  let dbHelper;

  before(async () => {
    dbHelper = await setupTestDatabase();
    await dbHelper.pool.query('DELETE FROM nodes');
    await dbHelper.pool.query('DELETE FROM system_metrics');

    // nodes.user_id is a foreign key; the owner has to exist before its devices do.
    await dbHelper.pool.query(
      `INSERT INTO users (id, username, email, password_hash, role)
       VALUES ('usr-test', 'stats-fixture', 'stats@test.local', 'x', 'user')`
    );
  });

  after(async () => {
    if (dbHelper) {
      await dbHelper.cleanup();
    }
  });

  it('counts a node as live only inside the liveness window', async () => {
    await dbHelper.pool.query('DELETE FROM nodes');
    await insertNode(dbHelper, { id: 'n-fresh', country: 'IT', role: 'CLIENT_ORIGIN', heartbeatSecondsAgo: 5 });
    await insertNode(dbHelper, { id: 'n-stale', country: 'IT', role: 'CLIENT_ORIGIN', heartbeatSecondsAgo: 3600 });
    await insertNode(dbHelper, { id: 'n-never', country: 'IT', role: 'CLIENT_ORIGIN', heartbeatSecondsAgo: null });

    const state = await MetricsCollector.readFleetState();

    assert.strictEqual(state.enrolledNodes, 3, 'all three are enrolled');
    assert.strictEqual(state.liveNodes, 1, 'only the one heard from recently is live');
  });

  it('sums the bandwidth counters the nodes actually reported', async () => {
    await dbHelper.pool.query('DELETE FROM nodes');
    await insertNode(dbHelper, { id: 'n-a', country: 'DE', role: 'RELAY', heartbeatSecondsAgo: 5, rx: 1000, tx: 500 });
    await insertNode(dbHelper, { id: 'n-b', country: 'DE', role: 'RELAY', heartbeatSecondsAgo: 5, rx: 2000, tx: 750 });

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
    await dbHelper.pool.query('DELETE FROM nodes');
    await dbHelper.pool.query('DELETE FROM system_metrics');
    await insertNode(dbHelper, {
      id: 'n-live',
      country: 'FR',
      role: 'EXIT_BRIDGE',
      heartbeatSecondsAgo: 2,
      rx: 42,
      tx: 24
    });

    await MetricsCollector.collectOnce();

    const res = await dbHelper.pool.query('SELECT * FROM system_metrics ORDER BY timestamp DESC LIMIT 1');
    const row = res.rows[0];
    assert.ok(row, 'a sample was written');
    assert.strictEqual(row.active_nodes, 1);
    assert.strictEqual(Number(row.total_bandwidth_rx), 42);
    assert.strictEqual(Number(row.total_bandwidth_tx), 24);
    assert.strictEqual(row.network_health_score, 100);
  });
});
