'use strict';

/**
 * Access methods of profile devices (ADR 0036).
 *
 * A method is usable for a device when the organisation allows it (a ceiling the
 * organisation's administrators set, like allowed_transports) and the device's gateway
 * advertises it. Nothing here widens either side: a method is the intersection.
 *
 * AmneziaWG parameters are a secret of the organisation, like a key. They are generated
 * here at random, stored in organizations.awg_params, never logged, and handed out in two
 * places only: the netmap of the organisation's own gateways and the answer to the
 * signed-in person who just added an AmneziaWG device.
 */

const crypto = require('node:crypto');
const { getPgPool } = require('../db/index');
const AclEngine = require('./AclEngine');

const WIREGUARD = 'wireguard';
const WIREGUARD_WSS = 'wireguard-wss';
const AMNEZIAWG = 'amneziawg';
const VLESS = 'vless-reality';
/** In the order the person sees them. */
const METHODS = [WIREGUARD, WIREGUARD_WSS, AMNEZIAWG, VLESS];
/** Plain labels, English and jargon-free; the console translates by id. */
const LABELS = {
  [WIREGUARD]: 'Normal',
  [WIREGUARD_WSS]: 'Network that blocks VPNs (port 443)',
  [AMNEZIAWG]: 'Network that recognises VPNs (AmneziaWG)',
  [VLESS]: 'Heavily censored network (VLESS)'
};
/** The capability a gateway reports when it runs the AmneziaWG listener (node_capabilities). */
const AWG_CAPABILITY = 'awg-v1';
/** The capability a gateway reports when its VLESS + REALITY terminator runs (node_capabilities). */
const VLESS_CAPABILITY = 'vless-v1';
const DEFAULT_ALLOWED = [WIREGUARD, WIREGUARD_WSS];

/**
 * AmneziaWG 2.0 parameter ranges, as documented for amneziawg-go and the Amnezia apps
 * (docs.amnezia.org, AmneziaWG configuration reference; amneziawg-go README). They are
 * kept inside the stricter of the 1.x and 2.0 limits so the official apps on every
 * platform accept them. Check them again when the pinned amneziawg-go release changes.
 *
 *   Jc     junk packets before the handshake        1..128 (generated 4..12)
 *   Jmin   smallest junk packet, bytes              Jmin < Jmax
 *   Jmax   largest junk packet, bytes               <= 1280
 *   S1     padding of the handshake initiation      0..1132
 *   S2     padding of the handshake response        0..1188, and S1 + 56 != S2
 *   S3     padding of the cookie reply (2.0)        12..64
 *   S4     padding of a transport packet (2.0)      12..32
 *          (amneziawg-go README: header protection needs S1..S4 >= 12)
 *   H1..H4 message-type headers (2.0: a range)      inside 5..2147483647 (recommended; some
 *                                                   clients read them as signed 32-bit), the four ranges
 *                                                   do not overlap; 1..4 are WireGuard's own
 */
const RANGES = {
  jc: [4, 12],
  jmin: [8, 128],
  jmaxSpan: [32, 400], // Jmax = Jmin + a span, never above 1280
  s1: [15, 150],
  s2: [15, 150],
  s3: [12, 64],
  s4: [12, 32]
};
const H_MIN = 5;
const H_MAX = 2147483647;
const H_MIN_WIDTH = 1000;
const KEYS = ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4', 'h1', 'h2', 'h3', 'h4'];
const H_FORMAT = /^([0-9]{1,10})-([0-9]{1,10})$/;

class AccessMethodError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function between(lo, hi, rng) {
  return rng(lo, hi + 1);
}

/**
 * Fresh parameters. `rng(min, maxExclusive)` defaults to crypto.randomInt, so every
 * organisation gets its own; a test injects a fake one.
 */
