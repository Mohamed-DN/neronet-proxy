const crypto = require('crypto');
const { getPgPool } = require('../db');
const { LIFECYCLE_LOCK_ID } = require('./EnrollmentService');
const { nodeVisibility } = require('./FleetVisibility');

const MAX_UINT64 = 18446744073709551615n;
const FRESHNESS_SECONDS = 60;
const denied = (status, message) => Object.assign(new Error(message), { status });

function uint64(value, field, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw denied(400, `${field} must be a canonical unsigned decimal string`);
  }
  const integer = BigInt(value);
  if (integer > MAX_UINT64 || (positive && integer === 0n)) throw denied(400, `${field} is out of range`);
  return value;
}

function normalize(body) {
  if (
    !body ||
    body.version !== 1 ||
    body.source !== 'wireguard-device' ||
    typeof body.traffic_available !== 'boolean' ||
    typeof body.session_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.session_id)
  ) {
    throw denied(400, 'Invalid native telemetry version, source or session');
  }
  const result = {
    version: 1,
    session_id: body.session_id,
    sequence: uint64(body.sequence, 'sequence', true),
    counter_epoch: uint64(body.counter_epoch, 'counter_epoch', true),
    source: body.source,
    traffic_available: body.traffic_available,
    rx_bytes: body.traffic_available ? uint64(body.rx_bytes, 'rx_bytes') : null,
    tx_bytes: body.traffic_available ? uint64(body.tx_bytes, 'tx_bytes') : null,
    memory_runtime_sys_bytes: uint64(body.memory_runtime_sys_bytes, 'memory_runtime_sys_bytes')
  };
  if (!body.traffic_available && (body.rx_bytes !== undefined || body.tx_bytes !== undefined)) {
    throw denied(400, 'Unavailable traffic counters must be omitted');
  }
  return result;
}

async function startSession(client, nodeId) {
  const session = crypto.randomUUID();
  await client.query(
    `INSERT INTO node_native_telemetry (node_id,session_id,organization_id,user_id)
     SELECT id,$2,COALESCE(organization_id,'org-default'),user_id FROM nodes WHERE id=$1
     ON CONFLICT(node_id) DO UPDATE SET session_id=EXCLUDED.session_id,
       organization_id=EXCLUDED.organization_id,user_id=EXCLUDED.user_id,
       sequence=NULL,counter_epoch=NULL,source=NULL,traffic_available=NULL,
       rx_bytes=NULL,tx_bytes=NULL,memory_runtime_sys_bytes=NULL,payload_hash=NULL,received_at=NULL`,
    [nodeId, session]
  );
  return session;
}

