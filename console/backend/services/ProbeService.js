'use strict';

/**
 * The connection test (ADR 0040).
 *
 * The console button used to send nothing and show the last stored number. Now a request
 * is written here, the serving gateway collects it through a held-open poll
 * (POST /v4/control/probe/poll answers the moment a request exists, or after at most
 * POLL_HOLD_MS with nothing), pings the device through its tunnel at once and answers
 * (POST /v4/control/probe/result). Typical time from click to answer is one poll step
 * (250 ms) plus the ping, well inside the five seconds the button promises. The heartbeat
 * is not used: it beats every 15 s and its response cannot start a probe sooner.
 *
 * One live request per device (a second ask returns the first), a short gap between asks
 * and a per-person budget, an expiry of 30 s, and only the device's serving gateway can
 * collect or answer a request.
 */

const crypto = require('crypto');
const { getPgPool } = require('../db/index');
const ProfileGatewayService = require('./ProfileGatewayService');
const ProfileHandshake = require('./ProfileHandshake');
const NodeLive = require('./NodeLive');

const EXPIRY_SECONDS = 30;
// Overridable for the tests; a gateway never needs more than this to learn it has nothing to do.
const POLL_HOLD_MS = Number(process.env.SOVEREIGN_PROBE_POLL_HOLD_MS) || 20_000;
const POLL_STEP_MS = 250;
// A gateway that has not heartbeated for this long is treated as not reachable: four of
// its fifteen-second beats, the console's own liveness window.
const GATEWAY_FRESH_SECONDS = 60;
const MIN_GAP_MS = 2000;
const PER_USER_PER_MINUTE = 20;
const MAX_PER_POLL = 8;
const MAX_RTT_MS = 60_000;