function generateAwgParams(rng = crypto.randomInt) {
  const jc = between(RANGES.jc[0], RANGES.jc[1], rng);
  const jmin = between(RANGES.jmin[0], RANGES.jmin[1], rng);
  const jmax = Math.min(1280, jmin + between(RANGES.jmaxSpan[0], RANGES.jmaxSpan[1], rng));
  const s1 = between(RANGES.s1[0], RANGES.s1[1], rng);
  let s2 = between(RANGES.s2[0], RANGES.s2[1], rng);
  while (s1 + 56 === s2) s2 = between(RANGES.s2[0], RANGES.s2[1], rng);
  const s3 = between(RANGES.s3[0], RANGES.s3[1], rng);
  const s4 = between(RANGES.s4[0], RANGES.s4[1], rng);
  // Four disjoint ranges: the usable space is cut in four equal bands and each header
  // takes a random range inside its own band, the bands in a random order.
  const band = Math.floor((H_MAX - H_MIN + 1) / 4);
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng(0, i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const h = order.map((slot) => {
    const start = H_MIN + slot * band;
    const lo = start + rng(0, Math.floor(band / 2));
    const hi = lo + H_MIN_WIDTH + rng(0, Math.floor(band / 4));
    return `${lo}-${hi}`;
  });
  return { jc, jmin, jmax, s1, s2, s3, s4, h1: h[0], h2: h[1], h3: h[2], h4: h[3] };
}

/** True when `params` is what generateAwgParams could have made: nothing else is stored or sent. */
function validAwgParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const keys = Object.keys(params);
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return false;
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(params.jc, 1, 128)) return false;
  if (!int(params.jmin, 0, 1279) || !int(params.jmax, 1, 1280) || params.jmin >= params.jmax) return false;
  if (!int(params.s1, 12, 1132) || !int(params.s2, 12, 1188) || params.s1 + 56 === params.s2) return false;
  if (!int(params.s3, 12, 64) || !int(params.s4, 12, 32)) return false;
  const ranges = [];
  for (const k of ['h1', 'h2', 'h3', 'h4']) {
    const m = typeof params[k] === 'string' ? H_FORMAT.exec(params[k]) : null;
    if (!m) return false;
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo < H_MIN || hi > H_MAX || lo > hi) return false;
    ranges.push([lo, hi]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] <= ranges[i - 1][1]) return false;
  return true;
}

/**
 * REALITY parameters (Xray-core): an X25519 key pair, written the way Xray and the clients read
 * it (base64url without padding, 43 characters), one or two short ids, and the fallback target
 * REALITY shows to anyone who cannot authenticate. The target is the operator's choice
 * (NERONET_REALITY_DEST, host:port of a TLS 1.3 site); there is no default, because a default
 * would make every installation look like the same one.
 */
const REALITY_KEY = /^[A-Za-z0-9_-]{43}$/;
const REALITY_SHORT_ID = /^([0-9a-f]{2}){1,8}$/;
const REALITY_DEST =
  /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+:([0-9]{1,5})$/;
const VLESS_KEYS = ['private_key', 'public_key', 'short_ids', 'dest', 'server_names'];

function realityDestOk(dest) {
  if (typeof dest !== 'string') return false;
  const m = REALITY_DEST.exec(dest);
  if (!m) return false;
  const port = Number(m[m.length - 1]);
  return port >= 1 && port <= 65535;
}

/** Fresh REALITY parameters for an organisation. `dest` is "host:port". */
function generateVlessParams(dest, randomBytes = crypto.randomBytes) {
  if (!realityDestOk(dest)) throw new Error('dest must be host:port of the REALITY fallback site');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const d = privateKey.export({ format: 'jwk' }).d;
  const x = publicKey.export({ format: 'jwk' }).x;
  return {
    private_key: d,
    public_key: x,
    // Two ids of different lengths: a link names one, the other is there to rotate to.
    short_ids: [randomBytes(8).toString('hex'), randomBytes(4).toString('hex')],
    dest,
    server_names: [dest.slice(0, dest.lastIndexOf(':'))]
  };
}

