// stdin: two JSON API snapshots, then the overlay scenario's service/VIP/ID rows.
// This verifies real reported cumulative device counters, never SQL traffic fixtures.
const assert = require("node:assert/strict");
const [beforeLine, afterLine, ...fleet] = require("node:fs")
  .readFileSync(0, "utf8")
  .trim()
  .split(/\r?\n/);
const before = JSON.parse(beforeLine);
const after = JSON.parse(afterLine);
assert.ok(
  Array.isArray(before.nodes) && Array.isArray(after.nodes),
  "native telemetry API unavailable",
);
const ids = fleet.map((line) => line.trim().split(/\s+/)[2]);
assert.ok(
  ids.length >= 2,
  "the traffic scenario requires at least two real nodes",
);
const payload = BigInt(process.argv[1]);
assert.ok(payload > 0n);
// Each node sends to every peer and echoes every peer's payload back. Device
// counters include headers, so the useful payload is a strict lower bound.
const minimum = 2n * BigInt(ids.length - 1) * payload;
for (const id of ids) {
  const a = before.nodes.find((node) => node.node_id === id);
  const b = after.nodes.find((node) => node.node_id === id);
  for (const row of [a, b]) {
    assert.ok(row, `native observation missing for ${id}`);
    assert.equal(row.version, 1);
    assert.equal(row.source, "wireguard-device");
    assert.equal(row.status, "fresh");
    assert.equal(row.traffic_available, true);
    assert.equal(row.memory_usage_pct, null);
    assert.match(row.memory_runtime_sys_bytes, /^[1-9][0-9]*$/);
    assert.match(row.rx_bytes, /^(0|[1-9][0-9]*)$/);
    assert.match(row.tx_bytes, /^(0|[1-9][0-9]*)$/);
  }
  assert.equal(
    b.generation,
    a.generation,
    `${id} changed its counter baseline during the measurement`,
  );
  assert.ok(
    BigInt(b.sequence) > BigInt(a.sequence),
    `${id} supplied no new measurement`,
  );
  const rx = BigInt(b.rx_bytes) - BigInt(a.rx_bytes);
  const tx = BigInt(b.tx_bytes) - BigInt(a.tx_bytes);
  assert.ok(
    rx >= minimum && tx >= minimum,
    `${id} counters did not cover ${minimum} real TCP payload bytes in each direction`,
  );
  console.log(
    `native ${id}: rx_delta=${rx} tx_delta=${tx}, exact decimal counters and runtime bytes`,
  );
}
console.log(
  `native telemetry: ${ids.length} real nodes measured; source, freshness, sequence, epoch and byte units verified`,
);
