const { getPgPool } = require('../db');
const { nodeVisibility } = require('./FleetVisibility');

async function readMetricHistory(accessTier, scope, hours) {
  const visible = nodeVisibility(accessTier, scope, 1);
  const rows = await getPgPool().query(
    `WITH visible_samples AS (
       SELECT s.*, LAG(s.rx_bytes) OVER source AS previous_rx,
              LAG(s.tx_bytes) OVER source AS previous_tx
         FROM node_metric_samples s JOIN nodes n ON n.id=s.node_id ${visible.join}
        WHERE s.sampled_at > NOW() - make_interval(hours => $1) AND ${visible.where}
          AND s.organization_id=COALESCE(n.organization_id, 'org-default')
          AND s.user_id IS NOT DISTINCT FROM n.user_id
          ${accessTier === 'root' ? '' : 'AND s.is_hidden=FALSE'}
       WINDOW source AS (PARTITION BY s.node_id ORDER BY s.sampled_at)
     )
     SELECT sampled_at AS timestamp,
            SUM(rx_bytes) AS total_bandwidth_rx, SUM(tx_bytes) AS total_bandwidth_tx,
            ARRAY_AGG(node_id ORDER BY node_id) AS node_ids,
            BOOL_OR(rx_bytes < previous_rx) AS rx_counter_reset,
            BOOL_OR(tx_bytes < previous_tx) AS tx_counter_reset,
            COUNT(*) FILTER (WHERE is_live)::int AS active_nodes,
            AVG(cpu_usage_pct) FILTER (WHERE is_live) AS cpu_usage_pct,
            AVG(memory_usage_pct) FILTER (WHERE is_live) AS memory_usage_pct,
            ROUND(100.0 * COUNT(*) FILTER (WHERE is_live AND NOT is_quarantined) / COUNT(*))::int AS network_health_score
       FROM visible_samples GROUP BY sampled_at ORDER BY sampled_at ASC`,
    [hours, ...visible.params]
  );
  return rows.rows;
}

// A larger fleet total can conceal a reset on one node or include a new node's
// lifetime traffic. Compare the actual visible sources and their individual
// counter continuity before deriving either rate. These IDs stay internal.
function counterDeltas(previous, current) {
  const before = previous.node_ids;
  const after = current.node_ids;
  if (
    !Array.isArray(before) ||
    !Array.isArray(after) ||
    before.length !== after.length ||
    before.some((id, index) => id !== after[index])
  ) {
    return { rx: null, tx: null };
  }
  const delta = (axis) => {
    const bytes = Number(current[`total_bandwidth_${axis}`]) - Number(previous[`total_bandwidth_${axis}`]);
    return current[`${axis}_counter_reset`] || !Number.isFinite(bytes) || bytes < 0 ? null : bytes;
  };
  return { rx: delta('rx'), tx: delta('tx') };
}

module.exports = { readMetricHistory, counterDeltas };
