'use strict';

/**
 * Whether a profile device (ADR 0029) is connected.
 *
 * A phone or laptop on the stock WireGuard app never heartbeats. Its organisation's
 * profile gateway reads the device's last handshake from its own wireguard-go state and
 * reports it in peer_paths on the gateway's authenticated heartbeat. Only the gateway that
 * serves the device is believed (ProfileGatewayService: the one assigned to it, else the
 * organisation's default): another gateway, even of the same organisation, does not hold
 * the device as a peer and has nothing true to say about it, and a quarantined gateway
 * carries no traffic, so its word counts for nothing.
 */

const { getPgPool } = require('../db/index');
const ProfileGatewayService = require('./ProfileGatewayService');

// WireGuard rekeys every two minutes while traffic flows and the profile keepalive is
// 25 s, so a connected device handshakes at least every 2 min; one more minute of slack.
const DEFAULT_WINDOW_SECONDS = 180;
const MAX_REPORTED = 4096;

/** The connected window, in seconds. The environment override exists for scenario tests. */
function windowSeconds() {
  const configured = Number(process.env.SOVEREIGN_PROFILE_HANDSHAKE_WINDOW_SECONDS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_WINDOW_SECONDS;
}

/** 'connected' | 'not_connected' | 'not_measured' for a profile device's last handshake. */
function status(lastHandshakeAt, nowMs = Date.now()) {
  if (!lastHandshakeAt) return 'not_measured';
  const at = new Date(lastHandshakeAt).getTime();
  if (!Number.isFinite(at)) return 'not_measured';
  return nowMs - at <= windowSeconds() * 1000 ? 'connected' : 'not_connected';
}

/**
 * Store the handshakes a gateway reported for the profile devices it serves. Entries for
 * any other node are ignored, and so is every device the reporter does not serve as its
 * profile gateway. A handshake never moves backwards and never lands in the future.
 */
async function record(gatewayNodeId, peerPaths, client = null) {
  if (!Array.isArray(peerPaths) || peerPaths.length === 0 || peerPaths.length > MAX_REPORTED) return 0;
  // One row per device: an UPDATE joined to duplicates would apply an arbitrary one.
  const latest = new Map();
  for (const p of peerPaths) {
    if (
      p &&
      typeof p.peer_id === 'string' &&
      Number.isSafeInteger(p.last_handshake_unix) &&
      p.last_handshake_unix > 0
    ) {
      latest.set(p.peer_id, Math.max(latest.get(p.peer_id) || 0, p.last_handshake_unix));
    }
  }
  if (latest.size === 0) return 0;
  const ids = [...latest.keys()];
  const stamps = [...latest.values()];
  const result = await (client || getPgPool()).query(
    `UPDATE nodes d SET last_handshake_at = v.at
       FROM (SELECT r.id, LEAST(to_timestamp(r.unix), now()) AS at
               FROM unnest($2::text[], $3::bigint[]) AS r(id, unix)) v,
            nodes g
      WHERE g.id = $1
        AND g.device_kind = 'mesh'
        AND g.profile_gateway_endpoint IS NOT NULL
        AND g.is_quarantined IS NOT TRUE
        AND d.id = v.id
        AND d.device_kind = 'profile'
        AND COALESCE(d.organization_id, 'org-default') = COALESCE(g.organization_id, 'org-default')
        AND g.id = ${ProfileGatewayService.servingGatewaySql('d')}
        AND (d.last_handshake_at IS NULL OR d.last_handshake_at < v.at)`,
    [gatewayNodeId, ids, stamps]
  );
  return result.rowCount;
}

module.exports = { status, record, windowSeconds, DEFAULT_WINDOW_SECONDS };
