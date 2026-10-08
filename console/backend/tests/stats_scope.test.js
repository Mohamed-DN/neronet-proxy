const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const MetricsCollector = require('../services/MetricsCollector');
const { seedNative, advanceFromLegacy } = require('./helpers/nativeMetricsFixture');
const { seedHiddenTier, tokens, NODES, ORG_A, ORG_B, DEFAULT_COMPARTMENT } = require('./helpers/hiddenTier');

describe('Statistics obey current tenant and node visibility before aggregation', () => {
  let db;
  let app;
  let auth;
  const get = (path, actor = 'owner') =>
    request(app).get(`/api/stats${path}`).set('Authorization', `Bearer ${auth[actor]}`);

  before(async () => {
    db = await setupTestDatabase();
    app = createApp();
    await db.pool.query('DELETE FROM nodes');
    await db.pool.query('DELETE FROM system_metrics');
    await seedHiddenTier(db.pool);
    auth = tokens();
    for (const [node, rx, tx, cpu, country, posture] of [
      [NODES.v1, 10, 5, 10, 'IT', { disk_encrypted: true, firewall_active: true }],
      [NODES.v2, 20, 10, 20, 'IT', { disk_encrypted: false, firewall_active: true }],
      [NODES.h1, 900, 900, 90, 'CA', { disk_encrypted: true, firewall_active: true }],
      [NODES.b1, 800, 800, 80, 'US', null]
    ]) {
      await db.pool.query(
        `UPDATE nodes SET rx_bytes=$2, tx_bytes=$3, cpu_usage_pct=$4, memory_usage_pct=$4,
           country_code=$5, posture_checks=$6::jsonb, last_heartbeat=NOW() WHERE id=$1`,
        [
          node.id,
          rx,
          tx,
          cpu,
          country,
          JSON.stringify(posture ? { ...posture, measured_at: new Date().toISOString() } : {})
        ]
      );
      await seedNative(db.pool, node.id, { rx, tx, memory: cpu * 1024 });
    }
    // Old global samples are deliberately unattributable to any node or tenant.
    await db.pool.query(`INSERT INTO system_metrics (timestamp, total_bandwidth_rx, total_bandwidth_tx, active_nodes)
      VALUES (NOW()-interval '60 seconds', 0, 0, 999), (NOW(), 900000000, 800000000, 999)`);
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  for (const path of ['', '/overview']) {
    it(`${path || '/'} aggregates only the owner's visible organisation`, async () => {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.equal(response.body.total_nodes, 2);
      assert.equal(response.body.active_nodes, 2);
      assert.equal(response.body.total_rx_bytes, '30');
      assert.equal(response.body.total_tx_bytes, '15');
      assert.equal(response.body.avg_cpu_pct, 15);
      assert.deepEqual(response.body.country_distribution, { IT: 2 });
      assert.equal(response.body.posture_verified_compliant_nodes, 1);
      assert.equal(response.body.posture_non_compliant_nodes, 1);
      assert.equal(response.body.posture_unverified_nodes, 0);
    });
  }
  it('allows root tier within the organisation without adding another tenant', async () => {
    const response = await get('/overview', 'rootOwner');
    assert.equal(response.status, 200);
    assert.equal(response.body.total_nodes, 3);
    assert.equal(response.body.total_rx_bytes, '930');
    assert.deepEqual(response.body.country_distribution, { IT: 2, CA: 1 });
  });
  it('confines a member to their own node instead of exposing organisation totals', async () => {
    const response = await get('/overview', 'member');
    assert.equal(response.status, 200);
    assert.equal(response.body.total_nodes, 1);
    assert.equal(response.body.total_rx_bytes, '20');
    assert.equal(response.body.connected_users, 1);
    assert.equal(response.body.posture_non_compliant_nodes, 1);
  });
  it('counts only accounts in the current organisation', async () => {
    const response = await get('/overview');
    assert.equal(response.status, 200);
    assert.equal(response.body.connected_users, 5);
  });
  for (const path of ['/geo', '/geo-matrix']) {
    it(`${path} excludes foreign and hidden countries before grouping`, async () => {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.deepEqual(
        response.body.map(({ code, nodes }) => ({ code, nodes })),
        [{ code: 'IT', nodes: 2 }]
      );
    });
  }
  it('excludes nodes inheriting a hidden default compartment in all aggregates', async () => {
    await db.pool.query('UPDATE compartments SET is_hidden=TRUE WHERE id=$1', [DEFAULT_COMPARTMENT]);
    try {
      const response = await get('/overview');
      assert.equal(response.status, 200);
      assert.equal(response.body.total_nodes, 0);
      assert.equal(response.body.total_rx_bytes, null);
      assert.deepEqual(response.body.country_distribution, {});
      assert.equal(response.body.posture_verified_compliant_nodes, 0);
      assert.deepEqual((await get('/geo')).body, []);
    } finally {
      await db.pool.query('UPDATE compartments SET is_hidden=FALSE WHERE id=$1', [DEFAULT_COMPARTMENT]);
    }
  });
  it('uses the current account organisation rather than its older JWT claim', async () => {
    await db.pool.query("UPDATE users SET organization_id=$1 WHERE id='usr-sec-owner'", [ORG_B]);
    await db.pool.query(
      "INSERT INTO memberships (id,user_id,organization_id,role) VALUES ('stats-moved-owner','usr-sec-owner',$1,'owner')",
      [ORG_B]
    );
    try {
      const response = await get('/overview');
      assert.equal(response.status, 200);
      assert.equal(response.body.total_nodes, 1);
      assert.equal(response.body.total_rx_bytes, '800');
      assert.deepEqual(response.body.country_distribution, { US: 1 });
    } finally {
      await db.pool.query("DELETE FROM memberships WHERE id='stats-moved-owner'");
      await db.pool.query("UPDATE users SET organization_id=$1 WHERE id='usr-sec-owner'", [ORG_A]);
    }
  });
  it('cannot select another organisation through a query parameter', async () => {
    const response = await get(`/overview?org_id=${ORG_B}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.total_nodes, 2);
    assert.equal(response.body.total_rx_bytes, '30');
  });
  it('rechecks a downgraded platform role in the database', async () => {
    await db.pool.query("UPDATE users SET role='user' WHERE id='usr-sec-super'");
    try {
      const response = await get('/overview', 'superAdmin');
      assert.equal(response.status, 200);
      assert.equal(response.body.total_nodes, 0);
    } finally {
      await db.pool.query("UPDATE users SET role='super-admin' WHERE id='usr-sec-super'");
    }
  });
  it('refuses statistics for a revoked account with a cryptographically valid JWT', async () => {
    await db.pool.query("UPDATE users SET status='revoked' WHERE id='usr-sec-owner'");
    try {
      assert.equal((await get('/overview')).status, 403);
    } finally {
      await db.pool.query("UPDATE users SET status='active' WHERE id='usr-sec-owner'");
    }
  });
  it('does not derive tenant throughput from historical global counters', async () => {
    const response = await get('/overview');
    assert.equal(response.status, 200);
    assert.equal(response.body.total_bandwidth_rx_mb_s, null);
    assert.equal(response.body.total_bandwidth_tx_mb_s, null);
  });
  for (const path of ['/timeseries', '/bandwidth']) {
    it(`${path} returns no invented scoped history from the legacy global samples`, async () => {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.deepEqual(path === '/bandwidth' ? response.body.bandwidth_series : response.body, []);
    });
  }
  describe('History captured from real scoped node samples', () => {
    before(async () => {
      await MetricsCollector.collectOnce();
      await db.pool.query('SELECT pg_sleep(0.05)');
      await db.pool.query('UPDATE nodes SET rx_bytes=rx_bytes*2, tx_bytes=tx_bytes*2');
      await advanceFromLegacy(db.pool);
      await MetricsCollector.collectOnce();
    });
    it('retains measured owner history and excludes foreign and hidden samples', async () => {
      const response = await get('/timeseries');
      assert.equal(response.status, 200);
      assert.equal(response.body.length, 1);
      assert.equal(response.body[0].rx_bytes, '60');
      assert.equal(response.body[0].active_nodes, 2);
      assert.equal(response.body[0].memory_usage_mb, null);
      assert.equal(response.body[0].memory_usage_pct, null);
      assert.equal(response.body[0].memory_runtime_sys_bytes, '30720');
    });
    it('keeps member and root histories within their respective visibility', async () => {
      const member = await get('/timeseries', 'member');
      const root = await get('/timeseries', 'rootOwner');
      assert.equal(member.body[0].rx_bytes, '40');
      assert.equal(member.body[0].active_nodes, 1);
      assert.equal(root.body[0].rx_bytes, '1860');
      assert.equal(root.body[0].active_nodes, 3);
    });
    it('does not move captured history into another tenant with its node', async () => {
      await db.pool.query('UPDATE nodes SET organization_id=$2 WHERE id=$1', [NODES.v1.id, ORG_B]);
      try {
        const response = await get('/timeseries');
        assert.equal(response.body[0].rx_bytes, '40');
        const other = await get(`/timeseries?org_id=${ORG_B}`, 'superAdmin');
        assert.equal(other.body[0].rx_bytes, '1600');
      } finally {
        await db.pool.query('UPDATE nodes SET organization_id=$2 WHERE id=$1', [NODES.v1.id, ORG_A]);
      }
    });
    it('withdraws history when the current default compartment becomes hidden', async () => {
      await db.pool.query('UPDATE compartments SET is_hidden=TRUE WHERE id=$1', [DEFAULT_COMPARTMENT]);
      try {
        assert.deepEqual((await get('/timeseries')).body, []);
      } finally {
        await db.pool.query('UPDATE compartments SET is_hidden=FALSE WHERE id=$1', [DEFAULT_COMPARTMENT]);
      }
    });
    it('does not expose previously hidden samples after unhiding their compartment', async () => {
      await db.pool.query(
        'UPDATE compartments SET is_hidden=FALSE WHERE id=(SELECT compartment_id FROM nodes WHERE id=$1)',
        [NODES.h1.id]
      );
      try {
        assert.equal((await get('/timeseries')).body[0].rx_bytes, '60');
      } finally {
        await db.pool.query(
          'UPDATE compartments SET is_hidden=TRUE WHERE id=(SELECT compartment_id FROM nodes WHERE id=$1)',
          [NODES.h1.id]
        );
      }
    });
    it('preserves legacy global evidence without attributing it to a tenant', async () => {
      const rows = await db.pool.query('SELECT COUNT(*)::int AS count FROM system_metrics WHERE active_nodes=999');
      assert.equal(rows.rows[0].count, 2);
    });
    it('reports counter reset as an unknown rate', async () => {
      await db.pool.query('SELECT pg_sleep(0.05)');
      await db.pool.query('UPDATE nodes SET rx_bytes=0, tx_bytes=0');
      await advanceFromLegacy(db.pool);
      await MetricsCollector.collectOnce();
      const response = await get('/timeseries');
      assert.equal(response.body.at(-1).rx, null);
      assert.equal(response.body.at(-1).tx, null);
      assert.equal((await get('/overview')).body.total_bandwidth_rx_mb_s, null);
    });
  });
});