function pool(client) {
  return client || getPgPool();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function expireStale(client) {
  await pool(client).query(
    `UPDATE probe_requests SET state = 'expired'
      WHERE state IN ('pending', 'delivered') AND expires_at < now()`
  );
}

/**
 * Ask for a probe of `device`. Returns { http, body }: body.state is one of
 * 'pending', 'unsupported', 'not_connected', 'gateway_unreachable'. Only 'pending'
 * stores a request; the others are answers the console can give at once and truthfully.
 */
async function request(device, user) {
  if (device.device_kind !== 'profile') {
    return { http: 200, body: { state: 'unsupported', reason: 'not_a_profile_device' } };
  }
  const db = pool();
  await expireStale(db);

  const handshake = ProfileHandshake.status(device.last_handshake_at);
  const lastContactAt = device.last_handshake_at ? new Date(device.last_handshake_at).toISOString() : null;

  const live = await db.query(
    `SELECT id, state, expires_at FROM probe_requests
      WHERE device_id = $1 AND state IN ('pending', 'delivered')`,
    [device.id]
  );
  if (live.rows[0]) {
    return {
      http: 200,
      body: { request_id: live.rows[0].id, state: 'pending', expires_at: new Date(live.rows[0].expires_at).toISOString() }
    };
  }

  const gap = await db.query(
    `SELECT 1 FROM probe_requests WHERE device_id = $1 AND created_at > now() - make_interval(secs => $2)`,
    [device.id, MIN_GAP_MS / 1000]
  );
  const budget = await db.query(
    `SELECT count(*)::int AS n FROM probe_requests WHERE requested_by = $1 AND created_at > now() - interval '1 minute'`,
    [user.id]
  );
  if (gap.rows.length > 0 || budget.rows[0].n >= PER_USER_PER_MINUTE) {
    return { http: 429, body: { error: 'too many connection tests; wait a moment', retry_after_seconds: 2 } };
  }

  const serving = await servingGateway(db, device.id);
  const fresh =
    serving &&
    serving.is_quarantined !== true &&
    serving.last_heartbeat &&
    Date.now() - new Date(serving.last_heartbeat).getTime() <= GATEWAY_FRESH_SECONDS * 1000;
  if (!fresh) {
    return { http: 200, body: { state: 'gateway_unreachable', last_contact_at: lastContactAt } };
  }
  if (handshake !== 'connected') {
    return { http: 200, body: { state: 'not_connected', last_contact_at: lastContactAt } };
  }

  const id = `prb-${crypto.randomBytes(8).toString('hex')}`;
  try {
    await db.query(
      `INSERT INTO probe_requests (id, device_id, gateway_id, organization_id, requested_by, expires_at)
       VALUES ($1, $2, $3, COALESCE($4, 'org-default'), $5, now() + make_interval(secs => $6))`,
      [id, device.id, serving.id, device.organization_id, user.id, EXPIRY_SECONDS]
    );
  } catch (err) {
    if (err.code === '23505') {
      // Lost the race with another click: the one live request answers both.
      const winner = await db.query(
        `SELECT id, expires_at FROM probe_requests WHERE device_id = $1 AND state IN ('pending', 'delivered')`,
        [device.id]
      );
      if (winner.rows[0]) {
        return {
          http: 200,
          body: {
            request_id: winner.rows[0].id,
            state: 'pending',
            expires_at: new Date(winner.rows[0].expires_at).toISOString()
          }
        };
      }
    }
    throw err;
  }
  return {
    http: 202,
    body: { request_id: id, state: 'pending', expires_at: new Date(Date.now() + EXPIRY_SECONDS * 1000).toISOString() }
  };
}

async function servingGateway(db, deviceId) {
  const res = await db.query(
    `SELECT g.id, g.is_quarantined, g.last_heartbeat
       FROM nodes d JOIN nodes g ON g.id = ${ProfileGatewayService.servingGatewaySql('d')}
      WHERE d.id = $1`,
    [deviceId]
  );
  return res.rows[0] || null;
}

/**
 * The state of one request, as the console shows it. 'measuring' until the gateway
 * answers; then 'replied' with the round trip, or 'no_reply'. A request nobody answered
 * in time is 'gateway_unreachable'. The figure is the request's own, never a stored one.
 */
async function read(requestId, deviceId) {
  const db = pool();
  await expireStale(db);
  const res = await db.query(
    `SELECT p.id, p.state, p.replied, p.rtt_ms, p.answered_at, p.expires_at,
            d.last_handshake_at, d.is_quarantined
       FROM probe_requests p JOIN nodes d ON d.id = p.device_id
      WHERE p.id = $1 AND p.device_id = $2`,
    [requestId, deviceId]
  );
  const row = res.rows[0];
  if (!row) return null;
  const lastContactAt = row.last_handshake_at ? new Date(row.last_handshake_at).toISOString() : null;
  if (row.state === 'pending' || row.state === 'delivered') return { request_id: row.id, state: 'measuring' };
  if (row.state === 'expired') {
    return { request_id: row.id, state: 'gateway_unreachable', last_contact_at: lastContactAt };
  }
  const base = {
    request_id: row.id,
    method: 'icmp',
    answered_at: new Date(row.answered_at).toISOString(),
    last_contact_at: lastContactAt
  };
  return row.replied
    ? { ...base, state: 'replied', rtt_ms: Number(row.rtt_ms) }
    : { ...base, state: 'no_reply', rtt_ms: null };
}

/**
 * Hand the gateway its requests, waiting up to `holdMs` for one. `aborted()` lets the
 * route stop when the gateway hangs up.
 */
async function claim(gatewayId, { holdMs = POLL_HOLD_MS, aborted = () => false } = {}) {
  const db = pool();
  const deadline = Date.now() + holdMs;
  for (;;) {
    const res = await db.query(
      `UPDATE probe_requests SET state = 'delivered'
        WHERE id IN (SELECT id FROM probe_requests
                      WHERE gateway_id = $1 AND state = 'pending' AND expires_at > now()
                      ORDER BY created_at LIMIT ${MAX_PER_POLL} FOR UPDATE SKIP LOCKED)
        RETURNING id, device_id`,
      [gatewayId]
    );
    if (res.rows.length > 0) return res.rows.map((r) => ({ request_id: r.id, peer_id: r.device_id }));
    if (aborted() || Date.now() + POLL_STEP_MS >= deadline) return [];
    await sleep(POLL_STEP_MS);
  }
}

/**
 * The gateway's answer. Believed only from the gateway the request names, only while the
 * request is live. A reply stores the round trip on the device as a fresh sample; no
 * reply stores "pinged, nothing came back" with the time, never a number.
 */
async function answer(gatewayId, requestId, { replied, rtt_ms: rttMs }) {
  if (typeof requestId !== 'string' || typeof replied !== 'boolean') {
    return { http: 400, body: { error: 'request_id and replied are required' } };
  }
  const rtt = replied ? Number(rttMs) : null;
  if (replied && !(Number.isFinite(rtt) && rtt >= 0 && rtt <= MAX_RTT_MS)) {
    return { http: 400, body: { error: 'rtt_ms must be between 0 and 60000 for a reply' } };
  }
  const db = pool();
  const res = await db.query(
    `UPDATE probe_requests SET state = 'done', replied = $3, rtt_ms = $4, answered_at = now()
      WHERE id = $1 AND gateway_id = $2 AND state IN ('pending', 'delivered') AND expires_at > now()
      RETURNING device_id`,
    [requestId, gatewayId, replied, rtt]
  );
  if (res.rows.length === 0) return { http: 409, body: { error: 'request not live for this gateway' } };
  const deviceId = res.rows[0].device_id;
  await db.query(
    `UPDATE nodes SET rtt_ms = $2, rtt_measured_at = now(), rtt_method = 'icmp' WHERE id = $1`,
    [deviceId, rtt]
  );
  NodeLive.notifyNodeUpdated(deviceId, { immediate: true });
  return { http: 200, body: { acknowledged: true } };
}

module.exports = { request, read, claim, answer, EXPIRY_SECONDS, POLL_HOLD_MS, POLL_STEP_MS };
