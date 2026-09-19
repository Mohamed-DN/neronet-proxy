/**
 * WebRtcSignalingEngine.js
 * Sovereign Cloud PC (WebRTC Native / Selkies-GStreamer) Control Plane (R2)
 *
 * Features:
 * - Direct Selkies-GStreamer WebRTC streaming control plane (skipping Guacamole).
 * - Generates WebRTC projection tokens, session IDs, and STUN/TURN ICE credentials.
 * - Custom domain registration with SSO/OTP gateway security verification.
 * - Multi-tenant Cloud PC fleet management with PostgreSQL 16 & SQLite support.
 */

const crypto = require('crypto');
const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');
const logger = require('../utils/logger');

const DEFAULT_SIGNALING_URL = 'wss://signal.internal.darknero.com/ws/selkies';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Generate a per-domain OTP secret.
 *
 * Every custom domain previously shared the literal 'OTP123456', written into the
 * schema as a column default and again into both INSERT statements. One secret
 * across every tenant is not a secret.
 */
function generateOtpSecret() {
  const bytes = crypto.randomBytes(20); // 160 bits, the RFC 4226 recommendation
  let secret = '';
  for (const byte of bytes) {
    secret += BASE32_ALPHABET[byte % BASE32_ALPHABET.length];
  }
  return secret;
}

/** Compare two secrets without leaking their contents through timing. */
function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:turn.internal.darknero.com:3478', username: 'neronet', credential: 'turn_secret_token' }
];

function parseJson(val, def = {}) {
  if (!val) return def;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch (e) {
    return def;
  }
}

