const NativeTelemetry = require('./NativeTelemetry');

async function read(accessTier, scope) {
  const { nodes, freshness_seconds } = await NativeTelemetry.read(accessTier, scope);
  const fresh = nodes.filter((node) => node.status === 'fresh' && node.source === 'wireguard-device');
  const measured = fresh.filter((node) => node.traffic_available);
  const memory = fresh.filter((node) => node.memory_runtime_sys_bytes !== null);
  const complete = nodes.length > 0 && measured.length === nodes.length;
  const stale = nodes.filter((node) => node.status === 'stale').length;
  const sum = (rows, field) => rows.reduce((total, row) => total + BigInt(row[field]), 0n).toString();
  return {
    rxBytes: complete ? sum(measured, 'rx_bytes') : null,
    txBytes: complete ? sum(measured, 'tx_bytes') : null,
    memoryBytes: nodes.length > 0 && memory.length === nodes.length ? sum(memory, 'memory_runtime_sys_bytes') : null,
    sourceIds: nodes.map((node) => `${node.node_id}:${node.generation || 'unknown'}`),
    traffic: {
      source: 'wireguard-device',
      status: complete ? 'measured' : measured.length ? 'partial' : stale ? 'stale' : 'unknown',
      total_nodes: nodes.length,
      measured_nodes: measured.length,
      stale_nodes: stale,
      unknown_nodes: nodes.filter((node) => node.status === 'unknown').length,
      unavailable_nodes: fresh.filter((node) => !node.traffic_available).length,
      memory_measured_nodes: memory.length,
      freshness_seconds
    }
  };
}

module.exports = { read };
