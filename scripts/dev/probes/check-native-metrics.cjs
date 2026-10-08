// Reads only authenticated HTTP observations and traffic-scenario inventory.
// No SQL fixtures or synthetic counter updates are used by this live probe.
const assert = require("node:assert/strict");
const lines = require("node:fs")
  .readFileSync(0, "utf8")
  .trim()
  .split(/\r?\n/)
  .filter((line) => line.trim());
const mode = process.argv[1];
const payload = BigInt(process.argv[2]);
const [baseline, history, before, overview, nodes, after] = lines
  .slice(0, 6)
  .map(JSON.parse);
const ids = lines.slice(6).map((line) => line.trim().split(/\s+/)[2]);
const point = history.at(-1);
assert.ok(ids.length >= 2);
const complete = (row) => {
  assert.equal(row.traffic.source, "wireguard-device");
  assert.equal(row.traffic.status, "measured");
  assert.equal(row.traffic.measured_nodes, ids.length);
  assert.equal(row.traffic.total_nodes, ids.length);
};
complete(point);
assert.match(point.rx_bytes, /^[0-9]+$/);
assert.match(point.tx_bytes, /^[0-9]+$/);
if (mode === "baseline") process.exit(0);
const first = baseline.at(-1);
assert.ok(
  new Date(point.timestamp) > new Date(first.timestamp),
  "waiting for a new scheduled sample",
);
const minimum = 2n * BigInt(ids.length - 1) * BigInt(ids.length) * payload;
assert.ok(
  BigInt(point.rx_bytes) - BigInt(first.rx_bytes) >= minimum,
  "history did not cover real RX payload",
);
assert.ok(
  BigInt(point.tx_bytes) - BigInt(first.tx_bytes) >= minimum,
  "history did not cover real TX payload",
);
assert.ok(
  point.rx_bytes_per_second > 0 && point.tx_bytes_per_second > 0,
  "scheduled rates are not measured",
);
assert.equal(point.memory_usage_pct, null);
assert.match(point.memory_runtime_sys_bytes, /^[1-9][0-9]*$/);
complete(overview);
assert.equal(overview.avg_memory_pct, null);
for (const axis of ["rx", "tx"]) {
  const sum = (snapshot) =>
    ids.reduce(
      (n, id) =>
        n +
        BigInt(
          snapshot.nodes.find((row) => row.node_id === id)[`${axis}_bytes`],
        ),
      0n,
    );
  const total = BigInt(overview[`total_${axis}_bytes`]);
  assert.ok(
    total >= sum(before) && total <= sum(after),
    "overview is not bounded by real native observations",
  );
}
assert.equal(
  overview.total_bandwidth_bytes,
  (
    BigInt(overview.total_rx_bytes) + BigInt(overview.total_tx_bytes)
  ).toString(),
);
assert.equal(nodes.total, ids.length);
for (const id of ids) {
  const node = nodes.nodes.find((n) => n.id === id);
  assert.ok(node, "node DTO missing");
  const observation = node.native_telemetry;
  assert.equal(observation.status, "fresh");
  assert.equal(observation.source, "wireguard-device");
  assert.equal(node.rx_bytes, observation.rx_bytes);
  assert.equal(node.tx_bytes, observation.tx_bytes);
  assert.equal(
    node.memory_runtime_sys_bytes,
    observation.memory_runtime_sys_bytes,
  );
  assert.equal(node.memory_usage_pct, null);
  assert.equal(
    before.nodes.find((n) => n.node_id === id).generation,
    after.nodes.find((n) => n.node_id === id).generation,
  );
}
console.log(
  `native metrics: ${ids.length} real nodes; overview, DTOs and scheduled history cover >=${minimum} TCP payload bytes per direction; source and memory units verified`,
);