async function record(nodeId, credentialId, body) {
  if (!credentialId) throw denied(401, 'Native telemetry requires an authenticated node credential');
  const snapshot = normalize(body);
  const hash = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    // Destruction and registration take the exclusive lifecycle lock. Concurrent
    // heartbeats share it, then serialize only their own observation watermark.
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [LIFECYCLE_LOCK_ID]);
    const identity = await client.query(
      `SELECT n.user_id,COALESCE(n.organization_id,'org-default') AS organization_id,
              n.is_quarantined,u.status,o.destroyed_at
         FROM nodes n JOIN users u ON u.id=n.user_id
         JOIN organizations o ON o.id=COALESCE(n.organization_id,'org-default')
        WHERE n.id=$1 FOR SHARE OF n,u,o`,
      [nodeId]
    );
    const current = identity.rows[0];
    if (!current) throw denied(404, 'Unknown telemetry node');
    if (current.is_quarantined || current.status !== 'active' || current.destroyed_at) {
      throw denied(403, 'Telemetry owner or node is not active');
    }
    const credential = await client.query(
      `SELECT id FROM node_credentials WHERE id=$1 AND node_id=$2
        AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
      [credentialId, nodeId]
    );
    if (!credential.rowCount) throw denied(401, 'Node credential no longer valid');
    const stored = await client.query('SELECT * FROM node_native_telemetry WHERE node_id=$1 FOR UPDATE', [nodeId]);
    const prior = stored.rows[0];
    if (
      !prior ||
      prior.session_id !== snapshot.session_id ||
      prior.user_id !== current.user_id ||
      prior.organization_id !== current.organization_id
    ) {
      throw Object.assign(denied(409, 'Native telemetry session changed; register again'), {
        code: 'native_telemetry_session_changed'
      });
    }
    if (prior.sequence !== null) {
      const order = BigInt(snapshot.sequence) - BigInt(prior.sequence);
      if (order === 0n && prior.payload_hash === hash) {
        await client.query('COMMIT');
        return { duplicate: true };
      }
      if (order <= 0n) throw denied(409, 'Telemetry sequence already consumed');
      const epochOrder = BigInt(snapshot.counter_epoch) - BigInt(prior.counter_epoch);
      if (epochOrder < 0n) throw denied(409, 'Counter epoch is older than the current observation');
      if (
        epochOrder === 0n &&
        prior.traffic_available &&
        snapshot.traffic_available &&
        (BigInt(snapshot.rx_bytes) < BigInt(prior.rx_bytes) || BigInt(snapshot.tx_bytes) < BigInt(prior.tx_bytes))
      ) {
        throw denied(409, 'Counter decreased without a new epoch');
      }
    }
    await client.query(
      `UPDATE node_native_telemetry SET sequence=$2,counter_epoch=$3,source=$4,
       traffic_available=$5,rx_bytes=$6,tx_bytes=$7,memory_runtime_sys_bytes=$8,
       payload_hash=$9,received_at=clock_timestamp() WHERE node_id=$1`,
      [
        nodeId,
        snapshot.sequence,
        snapshot.counter_epoch,
        snapshot.source,
        snapshot.traffic_available,
        snapshot.rx_bytes,
        snapshot.tx_bytes,
        snapshot.memory_runtime_sys_bytes,
        hash
      ]
    );
    await client.query('COMMIT');
    return { duplicate: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function read(accessTier, scope) {
  const visible = nodeVisibility(accessTier, scope);
  return readWhere(visible.join, visible.where, visible.params);
}

// Internal DTO adapter. Bind observations to the ownership that was authorized:
// a transfer between the node SELECT and this read must not attach the new
// owner's measurement to a response authorized for the previous owner.
async function readForNodes(authorizedRows) {
  if (!authorizedRows.length) return { freshness_seconds: FRESHNESS_SECONDS, nodes: [] };
  const identities = authorizedRows.map((row) => ({
    id: row.id,
    organization_id: row.organization_id || 'org-default',
    user_id: row.user_id ?? null
  }));
  return readWhere(
    '',
    `EXISTS (
    SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS authorized(id text,organization_id text,user_id text)
    WHERE authorized.id=n.id AND authorized.organization_id=COALESCE(n.organization_id,'org-default')
      AND authorized.user_id IS NOT DISTINCT FROM n.user_id
  )`,
    [JSON.stringify(identities)]
  );
}

async function readWhere(join, where, params) {
  const result = await getPgPool().query(
    `SELECT n.id AS node_id,t.sequence,t.counter_epoch,t.session_id,t.source,
       t.traffic_available,t.rx_bytes,t.tx_bytes,t.memory_runtime_sys_bytes,t.received_at,
       EXTRACT(EPOCH FROM clock_timestamp()-t.received_at) AS age_seconds
       FROM nodes n ${join}
       LEFT JOIN node_native_telemetry t ON t.node_id=n.id
         AND t.organization_id=COALESCE(n.organization_id,'org-default')
         AND t.user_id IS NOT DISTINCT FROM n.user_id
       WHERE ${where} ORDER BY n.id`,
    params
  );
  return {
    freshness_seconds: FRESHNESS_SECONDS,
    nodes: result.rows.map((row) => ({
      node_id: row.node_id,
      version: row.received_at ? 1 : null,
      source: row.source,
      status: !row.received_at
        ? 'unknown'
        : Number(row.age_seconds) >= 0 && Number(row.age_seconds) <= FRESHNESS_SECONDS
          ? 'fresh'
          : 'stale',
      received_at: row.received_at,
      sequence: row.sequence,
      counter_epoch: row.counter_epoch,
      generation: row.received_at ? `${row.session_id}:${row.counter_epoch}` : null,
      traffic_available: row.traffic_available === true,
      rx_bytes: row.rx_bytes,
      tx_bytes: row.tx_bytes,
      memory_runtime_sys_bytes: row.memory_runtime_sys_bytes,
      memory_usage_pct: null
    }))
  };
}

module.exports = { startSession, record, read, readForNodes, FRESHNESS_SECONDS };
