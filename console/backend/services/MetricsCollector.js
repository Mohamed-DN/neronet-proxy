const { isPostgres, getPgPool, getDatabase } = require('../db/index');

// Nodes report every 15 seconds. A node is counted as live if it has been heard
// from within four of those intervals, which absorbs one lost datagram and a slow
// flush of the heartbeat buffer without declaring a healthy node dead.
const LIVENESS_WINDOW_SECONDS = 60;

// One sample per minute. The timeseries covers 24 hours, so this is the coarsest
// interval that still shows a short outage rather than averaging it away.
const SAMPLE_INTERVAL_MS = 60 * 1000;

// Samples older than this are dropped on each run. Without it the table grows
// without bound. The window covers the longest range the console offers (7 days)
// plus an hour of slack, which is 10,140 rows — small enough to keep indefinitely
// and large enough that the 7d selector is not permanently empty.
const RETENTION_HOURS = 169;

let timer = null;

/**
 * Reads the current state of the fleet.
 *
 * Bandwidth is the sum of the counters the nodes themselves report. Those counters
 * are cumulative, so the value is a total transferred, not a rate; deriving a rate
 * is the caller's job and needs two samples.
 */
async function readFleetState() {
  const sql = `
    SELECT
      count(*) FILTER (WHERE last_heartbeat > now() - make_interval(secs => $1)) AS live_nodes,
      count(*) AS enrolled_nodes,
      count(*) FILTER (WHERE is_quarantined) AS quarantined_nodes,
      coalesce(sum(rx_bytes), 0) AS rx_bytes,
      coalesce(sum(tx_bytes), 0) AS tx_bytes,
      avg(cpu_usage_pct) FILTER (WHERE last_heartbeat > now() - make_interval(secs => $1)) AS cpu_pct,
      avg(memory_usage_pct) FILTER (WHERE last_heartbeat > now() - make_interval(secs => $1)) AS mem_pct
    FROM nodes`;

  if (isPostgres()) {
    const pool = getPgPool();
    const nodes = await pool.query(sql, [LIVENESS_WINDOW_SECONDS]);
    const users = await pool.query('SELECT count(*) AS c FROM users');
    return shape(nodes.rows[0], Number(users.rows[0].c));
  }

  // SQLite has no FILTER clause or make_interval.
  const db = getDatabase();
  const cutoff = new Date(Date.now() - LIVENESS_WINDOW_SECONDS * 1000).toISOString();
  const row = db
    .prepare(
      `
    SELECT
      sum(CASE WHEN last_heartbeat > ? THEN 1 ELSE 0 END) AS live_nodes,
      count(*) AS enrolled_nodes,
      sum(CASE WHEN is_quarantined = 1 THEN 1 ELSE 0 END) AS quarantined_nodes,
      coalesce(sum(rx_bytes), 0) AS rx_bytes,
      coalesce(sum(tx_bytes), 0) AS tx_bytes,
      avg(CASE WHEN last_heartbeat > ? THEN cpu_usage_pct END) AS cpu_pct,
      avg(CASE WHEN last_heartbeat > ? THEN memory_usage_pct END) AS mem_pct
    FROM nodes`
    )
    .get(cutoff, cutoff, cutoff);
  const users = db.prepare('SELECT count(*) AS c FROM users').get();
  return shape(row, Number(users.c));
}

function shape(row, activeUsers) {
  const live = Number(row.live_nodes || 0);
  const enrolled = Number(row.enrolled_nodes || 0);
  const quarantined = Number(row.quarantined_nodes || 0);

  return {
    liveNodes: live,
    enrolledNodes: enrolled,
    quarantinedNodes: quarantined,
    activeUsers,
    rxBytes: Number(row.rx_bytes || 0),
    txBytes: Number(row.tx_bytes || 0),
    cpuPct: row.cpu_pct === null || row.cpu_pct === undefined ? null : Number(row.cpu_pct),
    memPct: row.mem_pct === null || row.mem_pct === undefined ? null : Number(row.mem_pct),
    healthScore: computeHealthScore(live, enrolled, quarantined)
  };
}

/**
 * The share of enrolled nodes that are both reachable and not quarantined.
 *
 * This replaces a constant 98.4 that was returned whatever the fleet was doing,
 * including when every node was down. An empty fleet scores 100: there is nothing
 * unhealthy about owning no devices, and reporting 0 would raise an alarm about a
 * condition that is not a fault.
 */
function computeHealthScore(live, enrolled, quarantined) {
  if (enrolled === 0) return 100;
  return Math.round((Math.max(0, live - quarantined) / enrolled) * 100);
}

async function writeSample(state) {
  const params = [
    state.liveNodes,
    state.activeUsers,
    state.rxBytes,
    state.txBytes,
    state.cpuPct ?? 0,
    state.memPct ?? 0,
    state.healthScore
  ];

  if (isPostgres()) {
    const pool = getPgPool();
    await pool.query(
      `
      INSERT INTO system_metrics
        (active_nodes, active_users, total_bandwidth_rx, total_bandwidth_tx,
         cpu_usage_pct, memory_usage_mb, active_circuits, network_health_score)
      VALUES ($1, $2, $3, $4, $5, $6, 0, $7)`,
      params
    );
    await pool.query(`DELETE FROM system_metrics WHERE timestamp < now() - make_interval(hours => $1)`, [
      RETENTION_HOURS
    ]);
    return;
  }

  const db = getDatabase();
  db.prepare(
    `
    INSERT INTO system_metrics
      (active_nodes, active_users, total_bandwidth_rx, total_bandwidth_tx,
       cpu_usage_pct, memory_usage_mb, active_circuits, network_health_score)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(...params);
  const cutoff = new Date(Date.now() - RETENTION_HOURS * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM system_metrics WHERE timestamp < ?').run(cutoff);
}

async function collectOnce() {
  const state = await readFleetState();
  await writeSample(state);
  return state;
}

function startCollector() {
  if (timer) return;

  // A failed sample leaves a gap in the chart. It must not take the process down,
  // and it must not stop the timer, or one transient database error would end
  // metrics collection until the next restart.
  const run = () => {
    collectOnce().catch((err) => {
      console.error('[METRICS] sample failed:', err.message);
    });
  };

  run();
  timer = setInterval(run, SAMPLE_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stopCollector() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startCollector,
  stopCollector,
  collectOnce,
  readFleetState,
  computeHealthScore,
  LIVENESS_WINDOW_SECONDS
};