/** True when `params` is what generateVlessParams could have made: nothing else is stored or sent. */
function validVlessParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const keys = Object.keys(params);
  if (keys.length !== VLESS_KEYS.length || !VLESS_KEYS.every((k) => keys.includes(k))) return false;
  if (!REALITY_KEY.test(params.private_key) || !REALITY_KEY.test(params.public_key)) return false;
  if (!Array.isArray(params.short_ids) || params.short_ids.length < 1 || params.short_ids.length > 8) return false;
  if (!params.short_ids.every((id) => typeof id === 'string' && REALITY_SHORT_ID.test(id))) return false;
  if (!realityDestOk(params.dest)) return false;
  if (!Array.isArray(params.server_names) || params.server_names.length < 1) return false;
  if (!params.server_names.every((n) => typeof n === 'string' && n.length > 0 && n.length <= 253)) return false;
  try {
    const priv = crypto.createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', d: params.private_key, x: params.public_key },
      format: 'jwk'
    });
    return crypto.createPublicKey(priv).export({ format: 'jwk' }).x === params.public_key;
  } catch {
    return false;
  }
}

function parseColumn(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

/** The organisation's stored parameters when they are intact, otherwise null. */
function paramsOf(orgRow) {
  const params = parseColumn(orgRow && orgRow.awg_params);
  return validAwgParams(params) ? params : null;
}

/** The organisation's stored REALITY parameters when they are intact, otherwise null. */
function vlessParamsOf(orgRow) {
  const params = parseColumn(orgRow && orgRow.vless_params);
  return validVlessParams(params) ? params : null;
}

function allowedOf(orgRow) {
  const list = orgRow && Array.isArray(orgRow.allowed_access_methods) ? orgRow.allowed_access_methods : DEFAULT_ALLOWED;
  return METHODS.filter((m) => m === WIREGUARD || list.includes(m));
}

/** What the Settings card shows: switches only, never the parameters. */
function settingsView(orgRow) {
  const allowed = allowedOf(orgRow);
  return {
    organization_id: orgRow.id,
    allowed_access_methods: allowed,
    wireguard_wss: allowed.includes(WIREGUARD_WSS),
    amneziawg: allowed.includes(AMNEZIAWG),
    amneziawg_ready: paramsOf(orgRow) !== null,
    vless: allowed.includes(VLESS),
    vless_ready: vlessParamsOf(orgRow) !== null
  };
}

async function organisationRow(organizationId, client = getPgPool()) {
  const res = await client.query(
    'SELECT id, allowed_access_methods, awg_params, vless_params FROM organizations WHERE id = $1',
    [organizationId]
  );
  return res.rows[0] || null;
}

async function getSettings(organizationId) {
  const row = await organisationRow(organizationId);
  return row ? settingsView(row) : null;
}

/**
 * Switch the optional methods. Turning AmneziaWG or VLESS on for the first time generates the
 * parameters; turning one off keeps them, so turning it on again does not break the devices that
 * already have a profile. `vless` is optional in the request: absent leaves it as it is. Moves the
 * netmap version: gateways start or stop their listeners.
 */
async function setSettings(organizationId, input) {
  const wanted = input || {};
  for (const key of ['wireguard_wss', 'amneziawg']) {
    if (typeof wanted[key] !== 'boolean') {
      throw new AccessMethodError(400, `${key} must be true or false`, 'invalid_access_methods');
    }
  }
  if (wanted.vless !== undefined && typeof wanted.vless !== 'boolean') {
    throw new AccessMethodError(400, 'vless must be true or false', 'invalid_access_methods');
  }
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT id, allowed_access_methods, awg_params, vless_params FROM organizations WHERE id = $1 FOR UPDATE',
      [organizationId]
    );
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const wantVless = wanted.vless === undefined ? allowedOf(found.rows[0]).includes(VLESS) : wanted.vless;
    const allowed = [WIREGUARD];
    if (wanted.wireguard_wss) allowed.push(WIREGUARD_WSS);
    if (wanted.amneziawg) allowed.push(AMNEZIAWG);
    if (wantVless) allowed.push(VLESS);
    let params = paramsOf(found.rows[0]);
    const generated = wanted.amneziawg && params === null;
    if (generated) params = generateAwgParams();
    let vless = vlessParamsOf(found.rows[0]);
    const vlessGenerated = wantVless && vless === null;
    if (vlessGenerated) vless = generateVlessParams(configuredRealityDest());
    const updated = await client.query(
      `UPDATE organizations SET allowed_access_methods = $2::text[], awg_params = $3::jsonb, vless_params = $4::jsonb
        WHERE id = $1 RETURNING id, allowed_access_methods, awg_params, vless_params`,
      [
        organizationId,
        allowed,
        params === null ? null : JSON.stringify(params),
        vless === null ? null : JSON.stringify(vless)
      ]
    );
    await AclEngine.bumpNetmap(client);
    await client.query('COMMIT');
    return { ...settingsView(updated.rows[0]), generated, vless_generated: vlessGenerated };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The fallback site the operator chose for REALITY; refuses when there is none. */
function configuredRealityDest() {
  const dest = String(process.env.NERONET_REALITY_DEST || '').trim();
  if (!realityDestOk(dest)) {
    throw new AccessMethodError(
      409,
      'The operator has not set NERONET_REALITY_DEST (host:port of the REALITY fallback site)',
      'reality_dest_not_configured'
    );
  }
  return dest;
}

/**
 * New parameters for AmneziaWG (the default) or vless-reality. Every existing device on that method
 * must import its profile again, so the count is returned for the warning and the audit entry.
 * A VLESS device keeps its uuid; the key pair and short ids in its link change.
 */
async function regenerateParams(organizationId, method = AMNEZIAWG) {
  if (method !== AMNEZIAWG && method !== VLESS) {
    throw new AccessMethodError(400, 'method must be amneziawg or vless-reality', 'invalid_access_methods');
  }
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT id, allowed_access_methods FROM organizations WHERE id = $1 FOR UPDATE', [
      organizationId
    ]);
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    if (!allowedOf(found.rows[0]).includes(method)) {
      throw new AccessMethodError(
        409,
        method === VLESS ? 'VLESS is not switched on' : 'AmneziaWG is not switched on',
        method === VLESS ? 'vless_not_enabled' : 'amneziawg_not_enabled'
      );
    }
    const column = method === VLESS ? 'vless_params' : 'awg_params';
    const fresh = method === VLESS ? generateVlessParams(configuredRealityDest()) : generateAwgParams();
    const updated = await client.query(
      `UPDATE organizations SET ${column} = $2::jsonb WHERE id = $1
        RETURNING id, allowed_access_methods, awg_params, vless_params`,
      [organizationId, JSON.stringify(fresh)]
    );
    const devices = await client.query(
      `SELECT COUNT(*)::int AS n FROM nodes
        WHERE device_kind = 'profile' AND access_method = $2
          AND COALESCE(organization_id, 'org-default') = $1`,
      [organizationId, method]
    );
    await AclEngine.bumpNetmap(client);
    await client.query('COMMIT');
    return { ...settingsView(updated.rows[0]), devices_to_redo: devices.rows[0].n, method };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** True when the gateway row reports an AmneziaWG listener. */
