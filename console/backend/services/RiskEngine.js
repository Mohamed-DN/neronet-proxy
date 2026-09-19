/**
 * RiskEngine.js
 * Behavioral Risk Score & Impossible Travel Detection Engine (R3, R7)
 *
 * Features:
 * - Computes great-circle geo-velocity between heartbeats using Haversine formula & PostGIS.
 * - Detects impossible travel (> 1000 km/h) -> sets is_impossible_travel = true, risk_score += 50.
 * - Evaluates network telemetry anomalies: RTT drift (> 100ms -> +25 risk), jitter (> 20ms -> +15 risk).
 * - Automatic Quarantine: if risk_score > 75 -> is_quarantined = true, reassigns overlay IP to 100.64.250.0/24,
 *   logs audit event, and publishes topology event to Valkey (neronet:topology:events).
 * - Supports risk attestation & remediation.
 */

const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');
const { publishTopologyEvent } = require('../db/valkey');
const { broadcastNodeEvent } = require('./TopologySync');
const { bumpNetmap } = require('./AclEngine');
const logger = require('../utils/logger');

const EARTH_RADIUS_KM = 6371.0;

function toRadians(degrees) {
  return degrees * (Math.PI / 180.0);
}

/**
 * Calculates distance in kilometers between two geographic coordinates using the Haversine formula.
 */
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);

  const a = Math.sin(dLat / 2.0) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2.0) ** 2;
  const c = 2.0 * Math.atan2(Math.sqrt(Math.max(0.0, a)), Math.sqrt(Math.max(0.0, 1.0 - a)));
  return EARTH_RADIUS_KM * c;
}

/**
 * Calculates great-circle velocity in km/h given two points and elapsed time in seconds.
 */
function calculateVelocityKmh(lat1, lon1, lat2, lon2, dtSeconds) {
  if (!dtSeconds || dtSeconds <= 0) {
    return 0.0;
  }
  const distanceKm = calculateDistanceKm(lat1, lon1, lat2, lon2);
  const hours = dtSeconds / 3600.0;
  return distanceKm / hours;
}

/**
 * Ensures SQLite node_telemetry_history table exists if running in SQLite mode.
 */
