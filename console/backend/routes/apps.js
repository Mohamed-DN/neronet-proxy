const express = require('express');
const { readPageParams, pageEnvelope } = require('../utils/pagination');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDatabase } = require('../db/index');
const { authenticateToken } = require('../middleware/auth');
const { logAuditEvent } = require('../utils/audit');

function formatShareLink(row) {
  if (!row) return null;
  const isExpired = new Date(row.expires_at).getTime() < Date.now();
  const isRevoked = Boolean(row.is_revoked);
  const maxUsesReached = row.max_uses > 0 && row.use_count >= row.max_uses;
  let status = 'active';
  if (isRevoked) {
    status = 'revoked';
  } else if (isExpired) {
    status = 'expired';
  } else if (maxUsesReached) {
    status = 'depleted';
  }

  return {
    id: row.id,
    app_id: row.app_id,
    user_id: row.user_id,
    share_token: row.share_token,
    public_url: row.public_url,
    auth_mode: row.auth_mode,
    temporary_password: row.temporary_password,
    expires_at: row.expires_at,
    max_uses: row.max_uses || 0,
    use_count: row.use_count || 0,
    is_revoked: isRevoked,
    is_expired: isExpired,
    status,
    created_at: row.created_at
  };
}

// 0. Public Share Link Gateway Verification (Unauthenticated)
router.get('/public/verify/:token', (req, res) => {
  const { token } = req.params;
  const db = getDatabase();
  const link = db.prepare('SELECT * FROM app_share_links WHERE share_token = ?').get(token);

  if (!link) {
    return res.status(404).json({ valid: false, error: 'Public share link not found or invalid' });
  }

  if (Boolean(link.is_revoked)) {
    return res.status(403).json({ valid: false, error: 'Public share link has been revoked', is_revoked: true });
  }

  if (new Date(link.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ valid: false, error: 'Public share link has expired', is_expired: true });
  }

  if (link.max_uses > 0 && link.use_count >= link.max_uses) {
    return res.status(403).json({ valid: false, error: 'Public share link usage limit reached', is_depleted: true });
  }

  // Increment use count
  db.prepare('UPDATE app_share_links SET use_count = use_count + 1 WHERE id = ?').run(link.id);

  const app = db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(link.app_id);
  if (!app) {
    return res.status(404).json({ error: 'Associated application bundle not found' });
  }

  const sessionToken = `sess_pub_${crypto.randomBytes(16).toString('hex')}`;
  const gatewayUrl = `https://workspace.neronet.darknero.com/guac-tunnel/${app.id}`;

  return res.status(200).json({
    valid: true,
    share_id: link.id,
    app_id: app.id,
    app_name: app.name,
    app_type: app.type,
    auth_mode: link.auth_mode,
    public_url: link.public_url,
    gateway_protocol: 'guacamole_clientless_rdp',
    websocket_endpoint: `wss://workspace.neronet.darknero.com/guac-tunnel/${app.id}`,
    gateway_url: gatewayUrl,
    session_token: sessionToken,
    expires_at: link.expires_at,
    use_count: link.use_count + 1,
    max_uses: link.max_uses,
    requires_password: link.auth_mode === 'temporary_password'
  });
});

router.use(authenticateToken);

const VALID_APP_TYPES = ['guacamole', 'nextcloud', 'immich', 'seafile'];

