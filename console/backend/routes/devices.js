/**
 * Profile devices (ADR 0029, phase A).
 *
 * A device that runs a standard WireGuard app joins through its organisation's gateway
 * with a static profile. The caller -- the browser, or one of our apps -- generates the
 * key pair; this API receives the public key and the PSK the gateway must know, and
 * answers with everything else the profile needs. It never sees or returns a private key.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const { resolveUserOrg } = require('../middleware/rbac');
const { getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');
const { allocateNextVip, normalisePublicKeyHex, publicKeyForms } = require('../utils/crypto');
const EnrollmentService = require('../services/EnrollmentService');
const AclEngine = require('../services/AclEngine');
const ExitService = require('../services/ExitService');
const ProfileGatewayService = require('../services/ProfileGatewayService');

router.use(authenticateToken);
router.use(resolveUserOrg);

const requireAdmin = requireRole('super-admin', 'admin');
const orgOf = (req) => req.user.organization_id || 'org-default';
const OVERLAY = ['100.64.0.0/10'];
const ENDPOINT = /^[A-Za-z0-9.[\]:-]{1,255}:([0-9]{1,5})$/;

function isKey(value) {
  if (typeof value !== 'string') return false;
  const raw = Buffer.from(value, 'base64');
  return raw.length === 32 && raw.toString('base64') === value;
}

// A node enrolled over the control plane stores its key in hex; a WireGuard
// configuration takes base64. The profile is built from this answer, so it carries the
// form every WireGuard app reads.
function wireguardKey(stored) {
  const hex = normalisePublicKeyHex(stored);
  return hex ? Buffer.from(hex, 'hex').toString('base64') : null;
}

function validEndpoint(value) {
  const m = typeof value === 'string' ? ENDPOINT.exec(value) : null;
  return Boolean(m) && Number(m[1]) >= 1 && Number(m[1]) <= 65535;
}

// The strict-network tunnel (docker-compose.wss.yml, ADR 0032 draft method wg-wss). Its
// path prefix is a per-installation secret: anyone who knows it can open the WebSocket,
// though only to the gateway's WireGuard port, where the device key still decides. It is
// given to a signed-in user together with the profile they just made, never in a
// public answer. A malformed or missing value turns the whole field off.
const WSS_PATH_PREFIX = /^[A-Za-z0-9_-]{16,128}$/;
const WSS_URL = /^wss:\/\/[A-Za-z0-9.[\]:-]{1,255}$/;
const HOST_HEADER = /^[A-Za-z0-9.[\]:-]{1,255}$/;

function strictNetworkOf(req) {
  const pathPrefix = process.env.NERONET_WSS_PATH_PREFIX || '';
  if (!WSS_PATH_PREFIX.test(pathPrefix)) return null;
  const remote = process.env.NERONET_WSS_UPSTREAM || 'gateway:51820';
  if (!validEndpoint(remote)) return null;
  let url = (process.env.NERONET_WSS_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!url) {
    const host = req.get('host');
    if (!host || !HOST_HEADER.test(host)) return null;
    url = `wss://${host}`;
  }
  if (!WSS_URL.test(url)) return null;
  return {
    url,
    path_prefix: pathPrefix,
    remote,
    // What the alternative profile says instead of the gateway's address: the local end
    // of the client, a smaller MTU for the WebSocket and TLS overhead, and a keepalive
    // under the idle timeouts of common reverse proxies (60 s in nginx).
    local_endpoint: '127.0.0.1:51820',
    mtu: 1380,
    persistent_keepalive: 20
  };
}

// The answer a gateway gets in every response: what a profile needs and what the
// Settings table shows. Never a private key; the public key is what profiles carry.
function gatewayView(row) {
  return {
    node_id: row.id,
    name: row.name || row.id,
    public_key: wireguardKey(row.public_key),
    endpoint: row.profile_gateway_endpoint,
    is_default: Boolean(row.is_default_profile_gateway)
  };
}

// Run `work` in one transaction that also moves the netmap version, so every gateway and
// node learns the change on its next fetch.
async function withNetmapTransaction(work) {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await AclEngine.bumpNetmap(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Make `nodeId` the organisation's one default gateway, inside the caller's transaction.
async function markDefault(client, org, nodeId) {
  await client.query(
    `UPDATE nodes SET is_default_profile_gateway = FALSE
      WHERE COALESCE(organization_id, 'org-default') = $1 AND is_default_profile_gateway AND id <> $2`,
    [org, nodeId]
  );
  await client.query('UPDATE nodes SET is_default_profile_gateway = TRUE WHERE id = $1', [nodeId]);
}

// The gateways that serve this organisation's profile devices, the default first, with
// how many devices each serves and when it was last heard from.
router.get('/gateways', async (req, res, next) => {
  try {
    const org = orgOf(req);
    const [rows, served] = await Promise.all([
      ProfileGatewayService.gateways(org),
      ProfileGatewayService.devicesServed(org)
    ]);
    const gateways = rows.map((row, i) => ({
      // The first row is the default, flagged or not (ProfileGatewayService's order).
      ...gatewayView({ ...row, is_default_profile_gateway: i === 0 }),
      devices: served.get(row.id) || 0,
      overlay_ipv4: row.overlay_ipv4 || null,
      online: Boolean(row.is_healthy) && !row.is_quarantined,
      last_seen_at: row.last_heartbeat ? new Date(row.last_heartbeat).toISOString() : null
    }));
    return res.json({ gateways });
  } catch (err) {
    next(err);
  }
});

// Make a node of the caller's organisation a gateway for profile devices, or change its
// endpoint. Other gateways stay. It becomes the default when `default` is true or when the
// organisation has no default yet; the default is handed away only by making another
// gateway the default.
router.put('/gateway', requireAdmin, async (req, res, next) => {
  try {
    const { node_id, endpoint } = req.body || {};
    const wantDefault = req.body ? req.body.default : undefined;
    if (!validEndpoint(endpoint)) return res.status(400).json({ error: 'endpoint must be host:port' });
    if (wantDefault !== undefined && typeof wantDefault !== 'boolean') {
      return res.status(400).json({ error: 'default must be a boolean' });
    }
    const org = orgOf(req);
    const node = (
      await getPgPool().query(
        `SELECT id, name, public_key FROM nodes WHERE id = $1 AND COALESCE(organization_id, 'org-default') = $2
            AND device_kind = 'mesh'`,
        [node_id, org]
      )
    ).rows[0];
    if (!node) return res.status(404).json({ error: `no node ${node_id}` });

    const isDefault = await withNetmapTransaction(async (client) => {
      const before = await ProfileGatewayService.gateways(org, client);
      const already = before.some((g) => g.id === node.id && g.is_default_profile_gateway);
      const otherDefault = before.some((g) => g.id !== node.id && g.is_default_profile_gateway);
      await client.query('UPDATE nodes SET profile_gateway_endpoint = $1 WHERE id = $2', [endpoint, node.id]);
      if (already) return true;
      if (wantDefault === true || !otherDefault) {
        await markDefault(client, org, node.id);
        return true;
      }
      return false;
    });

    await logAuditEvent({
      eventType: 'PROFILE_GATEWAY_SET',
      organizationId: org,
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: node.id,
      targetType: 'node',
      message: `Node ${node.id} serves profile devices at ${endpoint}${isDefault ? ' (default)' : ''}`,
      ipAddress: req.ip,
      metadata: { after: { node_id: node.id, endpoint, is_default: isDefault } }
    });
    return res.status(200).json({
      gateway: gatewayView({ ...node, profile_gateway_endpoint: endpoint, is_default_profile_gateway: isDefault })
    });
  } catch (err) {
    next(err);
  }
});

// The gateway new devices join unless an administrator chooses another.
router.put('/gateways/:id/default', requireAdmin, async (req, res, next) => {
  try {
    const org = orgOf(req);
    const gateway = await ProfileGatewayService.gatewayById(org, req.params.id);
    if (!gateway) return res.status(404).json({ error: 'no_such_gateway', code: 'no_such_gateway' });
    await withNetmapTransaction((client) => markDefault(client, org, gateway.id));
    await logAuditEvent({
      eventType: 'PROFILE_GATEWAY_DEFAULT_SET',
      organizationId: org,
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: gateway.id,
      targetType: 'node',
      message: `New profile devices join through gateway ${gateway.id}`,
      ipAddress: req.ip,
      metadata: { after: { default_gateway: gateway.id } }
    });
    return res.json({ gateway: gatewayView({ ...gateway, is_default_profile_gateway: true }) });
  } catch (err) {
    next(err);
  }
});

// Stop a node serving profile devices. Refused while it still serves any (each would lose
// its tunnel), and for the default while another gateway exists (new devices need one).
router.delete('/gateways/:id', requireAdmin, async (req, res, next) => {
  try {
    const org = orgOf(req);
    const all = await ProfileGatewayService.gateways(org);
    const gateway = all.find((g) => g.id === req.params.id);
    if (!gateway) return res.status(404).json({ error: 'no_such_gateway', code: 'no_such_gateway' });
    const devices = (await ProfileGatewayService.devicesServed(org)).get(gateway.id) || 0;
    if (devices > 0) {
      return res.status(409).json({
        code: 'profile_gateway_serves_devices',
        devices,
        error: `This gateway still serves ${devices} device(s). Move them to another gateway first.`
      });
    }
    if (all[0].id === gateway.id && all.length > 1) {
      return res.status(409).json({
        code: 'profile_gateway_is_default',
        error: 'New devices join through this gateway. Make another gateway the default first.'
      });
    }
    await withNetmapTransaction((client) =>
      client.query(
        'UPDATE nodes SET profile_gateway_endpoint = NULL, is_default_profile_gateway = FALSE WHERE id = $1',
        [gateway.id]
      )
    );
    await logAuditEvent({
      eventType: 'PROFILE_GATEWAY_REMOVED',
      organizationId: org,
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: gateway.id,
      targetType: 'node',
      message: `Node ${gateway.id} no longer serves profile devices`,
      ipAddress: req.ip,
      metadata: { before: { node_id: gateway.id, endpoint: gateway.profile_gateway_endpoint } }
    });
    return res.json({ removed: gateway.id });
  } catch (err) {
    next(err);
  }
});

// Move a profile device to another gateway of its organisation. A stock WireGuard profile
// names one gateway (one [Peer], one Endpoint), so the person must import a new profile:
// the answer says so and carries what the new [Peer] section needs.
router.put('/:id/gateway', async (req, res, next) => {
  try {
    const org = orgOf(req);
    const { gateway_node_id } = req.body || {};
    if (typeof gateway_node_id !== 'string' || !gateway_node_id) {
      return res.status(400).json({ error: 'gateway_node_id must be a node id' });
    }
    const device = (
      await getPgPool().query(
        `SELECT id, gateway_node_id FROM nodes
          WHERE id = $1 AND device_kind = 'profile' AND COALESCE(organization_id, 'org-default') = $2`,
        [req.params.id, org]
      )
    ).rows[0];
    if (!device) return res.status(404).json({ error: `no device ${req.params.id}` });
    if (!(await ProfileGatewayService.mayUseGateway(req.user, org, gateway_node_id))) {
      return res.status(403).json({ error: 'gateway_not_permitted', code: 'gateway_not_permitted' });
    }
    const gateway = await ProfileGatewayService.gatewayById(org, gateway_node_id);
    if (!gateway) return res.status(404).json({ error: 'no_such_gateway', code: 'no_such_gateway' });
    const before = await ProfileGatewayService.servingGateway(org, device.gateway_node_id);
    const changed = !before || before.id !== gateway.id;

    await withNetmapTransaction((client) =>
      client.query('UPDATE nodes SET gateway_node_id = $1 WHERE id = $2', [gateway.id, device.id])
    );
    await logAuditEvent({
      eventType: 'DEVICE_GATEWAY_SET',
      organizationId: org,
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: device.id,
      targetType: 'node',
      message: changed
        ? `Device ${device.id} moved from gateway ${before ? before.id : 'none'} to ${gateway.id}; its profile must be imported again`
        : `Device ${device.id} stays on gateway ${gateway.id}`,
      ipAddress: req.ip,
      metadata: { before: { gateway_node_id: before ? before.id : null }, after: { gateway_node_id: gateway.id } }
    });
    const view = gatewayView(gateway);
    return res.json({
      device_id: device.id,
      gateway: { node_id: view.node_id, name: view.name, public_key: view.public_key, endpoint: view.endpoint },
      reimport_required: changed
    });
  } catch (err) {
    next(err);
  }
});

// ADR 0032: the exits this organisation's devices may use, and whether the caller may
// choose one. The /me page shows the full-tunnel option from this answer.
router.get('/exits', async (req, res, next) => {
  try {
    const org = orgOf(req);
    const [exits, selfService] = await Promise.all([ExitService.exitCandidates(org), ExitService.selfService(org)]);
    const canChoose = ExitService.isAdmin(req.user) || selfService;
    return res.json({ can_choose: canChoose, self_service: selfService, exits });
  } catch (err) {
    next(err);
  }
});

// Whether a device's owner may choose its exit, or only an administrator.
router.put('/exit-policy', requireAdmin, async (req, res, next) => {
  try {
    const { self_service } = req.body || {};
    if (typeof self_service !== 'boolean') return res.status(400).json({ error: 'self_service must be a boolean' });
    const org = orgOf(req);
    await getPgPool().query('UPDATE organizations SET exit_self_service = $1 WHERE id = $2', [self_service, org]);
    await logAuditEvent({
      eventType: 'EXIT_POLICY_SET',
      organizationId: org,
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: org,
      targetType: 'organization',
      message: self_service
        ? 'Device owners may now choose an exit for their devices'
        : 'Only administrators may choose an exit for a device',
      ipAddress: req.ip,
      metadata: { after: { exit_self_service: self_service } }
    });
    return res.json({ self_service });
  } catch (err) {
    next(err);
  }
});

// The exit node a request names, if it is one this organisation's devices may use.
async function validExit(org, exitNodeId) {
  if (typeof exitNodeId !== 'string' || !exitNodeId) return null;
  return (await ExitService.exitCandidates(org)).find((e) => e.node_id === exitNodeId) || null;
}

// Choose, change or remove a device's exit. Null removes it.
router.put('/:id/exit', async (req, res, next) => {
  try {
    const org = orgOf(req);
    const { exit_node_id, allow_lan } = req.body || {};
    if (exit_node_id !== null && typeof exit_node_id !== 'string') {
      return res.status(400).json({ error: 'exit_node_id must be a node id or null' });
    }
    if (allow_lan !== undefined && typeof allow_lan !== 'boolean') {
      return res.status(400).json({ error: 'allow_lan must be a boolean' });
    }
    const pool = getPgPool();
    const device = (
      await pool.query(
        `SELECT id, user_id, exit_allow_lan FROM nodes
          WHERE id = $1 AND device_kind = 'profile' AND COALESCE(organization_id, 'org-default') = $2`,
        [req.params.id, org]
      )
    ).rows[0];
    if (!device) return res.status(404).json({ error: `no device ${req.params.id}` });
    if (!(await ExitService.mayChooseExit(req.user, org, { ownerId: device.user_id }))) {
      return res.status(403).json({ error: 'exit_not_permitted', code: 'exit_not_permitted' });
    }
    // Reaching the exit's private networks is an administrator's decision only.
    if (allow_lan === true && !ExitService.isAdmin(req.user)) {
      return res.status(403).json({ error: 'exit_lan_admin_only', code: 'exit_lan_admin_only' });
    }
    let exit = null;
    if (exit_node_id !== null) {
      exit = await validExit(org, exit_node_id);
      if (!exit) return res.status(404).json({ error: 'no_such_exit', code: 'no_such_exit' });
    }
    const allowLan = exit === null ? false : allow_lan === undefined ? device.exit_allow_lan : allow_lan;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE nodes SET exit_node_id = $1, exit_allow_lan = $2 WHERE id = $3', [
        exit ? exit.node_id : null,
        allowLan,
        device.id
      ]);
      await AclEngine.bumpNetmap(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await logAuditEvent({
      eventType: 'DEVICE_EXIT_SET',
      organizationId: org,
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: device.id,
      targetType: 'node',
      message: exit
        ? `Device ${device.id} sends all its traffic through ${exit.kind} ${exit.node_id}${allowLan ? ', with access to its LAN' : ''}`
        : `Device ${device.id} no longer uses an exit`,
      ipAddress: req.ip,
      metadata: { after: { exit_node_id: exit ? exit.node_id : null, exit_allow_lan: allowLan } }
    });
    return res.json({ device_id: device.id, exit, allow_lan: allowLan });
  } catch (err) {
    next(err);
  }
});

// Register a profile device from its public key.
router.post('/profile', async (req, res, next) => {
  try {
    const { name, public_key, preshared_key, exit_node_id, gateway_node_id } = req.body || {};
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label || label.length > 64) return res.status(400).json({ error: 'name must be 1 to 64 characters' });
    if (!isKey(public_key)) return res.status(400).json({ error: 'public_key must be a 32-byte base64 key' });
    if (!isKey(preshared_key)) return res.status(400).json({ error: 'preshared_key must be a 32-byte base64 key' });

    // The default gateway, unless an administrator chose another of the organisation's.
    let gateway;
    if (gateway_node_id !== undefined && gateway_node_id !== null) {
      if (!(await ProfileGatewayService.mayUseGateway(req.user, orgOf(req), gateway_node_id))) {
        return res.status(403).json({
          error: 'gateway_not_permitted',
          code: 'gateway_not_permitted',
          message: 'Only an administrator can choose the gateway of a device.'
        });
      }
      gateway = await ProfileGatewayService.gatewayById(orgOf(req), gateway_node_id);
      if (!gateway) return res.status(404).json({ error: 'no_such_gateway', code: 'no_such_gateway' });
    } else {
      gateway = await ProfileGatewayService.defaultGateway(orgOf(req));
    }
    if (!gateway) {
      return res.status(409).json({
        error: 'no_profile_gateway',
        code: 'no_profile_gateway',
        message: 'This organisation has no gateway for profile devices yet; an administrator must name one.'
      });
    }

    // A full-tunnel profile (ADR 0032): every packet goes to the gateway and leaves through
    // the chosen exit. Without the right to choose one the request is refused rather than
    // answered with a profile whose internet traffic would all be dropped.
    let exit = null;
    if (exit_node_id !== undefined && exit_node_id !== null) {
      if (!(await ExitService.mayChooseExit(req.user, orgOf(req)))) {
        return res.status(403).json({
          error: 'exit_not_permitted',
          code: 'exit_not_permitted',
          message: 'Only an administrator can send a device through an exit in this organisation.'
        });
      }
      exit = await validExit(orgOf(req), exit_node_id);
      if (!exit) return res.status(404).json({ error: 'no_such_exit', code: 'no_such_exit' });
    }

    const taken = await getPgPool().query('SELECT 1 FROM nodes WHERE public_key = ANY($1::text[])', [
      publicKeyForms(public_key)
    ]);
    if (taken.rows.length > 0)
      return res.status(409).json({ error: 'public_key is already in use', code: 'public_key_in_use' });

    const id = `dev-${crypto.randomBytes(6).toString('hex')}`;
    let organizationId;
    let vips;
    await EnrollmentService.transaction(async (client) => {
      const actor = await EnrollmentService.authorizeConsole(
        client,
        req.user,
        req.sessionAuthority.organizationIdAtIssue
      );
      organizationId = actor.organization_id;
      vips = await allocateNextVip(client);
      await client.query(
        `INSERT INTO nodes (id, user_id, name, public_key, preshared_key, overlay_ipv4, overlay_ipv6, role,
                            ip_class, is_healthy, is_quarantined, organization_id, device_kind, exit_node_id,
                            gateway_node_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'CLIENT_ORIGIN', 'UNKNOWN', TRUE, FALSE, $8, 'profile', $9, $10)`,
        [
          id,
          actor.id,
          label,
          public_key,
          preshared_key,
          vips.overlayIpv4,
          vips.overlayIpv6,
          organizationId,
          exit ? exit.node_id : null,
          gateway.id
        ]
      );
      await AclEngine.bumpNetmap(client);
    });

    await logAuditEvent({
      eventType: 'PROFILE_DEVICE_CREATED',
      organizationId,
      severity: 'info',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: id,
      targetType: 'node',
      message: `Profile device ${id} (${label}) joined through gateway ${gateway.id} at ${vips.overlayIpv4}`,
      ipAddress: req.ip,
      metadata: {
        after: {
          id,
          name: label,
          overlay_ipv4: vips.overlayIpv4,
          gateway: gateway.id,
          exit_node_id: exit ? exit.node_id : null
        }
      }
    });

    return res.status(201).json({
      device_id: id,
      name: label,
      overlay_ipv4: vips.overlayIpv4,
      overlay_ipv6: vips.overlayIpv6,
      gateway: { public_key: wireguardKey(gateway.public_key), endpoint: gateway.profile_gateway_endpoint },
      allowed_ips: exit ? ExitService.FULL_TUNNEL : OVERLAY,
      // The exit answers this address from its own resolver, so names resolve where the
      // traffic leaves and no query goes around the tunnel.
      dns: exit ? [ExitService.EXIT_DNS] : [],
      ...(exit ? { exit: { node_id: exit.node_id, name: exit.name, kind: exit.kind } } : {}),
      console_url: `https://${req.get('host')}/me`,
      strict_network: strictNetworkOf(req)
    });
  } catch (err) {
    if (err && err.code === '23505') {
      // Only the key is the person's to change; any other unique clash (an overlay address
      // taken in a race) is ours, so say so instead of blaming their key.
      if (String(err.constraint || '').includes('public_key')) {
        return res.status(409).json({ error: 'public_key is already in use', code: 'public_key_in_use' });
      }
      return res
        .status(503)
        .json({ error: 'try_again', code: 'try_again', message: 'The device could not be added; try again.' });
    }
    next(err);
  }
});

module.exports = router;