function ensureTelemetrySchema(db) {
  if (!isPostgres() && db && typeof db.exec === 'function') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_telemetry_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        ip_address TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        country_code TEXT NOT NULL DEFAULT 'US',
        latency_ms REAL NOT NULL DEFAULT 0.0,
        calculated_speed_kmh REAL DEFAULT 0.0,
        is_impossible_travel INTEGER NOT NULL DEFAULT 0,
        recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_node_telemetry_node_time ON node_telemetry_history(node_id, recorded_at DESC);
    `);
  }
}

/**
 * Fetches node record by ID from database.
 */
async function getNodeById(nodeId) {
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM nodes WHERE id = $1', [nodeId]);
    return res.rows[0] || null;
  } else {
    const db = getDatabase();
    ensureTelemetrySchema(db);
    return db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) || null;
  }
}

/**
 * Fetches the most recent telemetry history record for a node.
 */
async function getLatestTelemetry(nodeId) {
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query(
      'SELECT * FROM node_telemetry_history WHERE node_id = $1 ORDER BY recorded_at DESC LIMIT 1',
      [nodeId]
    );
    return res.rows[0] || null;
  } else {
    const db = getDatabase();
    ensureTelemetrySchema(db);
    return (
      db
        .prepare('SELECT * FROM node_telemetry_history WHERE node_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1')
        .get(nodeId) || null
    );
  }
}

/**
 * Allocates a quarantine overlay IP in 100.64.250.0/24 subnet.
 */
async function allocateQuarantineIp(nodeId) {
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query("SELECT overlay_ipv4 FROM nodes WHERE overlay_ipv4 LIKE '100.64.250.%'");
    const used = new Set(res.rows.map((r) => r.overlay_ipv4));
    for (let i = 10; i < 250; i++) {
      const candidate = `100.64.250.${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `100.64.250.${Math.floor(Math.random() * 200) + 10}`;
  } else {
    const db = getDatabase();
    const rows = db.prepare("SELECT overlay_ipv4 FROM nodes WHERE overlay_ipv4 LIKE '100.64.250.%'").all();
    const used = new Set(rows.map((r) => r.overlay_ipv4));
    for (let i = 10; i < 250; i++) {
      const candidate = `100.64.250.${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `100.64.250.${Math.floor(Math.random() * 200) + 10}`;
  }
}

/**
 * Ingests node telemetry and evaluates behavioral risk.
 */
async function ingestTelemetry(nodeId, telemetry) {
  const {
    latitude,
    longitude,
    rtt_ms = 15.0,
    jitter_ms = 1.0,
    ip_address = '127.0.0.1',
    country_code = 'US',
    timestamp_epoch
  } = telemetry;

  if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) {
    const err = new Error('Missing latitude or longitude');
    err.status = 400;
    throw err;
  }

  const lat = Number(latitude);
  const lon = Number(longitude);

  if (isNaN(lat) || isNaN(lon) || lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) {
    const err = new Error('Latitude or longitude out of geographic bounds');
    err.status = 400;
    throw err;
  }

  const node = await getNodeById(nodeId);
  if (!node) {
    const err = new Error(`Node not found: ${nodeId}`);
    err.status = 404;
    throw err;
  }

  const currentEpoch = timestamp_epoch !== undefined ? Number(timestamp_epoch) : Date.now() / 1000.0;
  const latestTel = await getLatestTelemetry(nodeId);

  let velocityKmh = 0.0;
  let impossibleTravel = false;

  if (latestTel && latestTel.latitude !== null && latestTel.longitude !== null) {
    let prevEpoch;
    if (latestTel.recorded_at) {
      prevEpoch = new Date(latestTel.recorded_at).getTime() / 1000.0;
    } else {
      prevEpoch = currentEpoch - 60;
    }
    const dt = currentEpoch - prevEpoch;
    if (dt > 0.0001) {
      velocityKmh = calculateVelocityKmh(latestTel.latitude, latestTel.longitude, lat, lon, dt);
    }
  }

  // Evaluate risk score increments
  let currentRisk = Number(node.risk_score) || 0;

  if (velocityKmh > 1000.0) {
    impossibleTravel = true;
    currentRisk += 50;
  }

  const rtt = Number(rtt_ms) || 0;
  if (rtt > 100.0) {
    currentRisk += 25;
  }

  const jitter = Number(jitter_ms) || 0;
  if (jitter > 20.0) {
    currentRisk += 15;
  }

  const finalRiskScore = Math.min(100, Math.max(0, Math.round(currentRisk)));
  const shouldQuarantine = finalRiskScore > 75;
  let newOverlayIp = node.overlay_ipv4;
  let isQuarantined = Boolean(node.is_quarantined);

  if (shouldQuarantine && !isQuarantined) {
    isQuarantined = true;
    newOverlayIp = await allocateQuarantineIp(nodeId);
  }

  // Update Database
  const nowIso = new Date().toISOString();
  if (isPostgres()) {
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO node_telemetry_history 
       (node_id, ip_address, latitude, longitude, country_code, latency_ms, calculated_speed_kmh, is_impossible_travel, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [nodeId, ip_address, lat, lon, country_code, rtt, velocityKmh, impossibleTravel, nowIso]
    );

    await pool.query(
      `UPDATE nodes SET
        risk_score = $1,
        is_quarantined = $2,
        quarantine_reason = $3,
        overlay_ipv4 = $4,
        latency_ms = $5,
        last_geo_drift_at = CASE WHEN $6 = true THEN $7::timestamptz ELSE last_geo_drift_at END,
        last_heartbeat = $7,
        longitude = $8,
        latitude = $9,
        updated_at = $7
       WHERE id = $10`,
      [
        finalRiskScore,
        isQuarantined,
        shouldQuarantine ? 'Behavioral Risk Score > 75 (Impossible travel / network anomaly)' : node.quarantine_reason,
        newOverlayIp,
        rtt,
        impossibleTravel,
        nowIso,
        lon,
        lat,
        nodeId
      ]
    );
  } else {
    const db = getDatabase();
    ensureTelemetrySchema(db);
    db.prepare(
      `INSERT INTO node_telemetry_history 
       (node_id, ip_address, latitude, longitude, country_code, latency_ms, calculated_speed_kmh, is_impossible_travel, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(nodeId, ip_address, lat, lon, country_code, rtt, velocityKmh, impossibleTravel ? 1 : 0, nowIso);

    db.prepare(
      `UPDATE nodes SET
        risk_score = ?,
        is_quarantined = ?,
        quarantine_reason = ?,
        overlay_ipv4 = ?,
        latency_ms = ?,
        last_geo_drift_at = CASE WHEN ? = 1 THEN ? ELSE last_geo_drift_at END,
        last_heartbeat = ?,
        updated_at = ?
       WHERE id = ?`
    ).run(
      finalRiskScore,
      isQuarantined ? 1 : 0,
      shouldQuarantine ? 'Behavioral Risk Score > 75 (Impossible travel / network anomaly)' : node.quarantine_reason,
      newOverlayIp,
      rtt,
      impossibleTravel ? 1 : 0,
      nowIso,
      nowIso,
      nowIso,
      nodeId
    );
  }

  // The overlay address moves when a node is quarantined, and a quarantined node
  // leaves every peer set: both are peer-visible, so the netmap version has to move
  // with them.
  if (isQuarantined !== Boolean(node.is_quarantined) || node.overlay_ipv4 !== newOverlayIp) {
    await bumpNetmap();
  }

  // If newly quarantined, record audit log and broadcast topology events
  if (shouldQuarantine && (!node.is_quarantined || node.overlay_ipv4 !== newOverlayIp)) {
    logger.warn(`Node ${nodeId} (${node.name}) auto-quarantined due to risk score ${finalRiskScore}`);
    logAuditEvent({
      eventType: 'NODE_QUARANTINED',
      severity: 'critical',
      actorUsername: 'RiskEngine',
      targetId: nodeId,
      targetType: 'node',
      message: `Node automatically quarantined: risk score ${finalRiskScore} > 75 (velocity ${velocityKmh.toFixed(1)} km/h)`,
      metadata: {
        risk_score: finalRiskScore,
        velocity_kmh: velocityKmh,
        impossible_travel: impossibleTravel,
        overlay_ipv4: newOverlayIp
      }
    });

    const eventPayload = {
      event_type: 'NODE_QUARANTINED',
      payload: {
        node_id: nodeId,
        name: node.name,
        user_id: node.user_id,
        risk_score: finalRiskScore,
        overlay_ipv4: newOverlayIp,
        is_quarantined: true,
        quarantine_reason: 'Behavioral Risk Score > 75 (Impossible travel / network anomaly)'
      }
    };
    publishTopologyEvent('neronet:topology:events', eventPayload);
    broadcastNodeEvent('node:quarantined', eventPayload.payload);
  }

  const color = finalRiskScore < 40 ? 'green' : finalRiskScore <= 75 ? 'yellow' : 'red';

  return {
    node_id: nodeId,
    risk_score: finalRiskScore,
    velocity_kmh: Number(velocityKmh.toFixed(2)),
    impossible_travel_detected: impossibleTravel,
    is_quarantined: isQuarantined,
    overlay_ipv4: newOverlayIp,
    color
  };
}

/**
 * Lists risk scores for all nodes.
 */
async function getAllRiskScores() {
  let rows = [];
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query(
      'SELECT id, name, user_id, risk_score, is_quarantined, is_healthy, latency_ms FROM nodes ORDER BY risk_score DESC'
    );
    rows = res.rows;
  } else {
    const db = getDatabase();
    ensureTelemetrySchema(db);
    rows = db
      .prepare(
        'SELECT id, name, user_id, risk_score, is_quarantined, is_healthy, latency_ms FROM nodes ORDER BY risk_score DESC'
      )
      .all();
  }

  return rows.map((n) => {
    const score = Number(n.risk_score) || 0;
    const isQuarantined = Boolean(n.is_quarantined);
    const color = score < 40 ? 'green' : score <= 75 ? 'yellow' : 'red';
    return {
      node_id: n.id,
      id: n.id,
      name: n.name,
      user_id: n.user_id,
      risk_score: score,
      status: isQuarantined ? 'quarantined' : n.is_healthy ? 'active' : 'degraded',
      is_quarantined: isQuarantined,
      latency_ms: Number(n.latency_ms) || 0.0,
      color
    };
  });
}

/**
 * Gets aggregated behavioral risk dashboard data.
 */
async function getRiskDashboard() {
  const scores = await getAllRiskScores();
  const total = scores.length;
  const lowRisk = scores.filter((s) => s.risk_score < 40).length;
  const mediumRisk = scores.filter((s) => s.risk_score >= 40 && s.risk_score <= 75).length;
  const highRisk = scores.filter((s) => s.risk_score > 75).length;
  const quarantined = scores.filter((s) => s.is_quarantined).length;
  const avgScore = total > 0 ? Number((scores.reduce((acc, s) => acc + s.risk_score, 0) / total).toFixed(1)) : 0;

  return {
    total_nodes: total,
    low_risk_nodes: lowRisk,
    medium_risk_nodes: mediumRisk,
    high_risk_nodes: highRisk,
    quarantined_nodes: quarantined,
    average_risk_score: avgScore,
    nodes: scores
  };
}

/**
 * Remediates/attests a node risk score back to 0 and lifts quarantine.
 */
async function attestNode(nodeId, actor) {
  const node = await getNodeById(nodeId);
  if (!node) {
    const err = new Error(`Node not found: ${nodeId}`);
    err.status = 404;
    throw err;
  }

  const nowIso = new Date().toISOString();
  if (isPostgres()) {
    const pool = getPgPool();
    await pool.query(
      `UPDATE nodes SET
        risk_score = 0,
        is_quarantined = FALSE,
        quarantine_reason = NULL,
        is_healthy = TRUE,
        updated_at = $1
       WHERE id = $2`,
      [nowIso, nodeId]
    );
  } else {
    const db = getDatabase();
    ensureTelemetrySchema(db);
    db.prepare(
      `UPDATE nodes SET
        risk_score = 0,
        is_quarantined = 0,
        quarantine_reason = NULL,
        is_healthy = 1,
        updated_at = ?
       WHERE id = ?`
    ).run(nowIso, nodeId);
  }

  // The node rejoins every peer set it was removed from.
  await bumpNetmap();

  logAuditEvent({
    eventType: 'RISK_ATTESTATION',
    severity: 'info',
    actorUserId: actor ? actor.id : null,
    actorUsername: actor ? actor.username : 'admin',
    targetId: nodeId,
    targetType: 'node',
    message: `Node risk attested and quarantine lifted by ${actor ? actor.username : 'admin'}`
  });

  const eventPayload = {
    event_type: 'NODE_ATTESTED',
    payload: {
      node_id: nodeId,
      risk_score: 0,
      is_quarantined: false,
      status: 'active'
    }
  };
  publishTopologyEvent('neronet:topology:events', eventPayload);
  broadcastNodeEvent('node:updated', eventPayload.payload);

  return {
    success: true,
    node_id: nodeId,
    risk_score: 0,
    status: 'active',
    is_quarantined: false
  };
}

module.exports = {
  calculateDistanceKm,
  calculateVelocityKmh,
  ingestTelemetry,
  getAllRiskScores,
  getRiskDashboard,
  attestNode,
  getNodeById,
  ensureTelemetrySchema
};