function formatApp(row) {
  if (!row) return null;
  const launchUrl = row.endpoint_url.includes('#/client')
    ? row.endpoint_url
    : `https://${row.type}.internal.darknero.com/#/client/${row.id}`;
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    type: row.type,
    status: row.status,
    endpoint_url: row.endpoint_url,
    launch_url: launchUrl,
    internal_port: row.internal_port || 8080,
    container_id: row.container_id,
    cpu_cores: row.cpu_cores || 2.0,
    memory_mb: row.memory_mb || 2048,
    storage_gb: row.storage_gb || 50,
    scale_to_zero: Boolean(row.scale_to_zero),
    inactivity_timeout_min: row.inactivity_timeout_min || 30,
    last_accessed_at: row.last_accessed_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// 1. List Apps
router.get('/', (req, res) => {
  const db = getDatabase();
  const { limit, offset } = readPageParams(req);
  const scoped = req.user.role !== 'super-admin';

  const total = scoped
    ? db.prepare('SELECT count(*) AS n FROM app_bundles WHERE user_id = ?').get(req.user.id).n
    : db.prepare('SELECT count(*) AS n FROM app_bundles').get().n;

  const rows = scoped
    ? db
        .prepare('SELECT * FROM app_bundles WHERE user_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?')
        .all(req.user.id, limit, offset)
    : db.prepare('SELECT * FROM app_bundles ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?').all(limit, offset);

  const apps = rows.map(formatApp);
  return res.status(200).json({ apps, ...pageEnvelope({ items: apps, total, limit, offset }) });
});

// 2. Create App Bundle
router.post('/', (req, res) => {
  const { name, type, memory_mb, storage_gb, cpu_cores, scale_to_zero } = req.body || {};

  if (!name || !type) {
    return res.status(400).json({ error: 'Missing app name or type' });
  }

  if (!VALID_APP_TYPES.includes(type)) {
    return res.status(400).json({ error: `Invalid app type '${type}'. Valid: ${VALID_APP_TYPES.join(', ')}` });
  }

  const mem = memory_mb !== undefined ? memory_mb : 4096;
  const storage = storage_gb !== undefined ? storage_gb : 100;
  const cores = cpu_cores !== undefined ? cpu_cores : 2.0;

  // A sanity bound on what one bundle may request, not a commercial tier: 16 GB of
  // memory or a terabyte of storage for a single app is a mistake, not a purchase.
  if (mem > 16384 || storage > 1000) {
    return res
      .status(422)
      .json({ error: 'Requested resources exceed what a single app bundle may allocate (16 GB memory, 1 TB storage)' });
  }

  const db = getDatabase();
  const aid = `app-${uuidv4().substring(0, 8)}`;
  const endpointUrl = `https://${type}.internal.darknero.com`;
  const stz = scale_to_zero !== undefined ? (scale_to_zero ? 1 : 0) : 1;

  db.prepare(
    `
    INSERT INTO app_bundles (
      id, user_id, name, type, status,
      endpoint_url, internal_port, cpu_cores, memory_mb, storage_gb, scale_to_zero
    ) VALUES (
      ?, ?, ?, ?, 'stopped',
      ?, 8080, ?, ?, ?, ?
    )
  `
  ).run(aid, req.user.id, name.trim(), type, endpointUrl, cores, mem, storage, stz);

  logAuditEvent({
    eventType: 'APP_CREATE',
    severity: 'info',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: aid,
    targetType: 'app',
    message: `App bundle ${name} (${type}) provisioned`,
    ipAddress: req.ip
  });

  const created = formatApp(db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(aid));
  return res.status(201).json({ app: created });
});

// 3. App SSO Launch & Wakeup (must come before :id base)
router.get('/:id/launch', (req, res) => {
  const db = getDatabase();
  const app = db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(req.params.id);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  if (req.user.role !== 'super-admin' && app.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  // Fast wake from stopped or hibernated
  db.prepare(
    `
    UPDATE app_bundles SET
      status = 'running',
      last_accessed_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(app.id);

  const ssoToken = `sso_${crypto.randomBytes(16).toString('hex')}`;
  const launchUrl = `https://${app.type}.internal.darknero.com/#/client/${app.id}`;

  logAuditEvent({
    eventType: 'APP_LAUNCH_SSO',
    severity: 'info',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: app.id,
    targetType: 'app',
    message: `App ${app.name} launched with SSO token`,
    ipAddress: req.ip
  });

  return res.status(200).json({
    launch_url: launchUrl,
    sso_token: ssoToken,
    app_id: app.id,
    status: 'running'
  });
});

// 4. App Lifecycle: Start
router.post('/:id/start', (req, res) => {
  const db = getDatabase();
  const app = db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(req.params.id);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  if (req.user.role !== 'super-admin' && app.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  db.prepare(
    `
    UPDATE app_bundles SET status = 'running', last_accessed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(app.id);

  logAuditEvent({
    eventType: 'APP_START',
    severity: 'info',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: app.id,
    targetType: 'app',
    message: `App ${app.name} started`,
    ipAddress: req.ip
  });

  const updated = formatApp(db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(app.id));
  return res.status(200).json({ success: true, app: updated });
});

// 5. App Lifecycle: Stop
router.post('/:id/stop', (req, res) => {
  const db = getDatabase();
  const app = db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(req.params.id);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  if (req.user.role !== 'super-admin' && app.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  db.prepare(
    `
    UPDATE app_bundles SET status = 'stopped', updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(app.id);

  logAuditEvent({
    eventType: 'APP_STOP',
    severity: 'info',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: app.id,
    targetType: 'app',
    message: `App ${app.name} stopped`,
    ipAddress: req.ip
  });

  const updated = formatApp(db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(app.id));
  return res.status(200).json({ success: true, app: updated });
});

// 6. App Lifecycle: Scale to Zero
router.post('/:id/scale-to-zero', (req, res) => {
  const db = getDatabase();
  const app = db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(req.params.id);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  if (req.user.role !== 'super-admin' && app.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  db.prepare(
    `
    UPDATE app_bundles SET status = 'hibernated', updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(app.id);

  logAuditEvent({
    eventType: 'APP_SCALE_ZERO',
    severity: 'info',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: app.id,
    targetType: 'app',
    message: `App ${app.name} hibernated (scale to zero)`,
    ipAddress: req.ip
  });

  const updated = formatApp(db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(app.id));
  return res.status(200).json({
    success: true,
    app: updated,
    message: 'App scaled to zero (hibernated)'
  });
});

// 7. App Action (generic dispatcher)
router.post('/:id/action', (req, res) => {
  const { action } = req.body || {};
  if (!action) {
    return res.status(400).json({ error: 'Missing action parameter' });
  }
  if (action === 'start') {
    return router.handle({ ...req, url: `/${req.params.id}/start`, method: 'POST' }, res);
  }
  if (action === 'stop') {
    return router.handle({ ...req, url: `/${req.params.id}/stop`, method: 'POST' }, res);
  }
  if (action === 'scale-to-zero') {
    return router.handle({ ...req, url: `/${req.params.id}/scale-to-zero`, method: 'POST' }, res);
  }
  return res.status(400).json({ error: `Unsupported action '${action}'` });
});

// 8. Get App By ID
router.get('/:id', (req, res) => {
  const db = getDatabase();
  const app = db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(req.params.id);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  if (req.user.role !== 'super-admin' && app.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }
  return res.status(200).json({ app: formatApp(app) });
});

// 9. Update App
router.put('/:id', (req, res) => {
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: 'Missing update body' });
  }

  const db = getDatabase();
  const app = db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(req.params.id);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  if (req.user.role !== 'super-admin' && app.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  const updates = [];
  const params = [];

  if (req.body.name) {
    updates.push('name = ?');
    params.push(req.body.name);
  }
  if (req.body.memory_mb !== undefined) {
    updates.push('memory_mb = ?');
    params.push(req.body.memory_mb);
  }
  if (req.body.storage_gb !== undefined) {
    updates.push('storage_gb = ?');
    params.push(req.body.storage_gb);
  }
  if (req.body.cpu_cores !== undefined) {
    updates.push('cpu_cores = ?');
    params.push(req.body.cpu_cores);
  }
  if (req.body.scale_to_zero !== undefined) {
    updates.push('scale_to_zero = ?');
    params.push(req.body.scale_to_zero ? 1 : 0);
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    db.prepare(`UPDATE app_bundles SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = formatApp(db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(req.params.id));
  return res.status(200).json({ app: updated });
});

// 10. Delete App
router.delete('/:id', (req, res) => {
  const db = getDatabase();
  const app = db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(req.params.id);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  if (req.user.role !== 'super-admin' && app.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  db.prepare('DELETE FROM app_bundles WHERE id = ?').run(req.params.id);

  logAuditEvent({
    eventType: 'APP_DELETE',
    severity: 'warn',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: req.params.id,
    targetType: 'app',
    message: `App ${app.name} deleted`,
    ipAddress: req.ip
  });

  return res.status(200).json({ success: true, message: 'App deleted' });
});

// 11. Create Public Share Link for App (Clientless RDP)
router.post(['/:id/share', '/:id/share-links'], (req, res) => {
  const db = getDatabase();
  const app = db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(req.params.id);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  if (req.user.role !== 'super-admin' && app.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  const { auth_mode, expires_in_hours, expires_at, max_uses, temporary_password } = req.body || {};
  const VALID_AUTH_MODES = ['temporary_password', 'sso_gateway', 'passkey'];
  const mode = auth_mode && VALID_AUTH_MODES.includes(auth_mode) ? auth_mode : 'temporary_password';

  const shareToken = crypto.randomBytes(24).toString('base64url');
  const linkId = `shlink-${uuidv4().substring(0, 8)}`;
  const publicUrl = `https://workspace.neronet.darknero.com/#/clientless/${app.id}?token=${shareToken}`;

  let tempPass = null;
  if (mode === 'temporary_password') {
    tempPass = temporary_password || `SVRN-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  }

  let finalExpiresAt;
  if (expires_at) {
    finalExpiresAt = new Date(expires_at).toISOString();
  } else {
    const hours = Number(expires_in_hours) || 24;
    finalExpiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  }

  const maxUsage = Number(max_uses) || 0;

  db.prepare(
    `
    INSERT INTO app_share_links (
      id, app_id, user_id, share_token, public_url, auth_mode,
      temporary_password, expires_at, max_uses, use_count, is_revoked
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, 0, 0
    )
  `
  ).run(linkId, app.id, req.user.id, shareToken, publicUrl, mode, tempPass, finalExpiresAt, maxUsage);

  logAuditEvent({
    eventType: 'APP_SHARE_LINK_CREATE',
    severity: 'info',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: app.id,
    targetType: 'app',
    message: `Public share link created for app ${app.name} (${mode})`,
    ipAddress: req.ip,
    metadata: { link_id: linkId, auth_mode: mode, expires_at: finalExpiresAt }
  });

  const createdLink = formatShareLink(db.prepare('SELECT * FROM app_share_links WHERE id = ?').get(linkId));
  return res.status(201).json({ success: true, share_link: createdLink, link: createdLink });
});

// 12. List Share Links for App
router.get('/:id/share-links', (req, res) => {
  const db = getDatabase();
  const app = db.prepare('SELECT * FROM app_bundles WHERE id = ?').get(req.params.id);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  if (req.user.role !== 'super-admin' && app.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  const rows = db.prepare('SELECT * FROM app_share_links WHERE app_id = ? ORDER BY created_at DESC').all(app.id);
  const shareLinks = rows.map(formatShareLink);
  return res.status(200).json({ share_links: shareLinks, total: shareLinks.length });
});

// 13. Revoke Share Link
router.delete(['/:id/share-links/:linkId', '/share-links/:linkId'], (req, res) => {
  const linkId = req.params.linkId;
  const db = getDatabase();
  const link = db.prepare('SELECT * FROM app_share_links WHERE id = ?').get(linkId);
  if (!link) {
    return res.status(404).json({ error: 'Share link not found' });
  }
  if (req.user.role !== 'super-admin' && link.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  db.prepare('UPDATE app_share_links SET is_revoked = 1 WHERE id = ?').run(linkId);

  logAuditEvent({
    eventType: 'APP_SHARE_LINK_REVOKE',
    severity: 'warn',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: link.app_id,
    targetType: 'app',
    message: `Share link ${linkId} revoked for app ${link.app_id}`,
    ipAddress: req.ip
  });

  return res.status(200).json({ success: true, message: 'Share link revoked successfully' });
});

router.post(['/:id/share-links/:linkId/revoke', '/share-links/:linkId/revoke'], (req, res) => {
  const linkId = req.params.linkId;
  const db = getDatabase();
  const link = db.prepare('SELECT * FROM app_share_links WHERE id = ?').get(linkId);
  if (!link) {
    return res.status(404).json({ error: 'Share link not found' });
  }
  if (req.user.role !== 'super-admin' && link.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  db.prepare('UPDATE app_share_links SET is_revoked = 1 WHERE id = ?').run(linkId);

  logAuditEvent({
    eventType: 'APP_SHARE_LINK_REVOKE',
    severity: 'warn',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: link.app_id,
    targetType: 'app',
    message: `Share link ${linkId} revoked for app ${link.app_id}`,
    ipAddress: req.ip
  });

  return res.status(200).json({ success: true, message: 'Share link revoked successfully' });
});

module.exports = router;
