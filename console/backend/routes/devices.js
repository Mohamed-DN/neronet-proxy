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

async function gatewayOf(organizationId, client = getPgPool()) {
  const res = await client.query(
    `SELECT id, public_key, profile_gateway_endpoint FROM nodes
      WHERE COALESCE(organization_id, 'org-default') = $1 AND profile_gateway_endpoint IS NOT NULL
        AND device_kind = 'mesh'`,
    [organizationId]
  );
  return res.rows[0] || null;
}

// Name the node that serves profile devices for the caller's organisation.
router.put('/gateway', requireAdmin, async (req, res, next) => {
  try {
    const { node_id, endpoint } = req.body || {};
    if (!validEndpoint(endpoint)) return res.status(400).json({ error: 'endpoint must be host:port' });
    const org = orgOf(req);
    const pool = getPgPool();
    const node = (
      await pool.query(
        `SELECT id, public_key FROM nodes WHERE id = $1 AND COALESCE(organization_id, 'org-default') = $2
            AND device_kind = 'mesh'`,
        [node_id, org]
      )
    ).rows[0];
    if (!node) return res.status(404).json({ error: `no node ${node_id}` });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE nodes SET profile_gateway_endpoint = NULL
          WHERE COALESCE(organization_id, 'org-default') = $1 AND profile_gateway_endpoint IS NOT NULL`,
        [org]
      );
      await client.query('UPDATE nodes SET profile_gateway_endpoint = $1 WHERE id = $2', [endpoint, node.id]);
      await AclEngine.bumpNetmap(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await logAuditEvent({
      eventType: 'PROFILE_GATEWAY_SET',
      organizationId: org,
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: node.id,
      targetType: 'node',
      message: `Node ${node.id} serves profile devices at ${endpoint}`,
      ipAddress: req.ip,
      metadata: { after: { node_id: node.id, endpoint } }
    });
    return res.status(200).json({ gateway: { node_id: node.id, public_key: wireguardKey(node.public_key), endpoint } });
  } catch (err) {
    next(err);
  }
});

// ADR 0032: the exits this organisation's devices may use, and whether the caller may
// choose one. The /me page shows the full-tunnel option from this answer.
router.get('/exits', async (req, res, next) => {
  try {
    const org = orgOf(req);
    const [exits, selfService] = await Promise.all([
      ExitService.exitCandidates(org),
      ExitService.selfService(org)
    ]);
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
    const { name, public_key, preshared_key, exit_node_id } = req.body || {};
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label || label.length > 64) return res.status(400).json({ error: 'name must be 1 to 64 characters' });
    if (!isKey(public_key)) return res.status(400).json({ error: 'public_key must be a 32-byte base64 key' });
    if (!isKey(preshared_key)) return res.status(400).json({ error: 'preshared_key must be a 32-byte base64 key' });

    const gateway = await gatewayOf(orgOf(req));
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
                            ip_class, is_healthy, is_quarantined, organization_id, device_kind, exit_node_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'CLIENT_ORIGIN', 'UNKNOWN', TRUE, FALSE, $8, 'profile', $9)`,
        [
          id,
          actor.id,
          label,
          public_key,
          preshared_key,
          vips.overlayIpv4,
          vips.overlayIpv6,
          organizationId,
          exit ? exit.node_id : null
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
      console_url: `https://${req.get('host')}/me`
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
