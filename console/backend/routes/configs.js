const express = require('express');
const router = express.Router();
const { getPgPool } = require('../db/index');
const { authenticateToken } = require('../middleware/auth');
const { resolveUserOrg } = require('../middleware/rbac');
const { logAuditEvent } = require('../utils/audit');
const {
  generateCurve25519Keypair,
  buildWireGuardConfig,
  requireServerPublicKey,
  requireServerEndpoint,
  buildNoiseJsonProfile,
  generateQrCodeDataUrl,
  allocateNextVip
} = require('../utils/crypto');
const { broadcastNodeEvent } = require('../services/TopologySync');
const EnrollmentService = require('../services/EnrollmentService');
const { bumpNetmap } = require('../services/AclEngine');
const TransportPolicyService = require('../services/TransportPolicyService');
const NodeLocation = require('../services/NodeLocation');

// The error handler drops `code` on 5xx, and clients map these two to a message.
function sendHonestFailure(res, err) {
  if (
    err &&
    (err.code === 'server_key_missing' || err.code === 'server_endpoint_missing' || err.code === 'qr_generation_failed')
  ) {
    res.status(503).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

router.use(authenticateToken);
router.use(resolveUserOrg);

// 1. Generate Full Crypto & Config Bundle
router.post('/generate', async (req, res, next) => {
  try {
    // The same rules as POST /api/nodes, which this also creates: read-only roles
    // cannot, and the node joins the caller's organisation. It used to do neither.
    const { name, role, country_code, onion_routing_enabled, onion_hops, kill_switch_enabled } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Missing node name for config generation' });
    }

    // Check user node quota
    if (req.user.role !== 'super-admin') {
      // Node count is no longer capped per user. NeroNet has no paid tiers, and a
      // per-account limit was a commercial boundary rather than a technical one: the
      // overlay pool holds 4.19 million addresses and enrolment is rate limited, so
      // the infrastructure protections that matter are elsewhere.
    }

    // Refuse before anything is allocated or stored: no node is created for a profile
    // that cannot be honest.
    requireServerPublicKey();
    requireServerEndpoint();

    const kp = generateCurve25519Keypair();
    const VALID_ROLES = ['CLIENT_ORIGIN', 'EXIT_BRIDGE', 'HYBRID', 'RELAY'];
    const nodeRole = role && VALID_ROLES.includes(role) ? role : 'CLIENT_ORIGIN';
    // No default country (ADR 0042): a profile states one only when an administrator does.
    let nodeCountry = null;
    if (country_code !== undefined && country_code !== null && country_code !== '') {
      nodeCountry = NodeLocation.parseCountry(country_code);
      if (!nodeCountry) return res.status(400).json({ error: 'country_code must be a two-letter ISO 3166-1 code' });
    }
    const onionEnabled = Boolean(onion_routing_enabled || (onion_hops !== undefined && Number(onion_hops) > 0));
    const hops = onionEnabled ? (onion_hops !== undefined && Number(onion_hops) > 0 ? Number(onion_hops) : 3) : 0;
    const killSwitch = Boolean(kill_switch_enabled);

    let overlayIpv4, overlayIpv6, wgConf, jsonProfile, qrCodeDataUrl;

    await EnrollmentService.transaction(async (client, afterCommit) => {
      const actor = await EnrollmentService.authorizeConsole(
        client,
        req.user,
        req.sessionAuthority.organizationIdAtIssue
      );
      const organizationId = actor.organization_id;
      if (nodeCountry && !NodeLocation.canDeclare(actor)) {
        throw EnrollmentService.denied(403, 'Forbidden: only an organisation administrator can state a location');
      }
      const vips = await allocateNextVip(client);
      overlayIpv4 = vips.overlayIpv4;
      overlayIpv6 = vips.overlayIpv6;

      await client.query(
        `
      INSERT INTO nodes (
        id, user_id, name, public_key, preshared_key, overlay_ipv4, overlay_ipv6,
        role, ip_class, country_code, onion_routing_enabled, onion_hops, kill_switch_enabled,
        is_healthy, is_quarantined, latency_ms, organization_id, location_source
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, 'RESIDENTIAL', $9, $10, $11, $12,
        TRUE, FALSE, 0, $13, $14
      )
    `,
        [
          kp.nodeId,
          actor.id,
          name.trim(),
          kp.publicKeyBase64,
          kp.presharedKeyBase64,
          overlayIpv4,
          overlayIpv6,
          nodeRole,
          nodeCountry,
          onionEnabled,
          hops,
          killSwitch,
          organizationId,
          nodeCountry ? 'declared' : null
        ]
      );
      // Built before commit: if the QR cannot be rendered the node is rolled back
      // rather than left enrolled with a private key nobody received.
      wgConf = buildWireGuardConfig({
        deviceName: name ? name.trim() : 'Sovereign-Client',
        role: nodeRole,
        privateKeyBase64: kp.privateKeyBase64,
        overlayIpv4,
        overlayIpv6,
        presharedKeyBase64: kp.presharedKeyBase64,
        onionRoutingEnabled: onionEnabled,
        onionHops: hops
      });

      jsonProfile = buildNoiseJsonProfile({
        nodeId: kp.nodeId,
        privateKeyHex: kp.privateKeyHex,
        publicKeyHex: kp.publicKeyHex,
        overlayIpv4,
        overlayIpv6,
        presharedKeyHex: kp.presharedKeyHex,
        role: nodeRole,
        countryCode: nodeCountry,
        onionHops: hops,
        onionRoutingEnabled: onionEnabled,
        relays: await TransportPolicyService.enabledRelays(client)
      });

      qrCodeDataUrl = await generateQrCodeDataUrl(wgConf);
      await bumpNetmap(client);
      afterCommit.push(() =>
        logAuditEvent({
          eventType: 'CONFIG_GENERATE',
          organizationId,
          severity: 'info',
          actorUserId: actor.id,
          actorUsername: actor.username,
          targetId: kp.nodeId,
          targetType: 'node',
          message: `Config generated for node ${name} (onion: ${onionEnabled})`,
          ipAddress: req.ip,
          metadata: { onion_routing_enabled: onionEnabled, onion_hops: hops }
        })
      );
      afterCommit.push(() =>
        broadcastNodeEvent(
          'NODE_REGISTER',
          {
            id: kp.nodeId,
            name: name.trim(),
            user_id: actor.id,
            organization_id: organizationId,
            role: nodeRole,
            overlay_ipv4: overlayIpv4,
            onion_routing_enabled: onionEnabled
          },
          actor
        )
      );
    });

    return res.status(200).json({
      node_id: kp.nodeId,
      private_key: kp.privateKeyBase64,
      public_key: kp.publicKeyBase64,
      overlay_ipv4: overlayIpv4,
      overlay_ipv6: overlayIpv6,
      onion_routing_enabled: onionEnabled,
      onion_hops: hops,
      wireguard_conf: wgConf,
      json_profile: jsonProfile,
      qrcode_data_url: qrCodeDataUrl
    });
  } catch (err) {
    if (sendHonestFailure(res, err)) return;
    next(err);
  }
});

// 2. Get WireGuard Config for existing node
router.get('/wireguard/:id', async (req, res, next) => {
  try {
    const pool = getPgPool();
    const nodeRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
    const node = nodeRes.rows[0] || null;

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    if (req.user.role !== 'super-admin' && node.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access forbidden' });
    }

    const wgConf = buildWireGuardConfig({
      deviceName: node.name || 'Sovereign-Client',
      role: node.role || 'CLIENT_ORIGIN',
      privateKeyBase64: 'REDACTED_CLIENT_PRIVATE_KEY',
      overlayIpv4: node.overlay_ipv4,
      overlayIpv6: node.overlay_ipv6,
      presharedKeyBase64: node.preshared_key,
      onionRoutingEnabled: Boolean(node.onion_routing_enabled),
      onionHops: Boolean(node.onion_routing_enabled) ? (node.onion_hops > 0 ? node.onion_hops : 3) : 0
    });

    return res.status(200).json({
      node_id: node.id,
      wireguard_conf: wgConf
    });
  } catch (err) {
    if (sendHonestFailure(res, err)) return;
    next(err);
  }
});

// 3. Get Noise JSON Profile for existing node
router.get('/noise/:id', async (req, res, next) => {
  try {
    const pool = getPgPool();
    const nodeRes = await pool.query('SELECT * FROM nodes WHERE id = $1', [req.params.id]);
    const node = nodeRes.rows[0] || null;

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    if (req.user.role !== 'super-admin' && node.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access forbidden' });
    }

    const onionEnabled = Boolean(node.onion_routing_enabled);
    const hops = onionEnabled ? (node.onion_hops > 0 ? node.onion_hops : 3) : 0;
    const jsonProfile = buildNoiseJsonProfile({
      nodeId: node.id,
      privateKeyHex: '00'.repeat(32),
      publicKeyHex: Buffer.from(node.public_key, 'base64').toString('hex'),
      overlayIpv4: node.overlay_ipv4,
      overlayIpv6: node.overlay_ipv6,
      role: node.role,
      countryCode: node.country_code,
      onionHops: hops,
      onionRoutingEnabled: onionEnabled,
      relays: await TransportPolicyService.enabledRelays()
    });

    return res.status(200).json({
      node_id: node.id,
      onion_routing_enabled: onionEnabled,
      onion_hops: hops,
      json_profile: jsonProfile
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
