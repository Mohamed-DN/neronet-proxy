/**
 * Exit nodes for profile devices (ADR 0032, phase 1).
 *
 * A profile device with an exit sends all its traffic through the gateway, which lets its
 * internet-bound packets out either from its own host (the gateway is the exit) or to one
 * mesh node started as an exit. This module answers three questions for the routes and
 * the netmap builder:
 *
 *   - which nodes of an organisation may be chosen as an exit (exitCandidates);
 *   - who may choose (mayChooseExit, the IAM hook);
 *   - for one organisation, where each device's traffic leaves and which mesh exit the
 *     gateway routes 0.0.0.0/0 to (plan).
 *
 * A node is an exit only with its operator's consent: it registers as EXIT_BRIDGE or
 * HYBRID when started with -enable-exit, and the node itself refuses to dial for anyone
 * without that flag, whatever the netmap says.
 */
const { getPgPool } = require('../db/index');
const AclEngine = require('./AclEngine');
const { normalisePublicKeyHex } = require('../utils/crypto');

const EXIT_ROLES = ['EXIT_BRIDGE', 'HYBRID'];
const DEFAULT_ORG = 'org-default';
const EXIT_DNS = '100.100.100.100';
const FULL_TUNNEL = ['0.0.0.0/0', '::/0'];
const OVERLAY_FIRST = AclEngine.parseCidr('100.64.0.0/10').first;
const OVERLAY_LAST = AclEngine.parseCidr('100.64.0.0/10').last;

const orgKey = (org) => org || DEFAULT_ORG;

/** Exits an organisation's devices may use: its mesh nodes started as exits. */
async function exitCandidates(organizationId, client = getPgPool()) {
  const res = await client.query(
    `SELECT id, name, is_healthy, profile_gateway_endpoint IS NOT NULL AS is_gateway
       FROM nodes
      WHERE COALESCE(organization_id, '${DEFAULT_ORG}') = $1 AND device_kind = 'mesh'
        AND role = ANY($2::text[]) AND is_quarantined = FALSE
      ORDER BY (profile_gateway_endpoint IS NULL), name, id`,
    [orgKey(organizationId), EXIT_ROLES]
  );
  return res.rows.map((r) => ({
    node_id: r.id,
    name: r.name,
    kind: r.is_gateway ? 'gateway' : 'node',
    online: Boolean(r.is_healthy)
  }));
}

/**
 * The IAM hook: may this user choose the exit of a device? Administrators always; the
 * device's owner when the organisation allows self-service. ADR 0030's
 * can(actor, 'devices.exit.set', device) replaces this function when IAM lands; every
 * caller goes through here so there is one place to change.
 */
async function mayChooseExit(user, organizationId, { ownerId = null } = {}, client = getPgPool()) {
  if (user && (user.role === 'admin' || user.role === 'super-admin')) return true;
  if (ownerId !== null && ownerId !== user.id) return false;
  const res = await client.query('SELECT exit_self_service FROM organizations WHERE id = $1', [orgKey(organizationId)]);
  return Boolean(res.rows[0] && res.rows[0].exit_self_service);
}

function isAdmin(user) {
  return Boolean(user) && (user.role === 'admin' || user.role === 'super-admin');
}

async function selfService(organizationId, client = getPgPool()) {
  const res = await client.query('SELECT exit_self_service FROM organizations WHERE id = $1', [orgKey(organizationId)]);
  return Boolean(res.rows[0] && res.rows[0].exit_self_service);
}

function normaliseDestination(text) {
  const t = String(text || '').trim();
  if (!t || t === 'any' || t === '*') return '0.0.0.0/0';
  return t.includes('/') ? t : `${t}/32`;
}

/**
 * A device's internet rules: the organisation's enabled rules, in priority order, whose
 * source covers the device and whose destination reaches outside the overlay. A rule
 * that names only overlay addresses is mesh policy, compiled per peer as before.
 */
function internetRulesFrom(rules, deviceVip) {
  const out = [];
  for (const rule of rules) {
    if (!AclEngine.cidrContains(rule.source_cidr, deviceVip)) continue;
    const range = AclEngine.parseCidr(rule.destination_cidr);
    if (!range) continue;
    if (range.first >= OVERLAY_FIRST && range.last <= OVERLAY_LAST) continue;
    out.push({
      cidr: normaliseDestination(rule.destination_cidr),
      protocol: String(rule.protocol || 'ALL').toUpperCase(),
      port_start: Number(rule.port_start) || 0,
      port_end: rule.port_end === null || rule.port_end === undefined ? 65535 : Number(rule.port_end),
      action: String(rule.action || 'DROP').toUpperCase() === 'ACCEPT' ? 'ACCEPT' : 'DROP'
    });
  }
  return out;
}