function gatewayRunsAmneziaWg(gateway) {
  return (
    Boolean(gateway) &&
    Array.isArray(gateway.node_capabilities) &&
    gateway.node_capabilities.includes(AWG_CAPABILITY) &&
    Number.isInteger(gateway.awg_port)
  );
}

/** host:port a profile names as Endpoint for AmneziaWG: the gateway's named host, its reported port. */
function awgEndpointOf(gateway) {
  if (!gatewayRunsAmneziaWg(gateway)) return null;
  const named = String(gateway.profile_gateway_endpoint || '');
  const at = named.lastIndexOf(':');
  if (at <= 0) return null;
  return `${named.slice(0, at)}:${gateway.awg_port}`;
}

/** True when the gateway row reports a running VLESS + REALITY terminator. */
function gatewayRunsVless(gateway) {
  return (
    Boolean(gateway) &&
    Array.isArray(gateway.node_capabilities) &&
    gateway.node_capabilities.includes(VLESS_CAPABILITY) &&
    Number.isInteger(gateway.vless_port)
  );
}

/** [host, port] a VLESS link names: the gateway's named host, the port it reported. */
function vlessEndpointOf(gateway) {
  if (!gatewayRunsVless(gateway)) return null;
  const named = String(gateway.profile_gateway_endpoint || '');
  const at = named.lastIndexOf(':');
  if (at <= 0) return null;
  return { host: named.slice(0, at), port: gateway.vless_port };
}

