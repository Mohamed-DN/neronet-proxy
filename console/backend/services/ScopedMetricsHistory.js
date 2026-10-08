const { getPgPool } = require('../db');
const { nodeVisibility } = require('./FleetVisibility');

async function readMetricHistory(accessTier, scope, hours) {
  const visible = nodeVisibility(accessTier, scope, 1);
  const rows = await getPgPool().query(
    `WITH visible_samples AS (
       SELECT s.*,
              LAG(s.native_generation) OVER source AS previous_generation,
              LAG(s.native_sequence) OVER source AS previous_sequence,
              LAG(s.native_received_at) OVER source AS previous_received_at,
              LAG(s.native_status) OVER source AS previous_status,
              LAG(s.native_traffic_available) OVER source AS previous_available,
              LAG(s.native_rx_bytes) OVER source AS previous_rx,
              LAG(s.native_tx_bytes) OVER source AS previous_tx
         FROM node_metric_samples s JOIN nodes n ON n.id=s.node_id ${visible.join}
        WHERE s.sampled_at > NOW() - make_interval(hours => $1) AND ${visible.where}
          AND s.organization_id=COALESCE(n.organization_id, 'org-default')
          AND s.user_id IS NOT DISTINCT FROM n.user_id
          ${accessTier === 'root' ? '' : 'AND s.is_hidden=FALSE'}
       WINDOW source AS (PARTITION BY s.node_id ORDER BY s.sampled_at)
     ), source_rates AS (
       SELECT *,
         native_status='fresh' AND previous_status='fresh'
           AND native_traffic_available AND previous_available
           AND native_generation=previous_generation
           AND native_sequence>previous_sequence
           AND native_received_at>previous_received_at AS comparable
         FROM visible_samples
     ), rates AS (
       SELECT *,
         CASE WHEN comparable AND native_rx_bytes>=previous_rx THEN
           (native_rx_bytes-previous_rx)/EXTRACT(EPOCH FROM native_received_at-previous_received_at) END AS rx_rate,
         CASE WHEN comparable AND native_tx_bytes>=previous_tx THEN
           (native_tx_bytes-previous_tx)/EXTRACT(EPOCH FROM native_received_at-previous_received_at) END AS tx_rate
         FROM source_rates
     )
     SELECT sampled_at AS timestamp,
            CASE WHEN COUNT(*)=COUNT(*) FILTER (WHERE native_status='fresh' AND native_traffic_available)
              THEN SUM(native_rx_bytes) END AS total_bandwidth_rx,
            CASE WHEN COUNT(*)=COUNT(*) FILTER (WHERE native_status='fresh' AND native_traffic_available)
              THEN SUM(native_tx_bytes) END AS total_bandwidth_tx,
            CASE WHEN COUNT(*)=COUNT(rx_rate) THEN SUM(rx_rate) END AS rx_bytes_per_second,
            CASE WHEN COUNT(*)=COUNT(tx_rate) THEN SUM(tx_rate) END AS tx_bytes_per_second,
            CASE WHEN COUNT(*)=COUNT(*) FILTER (WHERE native_status='fresh' AND native_memory_runtime_sys_bytes IS NOT NULL)
              THEN SUM(native_memory_runtime_sys_bytes) END AS memory_runtime_sys_bytes,
            ARRAY_AGG(node_id ORDER BY node_id) AS node_ids,
            ARRAY_AGG(node_id || ':' || COALESCE(native_generation,'unknown') ORDER BY node_id) AS source_ids,
            BOOL_AND(COALESCE(native_received_at BETWEEN clock_timestamp()-interval '60 seconds' AND clock_timestamp(),FALSE)) AS is_recent,
            COUNT(*)::int AS total_nodes,
            COUNT(*) FILTER (WHERE native_status='fresh' AND native_traffic_available)::int AS measured_nodes,
            COUNT(*) FILTER (WHERE native_status='stale')::int AS stale_nodes,
            COUNT(*) FILTER (WHERE COALESCE(native_status,'unknown')='unknown')::int AS unknown_nodes,
            COUNT(*) FILTER (WHERE native_status='fresh' AND NOT native_traffic_available)::int AS unavailable_nodes,
            COUNT(*) FILTER (WHERE native_status='fresh' AND native_memory_runtime_sys_bytes IS NOT NULL)::int AS memory_measured_nodes,
            COUNT(*) FILTER (WHERE is_live)::int AS active_nodes,
            AVG(cpu_usage_pct) FILTER (WHERE is_live) AS cpu_usage_pct,
            NULL::real AS memory_usage_pct,
            ROUND(100.0 * COUNT(*) FILTER (WHERE is_live AND NOT is_quarantined) / COUNT(*))::int AS network_health_score
       FROM rates GROUP BY sampled_at ORDER BY sampled_at ASC`,
    [hours, ...visible.params]
  );
  return rows.rows;
}

function sameSources(before, after) {
  return (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length &&
    before.every((id, index) => id === after[index])
  );
}

// PostgreSQL subtracts NUMERIC counters before conversion to floating-point rates.
// A changed cohort or source generation requires a baseline, never lifetime traffic.
function counterRates(previous, current) {
  if (!sameSources(previous.node_ids, current.node_ids) || !sameSources(previous.source_ids, current.source_ids)) {
    return { rx: null, tx: null };
  }
  const rate = (axis) =>
    current[`${axis}_bytes_per_second`] === null ? null : Number(current[`${axis}_bytes_per_second`]);
  return { rx: rate('rx'), tx: rate('tx') };
}

function trafficCoverage(row) {
  return {
    source: 'wireguard-device',
    status:
      row.measured_nodes === row.total_nodes
        ? 'measured'
        : row.measured_nodes
          ? 'partial'
          : row.stale_nodes
            ? 'stale'
            : 'unknown',
    total_nodes: row.total_nodes,
    measured_nodes: row.measured_nodes,
    stale_nodes: row.stale_nodes,
    unknown_nodes: row.unknown_nodes,
    unavailable_nodes: row.unavailable_nodes,
    memory_measured_nodes: row.memory_measured_nodes,
    freshness_seconds: 60
  };
}

module.exports = { readMetricHistory, counterRates, sameSources, trafficCoverage };