/**
 * Where each device of an organisation leaves.
 *
 * Returns { gatewayId, meshExitId, devices: Map(deviceId -> assignment) }. meshExitId is
 * the one mesh exit the gateway routes 0.0.0.0/0 and ::/0 to: the lowest id among usable
 * mesh exits some device chose. WireGuard routes by destination only, so a gateway holds
 * one default route; a device that chose another mesh exit gets an exit the gateway cannot
 * reach, and the gateway drops its internet traffic (phase 1 limit, ADR 0032).
 *
 * Only devices that can be served (key, 32-byte PSK, not revoked, not quarantined) are
 * listed; the caller passes the revoked keys it already holds.
 */
async function plan(organizationId, revoked = new Set(), client = getPgPool()) {
  const org = orgKey(organizationId);
  const res = await client.query(
    `SELECT d.id, d.overlay_ipv4, d.overlay_ipv6, d.public_key, d.preshared_key, d.exit_allow_lan,
            e.id AS exit_id, e.role AS exit_role, e.is_healthy AS exit_healthy,
            e.is_quarantined AS exit_quarantined, e.device_kind AS exit_kind,
            e.profile_gateway_endpoint IS NOT NULL AS exit_is_gateway
       FROM nodes d
       JOIN nodes e ON e.id = d.exit_node_id
      WHERE d.device_kind = 'profile' AND d.is_quarantined = FALSE
        AND COALESCE(d.organization_id, '${DEFAULT_ORG}') = $1
        AND COALESCE(e.organization_id, '${DEFAULT_ORG}') = $1
      ORDER BY d.id`,
    [org]
  );
  const gw = await client.query(
    `SELECT id FROM nodes WHERE COALESCE(organization_id, '${DEFAULT_ORG}') = $1
        AND profile_gateway_endpoint IS NOT NULL AND device_kind = 'mesh'`,
    [org]
  );
  const gatewayId = gw.rows[0] ? gw.rows[0].id : null;
  const rules = res.rows.length > 0 ? await AclEngine.listRules(org) : [];

  const devices = new Map();
  let meshExitId = null;
  for (const row of res.rows) {
    const key = normalisePublicKeyHex(row.public_key);
    const psk = Buffer.from(String(row.preshared_key || ''), 'base64');
    if (!key || revoked.has(key.toLowerCase()) || psk.length !== 32) continue;
    const ips = [];
    if (row.overlay_ipv4) ips.push(`${row.overlay_ipv4}/32`);
    if (row.overlay_ipv6) ips.push(`${row.overlay_ipv6}/128`);
    const isGatewayExit = row.exit_id === gatewayId;
    const usableMesh =
      !isGatewayExit &&
      row.exit_kind === 'mesh' &&
      EXIT_ROLES.includes(row.exit_role) &&
      row.exit_healthy &&
      !row.exit_quarantined;
    if (usableMesh && (meshExitId === null || String(row.exit_id) < String(meshExitId))) meshExitId = row.exit_id;
    devices.set(row.id, {
      device_id: row.id,
      exit_node_id: row.exit_id,
      via: isGatewayExit ? 'self' : 'mesh',
      allow_lan: Boolean(row.exit_allow_lan),
      ips,
      internet_rules: internetRulesFrom(rules, row.overlay_ipv4)
    });
  }
  return { gatewayId, meshExitId, devices };
}

/** The `exit` object of a device entry in the gateway's netmap. */
function exitEntry(assignment) {
  const entry = { via: assignment.via, node_id: assignment.exit_node_id };
  if (assignment.allow_lan) entry.allow_lan = true;
  if (assignment.internet_rules.length > 0) entry.internet_rules = assignment.internet_rules;
  return entry;
}

/** The `exit_clients` of the mesh exit's netmap: devices that leave through it. */
function exitClientsOf(nodeId, exitPlan) {
  if (!exitPlan || exitPlan.meshExitId !== nodeId) return [];
  const out = [];
  for (const a of exitPlan.devices.values()) {
    if (a.via !== 'mesh' || a.exit_node_id !== nodeId) continue;
    const c = { node_id: a.device_id, allowed_ips: a.ips };
    if (a.allow_lan) c.allow_lan = true;
    if (a.internet_rules.length > 0) c.internet_rules = a.internet_rules;
    out.push(c);
  }
  return out;
}

module.exports = {
  EXIT_ROLES,
  EXIT_DNS,
  FULL_TUNNEL,
  exitCandidates,
  mayChooseExit,
  isAdmin,
  selfService,
  internetRulesFrom,
  plan,
  exitEntry,
  exitClientsOf
};
