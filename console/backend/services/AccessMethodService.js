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
/** In the order the person sees them. */
const METHODS = [WIREGUARD, WIREGUARD_WSS, AMNEZIAWG];
/** Plain labels, English and jargon-free; the console translates by id. */
const LABELS = {
  [WIREGUARD]: 'Normal',
  [WIREGUARD_WSS]: 'Network that blocks VPNs (port 443)',
  [AMNEZIAWG]: 'Network that recognises VPNs (AmneziaWG)'
};
/** The capability a gateway reports when it runs the AmneziaWG listener (node_capabilities). */
const AWG_CAPABILITY = 'awg-v1';
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
 *   S3     padding of the cookie reply (2.0)        0..64
 *   S4     padding of a transport packet (2.0)      0..32
 *   H1..H4 message-type headers (2.0: a range)      inside 5..4294967295, the four ranges
 *                                                   do not overlap; 1..4 are WireGuard's own
 */
const RANGES = {
  jc: [4, 12],
  jmin: [8, 128],
  jmaxSpan: [32, 400], // Jmax = Jmin + a span, never above 1280
  s1: [15, 150],
  s2: [15, 150],
  s3: [8, 64],
  s4: [4, 32]
};
const H_MIN = 5;
const H_MAX = 4294967295;
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
  if (!int(params.s1, 0, 1132) || !int(params.s2, 0, 1188) || params.s1 + 56 === params.s2) return false;
  if (!int(params.s3, 0, 64) || !int(params.s4, 0, 32)) return false;
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
    amneziawg_ready: paramsOf(orgRow) !== null
  };
}

async function organisationRow(organizationId, client = getPgPool()) {
  const res = await client.query('SELECT id, allowed_access_methods, awg_params FROM organizations WHERE id = $1', [
    organizationId
  ]);
  return res.rows[0] || null;
}

async function getSettings(organizationId) {
  const row = await organisationRow(organizationId);
  return row ? settingsView(row) : null;
}

/**
 * Switch the two optional methods. Turning AmneziaWG on for the first time generates the
 * parameters; turning it off keeps them, so turning it on again does not break the devices
 * that already have a profile. Moves the netmap version: gateways start or stop the listener.
 */
async function setSettings(organizationId, input) {
  const wanted = input || {};
  for (const key of ['wireguard_wss', 'amneziawg']) {
    if (typeof wanted[key] !== 'boolean') {
      throw new AccessMethodError(400, `${key} must be true or false`, 'invalid_access_methods');
    }
  }
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT id, allowed_access_methods, awg_params FROM organizations WHERE id = $1 FOR UPDATE',
      [organizationId]
    );
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const allowed = [WIREGUARD];
    if (wanted.wireguard_wss) allowed.push(WIREGUARD_WSS);
    if (wanted.amneziawg) allowed.push(AMNEZIAWG);
    let params = paramsOf(found.rows[0]);
    const generated = wanted.amneziawg && params === null;
    if (generated) params = generateAwgParams();
    const updated = await client.query(
      `UPDATE organizations SET allowed_access_methods = $2::text[], awg_params = $3::jsonb
        WHERE id = $1 RETURNING id, allowed_access_methods, awg_params`,
      [organizationId, allowed, params === null ? null : JSON.stringify(params)]
    );
    await AclEngine.bumpNetmap(client);
    await client.query('COMMIT');
    return { ...settingsView(updated.rows[0]), generated };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * New parameters. Every existing AmneziaWG device must import its profile again, so the
 * count is returned for the warning and the audit entry.
 */
async function regenerateParams(organizationId) {
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
    if (!allowedOf(found.rows[0]).includes(AMNEZIAWG)) {
      throw new AccessMethodError(409, 'AmneziaWG is not switched on', 'amneziawg_not_enabled');
    }
    const updated = await client.query(
      'UPDATE organizations SET awg_params = $2::jsonb WHERE id = $1 RETURNING id, allowed_access_methods, awg_params',
      [organizationId, JSON.stringify(generateAwgParams())]
    );
    const devices = await client.query(
      `SELECT COUNT(*)::int AS n FROM nodes
        WHERE device_kind = 'profile' AND access_method = 'amneziawg'
          AND COALESCE(organization_id, 'org-default') = $1`,
      [organizationId]
    );
    await AclEngine.bumpNetmap(client);
    await client.query('COMMIT');
    return { ...settingsView(updated.rows[0]), devices_to_redo: devices.rows[0].n };
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

/**
 * The methods usable for a device behind `gateway`, in display order. `wssAvailable` is
 * whether the installation runs the WebSocket tunnel (it is installation-wide, not a
 * property of one gateway).
 */
async function availableMethods(organizationId, gateway, wssAvailable) {
  const row = await organisationRow(organizationId);
  if (!row || !gateway) return [];
  const allowed = allowedOf(row);
  return METHODS.filter((method) => {
    if (!allowed.includes(method)) return false;
    if (method === WIREGUARD_WSS) return Boolean(wssAvailable);
    if (method === AMNEZIAWG) return gatewayRunsAmneziaWg(gateway) && paramsOf(row) !== null;
    return true;
  });
}

/** The parameters for a profile, or null when the organisation has none. */
async function paramsForProfile(organizationId) {
  return paramsOf(await organisationRow(organizationId));
}

module.exports = {
  METHODS,
  LABELS,
  AWG_CAPABILITY,
  AccessMethodError,
  generateAwgParams,
  validAwgParams,
  paramsOf,
  allowedOf,
  getSettings,
  setSettings,
  regenerateParams,
  gatewayRunsAmneziaWg,
  awgEndpointOf,
  availableMethods,
  paramsForProfile
};
