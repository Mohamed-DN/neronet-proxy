const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const MetricsCollector = require('../services/MetricsCollector');
const { seedHiddenTier, tokens, NODES, ORG_A, ORG_B } = require('./helpers/hiddenTier');

const MIB = 1024 * 1024;

describe('Scoped throughput remains unknown across individual resets and fleet changes', () => {
  let db;
  let app;
  let token;
  const get = (path) => request(app).get(`/api/stats${path}`).set('Authorization', `Bearer ${token}`);
  const sample = async () => {
    await MetricsCollector.collectOnce();
    await db.pool.query('SELECT pg_sleep(0.02)');
  };
  const addNode = (organizationId) =>
    db.pool.query(
      `INSERT INTO nodes (id,user_id,organization_id,name,public_key,overlay_ipv4,overlay_ipv6,role,
                          rx_bytes,tx_bytes,last_heartbeat)
       VALUES ('node-rate-new',$1,$2,'New counter source',$3,'100.64.77.10','fd7a:115c:a1e0::7710','CLIENT_ORIGIN',$4,$4,NOW())`,
      [organizationId === ORG_A ? NODES.v1.user : NODES.b1.user, organizationId, 'e'.repeat(64), 20 * MIB]
    );

  before(async () => {
    db = await setupTestDatabase();
    assert.match((await db.pool.query('SELECT current_database() AS name')).rows[0].name, /^neronet_t_/);
    app = createApp();
    await db.pool.query('DELETE FROM nodes');
    await seedHiddenTier(db.pool);
    token = tokens().owner;
  });
  beforeEach(async () => {
    await db.pool.query("DELETE FROM nodes WHERE id='node-rate-new'");
    await db.pool.query('DELETE FROM node_metric_samples');
    await db.pool.query('UPDATE nodes SET rx_bytes=$1,tx_bytes=$1,last_heartbeat=NOW()', [MIB]);
    await sample();
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  it('reports measured rates for an unchanged cohort with increasing counters', async () => {
    await db.pool.query('UPDATE nodes SET rx_bytes=rx_bytes+$1,tx_bytes=tx_bytes+$1', [MIB]);
    await sample();
    const overview = await get('/overview');
    const series = await get('/timeseries');
    assert.equal(overview.status, 200);
    assert.equal(series.status, 200);
    assert.ok(overview.body.total_bandwidth_rx_mb_s > 0);
    assert.ok(overview.body.total_bandwidth_tx_mb_s > 0);
    assert.ok(series.body.at(-1).rx > 0);
    assert.ok(series.body.at(-1).tx > 0);
    assert.equal(series.body.at(-1).rx_bytes, 4 * MIB);
  });

  for (const reset of ['rx', 'tx']) {
    it(`does not hide an individual ${reset.toUpperCase()} reset behind another node's growth`, async () => {
      const other = reset === 'rx' ? 'tx' : 'rx';
      await db.pool.query(`UPDATE nodes SET ${reset}_bytes=0,${other}_bytes=${other}_bytes+$2 WHERE id=$1`, [
        NODES.v1.id,
        MIB
      ]);
      await db.pool.query(
        `UPDATE nodes SET ${reset}_bytes=${reset}_bytes+$2,${other}_bytes=${other}_bytes+$3 WHERE id=$1`,
        [NODES.v2.id, 3 * MIB, MIB]
      );
      await sample();
      const series = await get('/timeseries');
      const overview = await get('/overview');
      assert.equal(series.status, 200);
      assert.equal(overview.status, 200);
      assert.equal(series.body.at(-1)[reset], null);
      assert.equal(overview.body[`total_bandwidth_${reset}_mb_s`], null);
      assert.ok(series.body.at(-1)[other] > 0);
      assert.ok(overview.body[`total_bandwidth_${other}_mb_s`] > 0);
    });
  }

  it('waits for two comparable samples after a new visible counter source joins', async () => {
    await addNode(ORG_A);
    await sample();
    const series = await get('/timeseries');
    const overview = await get('/overview');
    assert.equal(series.status, 200);
    assert.equal(overview.status, 200);
    assert.equal(series.body.at(-1).rx, null);
    assert.equal(series.body.at(-1).tx, null);
    assert.equal(overview.body.total_bandwidth_rx_mb_s, null);
    assert.equal(overview.body.total_bandwidth_tx_mb_s, null);
    await db.pool.query('UPDATE nodes SET rx_bytes=rx_bytes+$1,tx_bytes=tx_bytes+$1', [MIB]);
    await sample();
    assert.ok((await get('/timeseries')).body.at(-1).rx > 0);
    assert.ok((await get('/overview')).body.total_bandwidth_tx_mb_s > 0);
  });

  it('keeps a measured tenant rate when a foreign node joins the platform', async () => {
    await addNode(ORG_B);
    await db.pool.query('UPDATE nodes SET rx_bytes=rx_bytes+$1,tx_bytes=tx_bytes+$1', [MIB]);
    await sample();
    const overview = await get('/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.total_nodes, 2);
    assert.ok(overview.body.total_bandwidth_rx_mb_s > 0);
    assert.ok((await get('/timeseries')).body.at(-1).tx > 0);
  });
});
