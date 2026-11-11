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

// Register a profile device from its public key.
router.post('/profile', async (req, res, next) => {
  try {
    const { name, public_key, preshared_key } = req.body || {};
    const label = typeof name === 'string' ? name.trim() : '';
    if (!label || label.length > 64) return res.status(400).json({ error: 'name must be 1 to 64 characters' });
    if (!isKey(public_key)) return res.status(400).json({ error: 'public_key must be a 32-byte base64 key' });
    if (!isKey(preshared_key)) return res.status(400).json({ error: 'preshared_key must be a 32-byte base64 key' });

    const gateway = await gatewayOf(orgOf(req));
    if (!gateway) {
      return res.status(409).json({
        error: 'no_profile_gateway',
        message: 'This organisation has no gateway for profile devices yet; an administrator must name one.'
      });
    }

    const taken = await getPgPool().query('SELECT 1 FROM nodes WHERE public_key = ANY($1::text[])', [
      publicKeyForms(public_key)
    ]);
    if (taken.rows.length > 0) return res.status(409).json({ error: 'public_key is already in use' });

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
                            ip_class, is_healthy, is_quarantined, organization_id, device_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'CLIENT_ORIGIN', 'UNKNOWN', TRUE, FALSE, $8, 'profile')`,
        [id, actor.id, label, public_key, preshared_key, vips.overlayIpv4, vips.overlayIpv6, organizationId]
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
      metadata: { after: { id, name: label, overlay_ipv4: vips.overlayIpv4, gateway: gateway.id } }
    });

    return res.status(201).json({
      device_id: id,
      name: label,
      overlay_ipv4: vips.overlayIpv4,
      overlay_ipv6: vips.overlayIpv6,
      gateway: { public_key: wireguardKey(gateway.public_key), endpoint: gateway.profile_gateway_endpoint },
      allowed_ips: OVERLAY,
      dns: [],
      console_url: `https://${req.get('host')}/me`
    });
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ error: 'public_key is already in use' });
    next(err);
  }
});

module.exports = router;
