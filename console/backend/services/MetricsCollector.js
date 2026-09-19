const { isPostgres, getPgPool, getDatabase } = require('../db/index');
const { derivePostureStatus, emptyPostureCounts } = require('../utils/posture');

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
  // cpu_usage_pct = 0 is the node saying "not measured": nothing on a node samples
  // CPU yet, and the wire field has no null. Averaging those zeros in reported a
  // fleet-wide 0% load as if it were a measurement, so they are excluded and the
  // average is null when no node measured anything. Memory is genuinely measured
  // (runtime.MemStats) and is averaged as-is.
  const sql = `
    SELECT
      count(*) FILTER (WHERE last_heartbeat > now() - make_interval(secs => $1)) AS live_nodes,
      count(*) AS enrolled_nodes,
      count(*) FILTER (WHERE is_quarantined) AS quarantined_nodes,
      coalesce(sum(rx_bytes), 0) AS rx_bytes,
      coalesce(sum(tx_bytes), 0) AS tx_bytes,
      avg(cpu_usage_pct) FILTER (
        WHERE last_heartbeat > now() - make_interval(secs => $1) AND cpu_usage_pct > 0
      ) AS cpu_pct,
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
      avg(CASE WHEN last_heartbeat > ? AND cpu_usage_pct > 0 THEN cpu_usage_pct END) AS cpu_pct,
      avg(CASE WHEN last_heartbeat > ? THEN memory_usage_pct END) AS mem_pct
    FROM nodes`
    )
    .get(cutoff, cutoff, cutoff);
  const users = db.prepare('SELECT count(*) AS c FROM users').get();
  return shape(row, Number(users.c));
}

/**
 * Counts nodes by posture status across the whole fleet.
 *
 * The derivation is deliberately in JavaScript rather than in two dialects of SQL
 * JSON: there is then one definition of what verified_compliant means, shared with
 * the node list, and a row holding an unparseable document degrades to unverified
 * instead of failing the query. It reads one column for every node, which is fine at
 * the fleet sizes this console handles and is the first thing to turn into a stored
 * column if that stops being true.
 */
async function readPostureCounts() {
  let rows;

  if (isPostgres()) {
    const result = await getPgPool().query('SELECT posture_checks FROM nodes');
    rows = result.rows;
  } else {
    rows = getDatabase().prepare('SELECT posture_checks FROM nodes').all();
  }

  const counts = emptyPostureCounts();

  for (const row of rows) {
    let posture = row.posture_checks;
    if (typeof posture === 'string') {
      try {
        posture = JSON.parse(posture);
      } catch (err) {
        posture = null;
      }
    }
    counts[derivePostureStatus(posture)] += 1;
  }

  return counts;
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
  readPostureCounts,
  computeHealthScore,
  LIVENESS_WINDOW_SECONDS
};
