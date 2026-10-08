// Explicit native observations for HTTP/SQL component tests. These fixtures do
// not certify daemon traffic; the overlay scenario provides that independent gate.
const NativeTelemetry = require('../../services/NativeTelemetry');

async function seedNative(pool, id, { rx = '100', tx = '200', memory = '4096', ago = 0 } = {}) {
  await NativeTelemetry.startSession(pool, id);
  await pool.query(
    `UPDATE node_native_telemetry SET sequence=1,counter_epoch=1,source='wireguard-device',
      traffic_available=TRUE,rx_bytes=$2,tx_bytes=$3,memory_runtime_sys_bytes=$4,
      received_at=clock_timestamp()-make_interval(secs=>$5) WHERE node_id=$1`,
    [id, String(rx), String(tx), String(memory), ago]
  );
}

async function advanceFromLegacy(pool) {
  await pool.query(
    `UPDATE node_native_telemetry t SET sequence=t.sequence+1,rx_bytes=n.rx_bytes,
       tx_bytes=n.tx_bytes,received_at=clock_timestamp()
       FROM nodes n WHERE n.id=t.node_id`
  );
}

module.exports = { seedNative, advanceFromLegacy };
