'use strict';

/**
 * Profile gateways (ADR 0029, several per organisation since migration 051).
 *
 * A gateway is a mesh node with `profile_gateway_endpoint` set. An organisation may have
 * any number; one is its default. A profile device is served by the gateway it names in
 * `gateway_node_id` when that node is still a gateway of the device's organisation, and by
 * the default otherwise. "Served" means: only that gateway holds the device as a WireGuard
 * peer, every other node routes the device's addresses to it, the device's profile names
 * it, and only its handshake reports are stored. Every reader goes through this module so
 * the rule is written once (in SQL for the handshake update, in JS for the netmap).
 */

const { getPgPool } = require('../db/index');

const DEFAULT_ORG = 'org-default';
/** The IAM action ADR 0030's can(actor, 'gateway.use', gateway) checks once IAM lands. */
const GATEWAY_USE = 'gateway.use';

const orgKey = (org) => org || DEFAULT_ORG;

const IS_GATEWAY = `device_kind = 'mesh' AND profile_gateway_endpoint IS NOT NULL`;
// The flagged default first; with no flag (rows written by hand), the lowest id, so the
// answer is always the same one.
const DEFAULT_ORDER = 'is_default_profile_gateway DESC, id';

/**
 * The SQL expression for the id of the gateway that serves the device row `d`. Used where
 * the rule must hold inside one statement (ProfileHandshake.record).
 */
function servingGatewaySql(d = 'd') {
  const sameOrg = (a) =>
    `COALESCE(${a}.organization_id, '${DEFAULT_ORG}') = COALESCE(${d}.organization_id, '${DEFAULT_ORG}')`;
  return `COALESCE(
    (SELECT a.id FROM nodes a WHERE a.id = ${d}.gateway_node_id AND a.device_kind = 'mesh'
        AND a.profile_gateway_endpoint IS NOT NULL AND ${sameOrg('a')}),
    (SELECT f.id FROM nodes f WHERE f.device_kind = 'mesh' AND f.profile_gateway_endpoint IS NOT NULL AND ${sameOrg('f')}
      ORDER BY f.is_default_profile_gateway DESC, f.id LIMIT 1))`;
}

/** The organisation's gateways, the default first. */
async function gateways(organizationId, client = getPgPool()) {
  const res = await client.query(
    `SELECT id, name, public_key, overlay_ipv4, profile_gateway_endpoint, is_default_profile_gateway,
            is_healthy, is_quarantined, last_heartbeat
       FROM nodes
      WHERE COALESCE(organization_id, '${DEFAULT_ORG}') = $1 AND ${IS_GATEWAY}
      ORDER BY ${DEFAULT_ORDER}`,
    [orgKey(organizationId)]
  );
  return res.rows;
}

/**
 * Who serves whom in one organisation: `of(gatewayNodeId)` answers the serving gateway's id
 * for a device that names `gatewayNodeId` (null when the organisation has no gateway).
 */
async function resolver(organizationId, client = getPgPool()) {
  const rows = await gateways(organizationId, client);
  const ids = new Set(rows.map((r) => r.id));
  const defaultId = rows[0] ? rows[0].id : null;
  return {
    defaultId,
    ids,
    of: (gatewayNodeId) => (gatewayNodeId && ids.has(gatewayNodeId) ? gatewayNodeId : defaultId)
  };
}

async function defaultGateway(organizationId, client = getPgPool()) {
  return (await gateways(organizationId, client))[0] || null;
}

/** The gateway `nodeId` if it is one of this organisation's gateways, else null. */
async function gatewayById(organizationId, nodeId, client = getPgPool()) {
  if (typeof nodeId !== 'string' || !nodeId) return null;
  return (await gateways(organizationId, client)).find((g) => g.id === nodeId) || null;
}

/** The gateway that serves a device naming `gatewayNodeId`. */
async function servingGateway(organizationId, gatewayNodeId, client = getPgPool()) {
  const rows = await gateways(organizationId, client);
  return rows.find((g) => g.id === gatewayNodeId) || rows[0] || null;
}

/** How many profile devices each gateway of the organisation serves: Map(id -> count). */
async function devicesServed(organizationId, client = getPgPool()) {
  const res = await client.query(
    `SELECT ${servingGatewaySql('d')} AS gateway_id, COUNT(*)::int AS devices
       FROM nodes d
      WHERE d.device_kind = 'profile' AND COALESCE(d.organization_id, '${DEFAULT_ORG}') = $1
      GROUP BY 1`,
    [orgKey(organizationId)]
  );
  return new Map(res.rows.filter((r) => r.gateway_id).map((r) => [r.gateway_id, r.devices]));
}

function isAdmin(user) {
  return Boolean(user) && (user.role === 'admin' || user.role === 'super-admin');
}

/**
 * The IAM hook: may this user put a device on a gateway other than the default? Only an
 * administrator for now. ADR 0030's can(actor, GATEWAY_USE, gateway) replaces this
 * function; every caller goes through here so there is one place to change.
 */
async function mayUseGateway(user /* , organizationId, gatewayId */) {
  return isAdmin(user);
}

module.exports = {
  GATEWAY_USE,
  servingGatewaySql,
  gateways,
  resolver,
  defaultGateway,
  gatewayById,
  servingGateway,
  devicesServed,
  mayUseGateway
};