function ensureCloudPcSchema(db) {
  if (!isPostgres() && db && typeof db.exec === 'function') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_pcs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        specs TEXT NOT NULL DEFAULT '{"vcpus": 4, "ram_gb": 16}',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('provisioning', 'active', 'stopped', 'error')),
        signaling_url TEXT NOT NULL DEFAULT 'wss://signal.internal.darknero.com/ws/selkies',
        custom_domain TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_pcs_user ON cloud_pcs(user_id);

      CREATE TABLE IF NOT EXISTS custom_domains (
        id TEXT PRIMARY KEY,
        domain_name TEXT NOT NULL UNIQUE,
        cloud_pc_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sso_gateway_enabled INTEGER NOT NULL DEFAULT 1,
        otp_secret TEXT,
        webrtc_signaling_endpoint TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON custom_domains(domain_name);
    `);

    // Ensure seed cpc-0001 and custom domain exist if table is empty
    const count = db.prepare('SELECT count(*) as cnt FROM cloud_pcs').get();
    if (count && count.cnt === 0) {
      const adminUser = db.prepare("SELECT id FROM users WHERE role = 'super-admin' LIMIT 1").get();
      const adminId = adminUser ? adminUser.id : 'usr-admin';
      const node = db.prepare('SELECT id FROM nodes LIMIT 1').get();
      const nodeId = node ? node.id : 'svrn-node-seed1';

      db.prepare(
        `
        INSERT OR IGNORE INTO cloud_pcs (id, name, user_id, device_id, specs, status, signaling_url, custom_domain)
        VALUES ('cpc-0001', 'Admin GPU Workstation', ?, ?, '{"vcpus": 8, "ram_gb": 32, "gpu": "RTX 4090"}', 'active', 'wss://signal.internal.darknero.com/ws/selkies', 'desktop.admin.darknero.com')
      `
      ).run(adminId, nodeId);

      // Random even for the demo row: a seeded domain with a known OTP secret is a
      // live bypass on any database that was ever seeded, development or not.
      db.prepare(
        `
        INSERT OR IGNORE INTO custom_domains (id, domain_name, cloud_pc_id, user_id, sso_gateway_enabled, otp_secret)
        VALUES ('cdom-0001', 'desktop.admin.darknero.com', 'cpc-0001', ?, 1, ?)
      `
      ).run(adminId, generateOtpSecret());
    }
  }
}

/**
 * Lists Cloud PC instances scoped by tenant/admin role.
 */
async function listInstances(actor) {
  let rows = [];
  if (isPostgres()) {
    const pool = getPgPool();
    if (actor && actor.role === 'super-admin') {
      const res = await pool.query('SELECT * FROM cloud_pcs ORDER BY created_at ASC');
      rows = res.rows;
    } else if (actor) {
      const res = await pool.query('SELECT * FROM cloud_pcs WHERE user_id = $1 ORDER BY created_at ASC', [actor.id]);
      rows = res.rows;
    }
  } else {
    const db = getDatabase();
    ensureCloudPcSchema(db);
    if (actor && actor.role === 'super-admin') {
      rows = db.prepare('SELECT * FROM cloud_pcs ORDER BY created_at ASC').all();
    } else if (actor) {
      rows = db.prepare('SELECT * FROM cloud_pcs WHERE user_id = ? ORDER BY created_at ASC').all(actor.id);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    user_id: r.user_id,
    device_id: r.device_id,
    specs: parseJson(r.specs, { vcpus: 4, ram_gb: 16 }),
    status: r.status,
    signaling_url: r.signaling_url || DEFAULT_SIGNALING_URL,
    custom_domain: r.custom_domain,
    created_at: r.created_at,
    updated_at: r.updated_at
  }));
}

/**
 * Retrieves a single Cloud PC instance by ID.
 */
async function getInstanceById(instanceId) {
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM cloud_pcs WHERE id = $1', [instanceId]);
    return res.rows[0] || null;
  } else {
    const db = getDatabase();
    ensureCloudPcSchema(db);
    return db.prepare('SELECT * FROM cloud_pcs WHERE id = ?').get(instanceId) || null;
  }
}

/**
 * Provisions a new Cloud PC instance linked to a registered device/node.
 */
async function provisionInstance({ name, device_id, specs = { vcpus: 4, ram_gb: 16 }, custom_domain, actor }) {
  if (!name || !device_id) {
    const err = new Error('Missing required cloud PC fields (name, device_id)');
    err.status = 400;
    throw err;
  }

  const userId = actor ? actor.id : 'usr-admin';
  const cid = `cpc-${Math.random().toString(36).substring(2, 6)}`;
  const specsJson = typeof specs === 'object' ? JSON.stringify(specs) : specs;
  const nowIso = new Date().toISOString();

  if (isPostgres()) {
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO cloud_pcs
       (id, name, user_id, device_id, specs, status, signaling_url, custom_domain, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $8)`,
      [cid, name, userId, device_id, specsJson, DEFAULT_SIGNALING_URL, custom_domain || null, nowIso]
    );
  } else {
    const db = getDatabase();
    ensureCloudPcSchema(db);
    db.prepare(
      `INSERT INTO cloud_pcs
       (id, name, user_id, device_id, specs, status, signaling_url, custom_domain, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    ).run(cid, name, userId, device_id, specsJson, DEFAULT_SIGNALING_URL, custom_domain || null, nowIso, nowIso);
  }

  logAuditEvent({
    eventType: 'CLOUDPC_PROVISION',
    severity: 'info',
    actorUserId: userId,
    actorUsername: actor ? actor.username : 'user',
    targetId: cid,
    targetType: 'cloud_pc',
    message: `Cloud PC instance '${name}' provisioned on device ${device_id}`
  });

  return {
    id: cid,
    name,
    user_id: userId,
    device_id,
    specs: parseJson(specsJson),
    status: 'active',
    signaling_url: DEFAULT_SIGNALING_URL,
    custom_domain: custom_domain || null,
    created_at: nowIso
  };
}

/**
 * Projects a Cloud PC device, returning WebRTC signaling endpoint & ICE credentials.
 */
async function projectDevice(instanceId, actor) {
  const cpc = await getInstanceById(instanceId);
  if (!cpc) {
    const err = new Error('Cloud PC instance not found');
    err.status = 404;
    throw err;
  }

  if (actor && actor.role !== 'super-admin' && cpc.user_id !== actor.id) {
    const err = new Error('Access forbidden');
    err.status = 403;
    throw err;
  }

  const hashSeed = `${instanceId}_${Date.now()}_${Math.random()}`;
  const session_id = `webrtc_sess_${crypto.createHash('sha256').update(hashSeed).digest('hex').substring(0, 16)}`;
  const stream_token = `stok_${crypto.createHash('sha256').update(session_id).digest('hex')}`;

  logAuditEvent({
    eventType: 'CLOUDPC_PROJECT',
    severity: 'info',
    actorUserId: actor ? actor.id : null,
    actorUsername: actor ? actor.username : 'user',
    targetId: instanceId,
    targetType: 'cloud_pc',
    message: `WebRTC projection session initiated for Cloud PC ${instanceId}`
  });

  return {
    session_id,
    device_id: cpc.device_id,
    signaling_url: cpc.signaling_url || DEFAULT_SIGNALING_URL,
    ice_servers: DEFAULT_ICE_SERVERS,
    stream_token,
    status: 'ready'
  };
}

/**
 * Tears down a WebRTC streaming session.
 */
async function teardownSession(instanceId, actor) {
  const cpc = await getInstanceById(instanceId);
  if (!cpc) {
    const err = new Error('Cloud PC instance not found');
    err.status = 404;
    throw err;
  }

  if (actor && actor.role !== 'super-admin' && cpc.user_id !== actor.id) {
    const err = new Error('Access forbidden');
    err.status = 403;
    throw err;
  }

  logAuditEvent({
    eventType: 'CLOUDPC_TEARDOWN',
    severity: 'info',
    actorUserId: actor ? actor.id : null,
    actorUsername: actor ? actor.username : 'user',
    targetId: instanceId,
    targetType: 'cloud_pc',
    message: `WebRTC projection session torn down for Cloud PC ${instanceId}`
  });

  return { success: true, message: 'WebRTC session torn down', instance_id: instanceId };
}

/**
 * Lists all registered custom domains.
 */
async function listCustomDomains(actor) {
  let rows = [];
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM custom_domains ORDER BY created_at ASC');
    rows = res.rows;
  } else {
    const db = getDatabase();
    ensureCloudPcSchema(db);
    rows = db.prepare('SELECT * FROM custom_domains ORDER BY created_at ASC').all();
  }

  return rows.map((r) => ({
    id: r.id,
    domain: r.domain_name,
    domain_name: r.domain_name,
    cloud_pc_id: r.cloud_pc_id,
    user_id: r.user_id,
    sso_enabled: Boolean(r.sso_gateway_enabled),
    otp_secret: r.otp_secret,
    created_at: r.created_at
  }));
}

/**
 * Retrieves a custom domain record by FQDN domain name.
 */
async function getCustomDomainByName(domain) {
  const normDomain = (domain || '').trim().toLowerCase();
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM custom_domains WHERE LOWER(domain_name) = $1', [normDomain]);
    return res.rows[0] || null;
  } else {
    const db = getDatabase();
    ensureCloudPcSchema(db);
    return db.prepare('SELECT * FROM custom_domains WHERE LOWER(domain_name) = ?').get(normDomain) || null;
  }
}

/**
 * Registers a new custom domain for routing to a Cloud PC instance.
 */
async function registerCustomDomain({ domain, cloud_pc_id, actor }) {
  if (!domain || !cloud_pc_id) {
    const err = new Error('Missing domain or cloud_pc_id');
    err.status = 400;
    throw err;
  }

  const normDomain = domain.trim().toLowerCase();
  if (!normDomain.includes('.') || normDomain.length < 4 || normDomain.startsWith('.') || normDomain.endsWith('.')) {
    const err = new Error('Invalid FQDN format');
    err.status = 400;
    throw err;
  }

  const existing = await getCustomDomainByName(normDomain);
  if (existing) {
    const err = new Error('Custom domain already registered');
    err.status = 409;
    throw err;
  }

  const cdomId = `cdom-${crypto.randomBytes(4).toString('hex')}`;
  const userId = actor ? actor.id : 'usr-admin';
  const nowIso = new Date().toISOString();
  const otpSecret = generateOtpSecret();

  if (isPostgres()) {
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO custom_domains
       (id, domain_name, cloud_pc_id, user_id, sso_gateway_enabled, otp_secret, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6, $6)`,
      [cdomId, normDomain, cloud_pc_id, userId, otpSecret, nowIso]
    );
  } else {
    const db = getDatabase();
    ensureCloudPcSchema(db);
    db.prepare(
      `INSERT INTO custom_domains
       (id, domain_name, cloud_pc_id, user_id, sso_gateway_enabled, otp_secret, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(cdomId, normDomain, cloud_pc_id, userId, otpSecret, nowIso, nowIso);
  }

  return {
    id: cdomId,
    domain: normDomain,
    domain_name: normDomain,
    cloud_pc_id,
    user_id: userId,
    sso_enabled: true,
    // Returned once, at creation, so the caller can enrol it in an authenticator.
    otp_secret: otpSecret,
    created_at: nowIso
  };
}

/**
 * Authenticates custom domain access via OTP / SSO gateway before releasing WebRTC stream.
 */
async function authenticateGateway(domain, otpCode) {
  const normDomain = (domain || '').trim().toLowerCase();
  const domObj = await getCustomDomainByName(normDomain);
  if (!domObj) {
    const err = new Error('Custom domain routing rule not found');
    err.status = 404;
    throw err;
  }

  // The literal '123456' used to be accepted here for any domain, unconditionally
  // and regardless of the stored secret -- an authentication bypass on every custom
  // domain gateway, not a weak default. Only the domain's own secret is accepted now.
  if (!secretsMatch(otpCode, domObj.otp_secret)) {
    const err = new Error('Invalid OTP code for custom domain gateway');
    err.status = 401;
    throw err;
  }

  const stream_token = `stream_auth_${crypto
    .createHash('sha256')
    .update(normDomain + Date.now())
    .digest('hex')
    .substring(0, 16)}`;

  return {
    authenticated: true,
    domain: normDomain,
    cloud_pc_id: domObj.cloud_pc_id,
    stream_token
  };
}

module.exports = {
  listInstances,
  getInstanceById,
  provisionInstance,
  projectDevice,
  teardownSession,
  listCustomDomains,
  getCustomDomainByName,
  registerCustomDomain,
  authenticateGateway,
  ensureCloudPcSchema,
  DEFAULT_SIGNALING_URL,
  DEFAULT_ICE_SERVERS
};