const VLESS_FLOW = 'xtls-rprx-vision';
const VLESS_FINGERPRINT = 'chrome';

/**
 * What the person who just added a VLESS device needs: the share link every v2ray-family app imports
 * and the same values for an app that wants them typed. The private key is never part of it.
 * `link` follows the VLESS share-link convention of Xray-core (XTLS/Xray-core discussion 716).
 */
function vlessProfile({ uuid, params, gateway, name }) {
  const endpoint = vlessEndpointOf(gateway);
  if (!endpoint || !params || !uuid) return null;
  const hostPart = endpoint.host.includes(':') && !endpoint.host.startsWith('[') ? `[${endpoint.host}]` : endpoint.host;
  const shortId = params.short_ids[0];
  const sni = params.server_names[0];
  const query = new URLSearchParams({
    encryption: 'none',
    flow: VLESS_FLOW,
    security: 'reality',
    sni,
    fp: VLESS_FINGERPRINT,
    pbk: params.public_key,
    sid: shortId,
    type: 'tcp'
  });
  return {
    link: `vless://${uuid}@${hostPart}:${endpoint.port}?${query.toString()}#${encodeURIComponent(name)}`,
    endpoint: `${endpoint.host}:${endpoint.port}`,
    uuid,
    server_name: sni,
    public_key: params.public_key,
    short_id: shortId,
    flow: VLESS_FLOW,
    fingerprint: VLESS_FINGERPRINT
  };
}

/**
 * The methods usable for a device behind `gateway`, in display order. `wssAvailable` is
 * whether the installation runs the WebSocket tunnel (it is installation-wide, not a
 * property of one gateway).
 */
function usableMethods(row, gateway, wssAvailable) {
  if (!row || !gateway) return [];
  const allowed = allowedOf(row);
  return METHODS.filter((method) => {
    if (!allowed.includes(method)) return false;
    if (method === WIREGUARD_WSS) return Boolean(wssAvailable);
    if (method === AMNEZIAWG) return gatewayRunsAmneziaWg(gateway) && paramsOf(row) !== null;
    if (method === VLESS) return gatewayRunsVless(gateway) && vlessParamsOf(row) !== null;
    return true;
  });
}

async function availableMethods(organizationId, gateway, wssAvailable) {
  return usableMethods(await organisationRow(organizationId), gateway, wssAvailable);
}

/** The parameters for a profile, or null when the organisation has none. */
async function paramsForProfile(organizationId) {
  return paramsOf(await organisationRow(organizationId));
}

/** The REALITY parameters for a VLESS profile, or null when the organisation has none. */
async function vlessParamsForProfile(organizationId) {
  return vlessParamsOf(await organisationRow(organizationId));
}

module.exports = {
  METHODS,
  LABELS,
  AWG_CAPABILITY,
  VLESS_CAPABILITY,
  AccessMethodError,
  generateAwgParams,
  validAwgParams,
  generateVlessParams,
  validVlessParams,
  paramsOf,
  vlessParamsOf,
  allowedOf,
  getSettings,
  setSettings,
  regenerateParams,
  gatewayRunsAmneziaWg,
  gatewayRunsVless,
  awgEndpointOf,
  vlessEndpointOf,
  vlessProfile,
  availableMethods,
  usableMethods,
  paramsForProfile,
  vlessParamsForProfile
};
