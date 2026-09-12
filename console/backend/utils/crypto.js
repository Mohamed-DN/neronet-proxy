const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('../config/env');

/**
 * Generates a Curve25519 clamped keypair and derived identifiers.
 */
function generateCurve25519Keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');

  // Extract raw 32-byte buffers from DER encoding
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });

  const privBytes = Buffer.from(privDer.subarray(privDer.length - 32));
  const pubBytes = Buffer.from(pubDer.subarray(pubDer.length - 32));

  // Enforce Curve25519 clamping
  privBytes[0] &= 248;
  privBytes[31] &= 127;
  privBytes[31] |= 64;

  const pskBytes = crypto.randomBytes(32);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const nodeId = `svrn-node-${pubBytes.subarray(0, 4).toString('hex')}-${randomSuffix}`;

  return {
    privateKeyBase64: privBytes.toString('base64'),
    publicKeyBase64: pubBytes.toString('base64'),
    privateKeyHex: privBytes.toString('hex'),
    publicKeyHex: pubBytes.toString('hex'),
    presharedKeyBase64: pskBytes.toString('base64'),
    presharedKeyHex: pskBytes.toString('hex'),
    nodeId
  };
}

/**
 * Builds standard WireGuard .conf file string.
 */
function buildWireGuardConfig({
  deviceName = 'Sovereign-Client',
  role = 'CLIENT_ORIGIN',
  privateKeyBase64,
  overlayIpv4,
  overlayIpv6,
  serverPublicKey,
  presharedKeyBase64,
  serverEndpoint,
  dns = '100.64.0.1, 1.1.1.1',
  allowedIps = '100.64.0.0/10, fd7a:115c:a1e0::/64',
  onionRoutingEnabled = false,
  onionHops = 0
}) {
  const endpoint = serverEndpoint || config.SERVER_ENDPOINT || 'relay-us.neronet.darknero.com:51820';
  const serverPub = serverPublicKey || config.SERVER_PUBKEY || 'NeroNetServerMasterPublicKeyBase64Placeholder=';
  const pskLine = presharedKeyBase64 ? `\nPresharedKey = ${presharedKeyBase64}` : '';
  const isOnion = Boolean(onionRoutingEnabled || onionHops > 0);

  return `# =========================================================
# NeroNet Sovereign Mesh DirectFrame v4.0 WireGuard Profile
# Device: ${deviceName}
# Role: ${role}
# Onion Obfuscation: ${isOnion ? '3-Hop Multi-Route' : 'Direct (0-Hop)'}
# =========================================================

[Interface]
PrivateKey = ${privateKeyBase64}
Address = ${overlayIpv4}/32, ${overlayIpv6}/128
DNS = ${dns}

[Peer]
PublicKey = ${serverPub}${pskLine}
Endpoint = ${endpoint}
AllowedIPs = ${allowedIps}
PersistentKeepalive = 25
`;
}

/**
 * Builds NeroNet Noise DirectFrame v4.0 JSON profile.
 */
function buildNoiseJsonProfile({
  nodeId,
  privateKeyHex,
  publicKeyHex,
  overlayIpv4,
  overlayIpv6,
  presharedKeyHex,
  role = 'CLIENT_ORIGIN',
  countryCode = 'US',
  authToken,
  onionHops,
  onionRoutingEnabled
}) {
  let hops = 0;
  if (onionHops !== undefined) {
    hops = Number(onionHops);
  } else if (onionRoutingEnabled !== undefined) {
    hops = onionRoutingEnabled ? 3 : 0;
  }

  return {
    version: '4.0',
    node_id: nodeId,
    network_name: 'NeroNet Sovereign Mesh',
    identity: {
      private_key_hex: privateKeyHex,
      public_key_hex: publicKeyHex,
      overlay_ipv4: overlayIpv4,
      overlay_ipv6: overlayIpv6
    },
    control_plane: {
      url: config.CONTROL_PLANE_URL || 'https://neronet.darknero.com/v4/control',
      auth_token: authToken || `svrn-tok-${crypto.randomBytes(16).toString('hex')}`
    },
    crypto: {
      suite: 'Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s',
      curve: 'Curve25519',
      cipher: 'ChaCha20-Poly1305',
      hash: 'BLAKE2s',
      psk_hex: presharedKeyHex,
      rekey_interval_sec: 3600
    },
    relays: [
      {
        relay_id: 'relay-oci-us-ashburn',
        hostname: 'relay-us.neronet.darknero.com',
        region: 'us-ashburn-1',
        tcp_port: 443,
        udp_port: 3478,
        supports_http3: true
      },
      {
        relay_id: 'relay-hetzner-eu-fsn',
        hostname: 'relay-eu.neronet.darknero.com',
        region: 'eu-central-1',
        tcp_port: 443,
        udp_port: 3478,
        supports_http3: true
      },
      {
        relay_id: 'relay-oci-ap-tokyo',
        hostname: 'relay-ap.neronet.darknero.com',
        region: 'ap-tokyo-1',
        tcp_port: 443,
        udp_port: 3478,
        supports_http3: true
      }
    ],
    routing: {
      egress_mode: role || 'CLIENT_ORIGIN',
      preferred_countries: countryCode ? [countryCode, 'US', 'DE'] : ['US', 'DE', 'CH'],
      onion_hops: hops,
      onion_routing_enabled: hops > 0
    }
  };
}

/**
 * Renders text into a high-density PNG Data URL QR code.
 */
async function generateQrCodeDataUrl(text) {
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
  } catch (err) {
    const encoded = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="100%" height="100%" fill="#fff"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#000" font-family="monospace" font-size="12">QR_CODE_DATA_PLACEHOLDER</text></svg>`
    ).toString('base64');
    return `data:image/svg+xml;base64,${encoded}`;
  }
}

function allocateVipFromRows(existingVips = []) {
  const usedIpv4 = new Set(existingVips.map(r => r.overlay_ipv4 ? r.overlay_ipv4.trim() : null).filter(Boolean));
  const usedIpv6 = new Set(existingVips.map(r => r.overlay_ipv6 ? r.overlay_ipv6.trim().toLowerCase() : null).filter(Boolean));

  let offset = 1;
  while (offset < 4194300) {
    const o2 = 64 + Math.floor(offset / 65536);
    const o3 = Math.floor((offset % 65536) / 256);
    const o4 = offset % 256;

    if (o4 === 0 || o4 === 255) {
      offset++;
      continue;
    }

    if (o2 >= 128) {
      break;
    }

    const overlayIpv4 = `100.${o2}.${o3}.${o4}`;
    const overlayIpv6 = `fd7a:115c:a1e0::${offset.toString(16).toLowerCase()}`;

    if (!usedIpv4.has(overlayIpv4) && !usedIpv6.has(overlayIpv6)) {
      return { overlayIpv4, overlayIpv6 };
    }
    offset++;
  }

  // Pool exhausted. Returning a random address here handed out a VIP that was very
  // likely already assigned -- and overlay_ipv4 and overlay_ipv6 are both UNIQUE, so
  // the caller got an opaque constraint violation instead of a clear failure. Nothing
  // useful can be allocated at this point; say so.
  const err = new Error('overlay VIP pool exhausted: no free address in 100.64.0.0/10');
  err.status = 503;
  throw err;
}

/** Map an allocation offset onto the overlay address pair it represents. */
function vipFromOffset(offset) {
  const o2 = 64 + Math.floor(offset / 65536);
  const o3 = Math.floor((offset % 65536) / 256);
  const o4 = offset % 256;

  return {
    usable: o4 !== 0 && o4 !== 255 && o2 < 128,
    exhausted: o2 >= 128,
    overlayIpv4: `100.${o2}.${o3}.${o4}`,
    overlayIpv6: `fd7a:115c:a1e0::${offset.toString(16).toLowerCase()}`
  };
}

// A counter value can be unusable (.0 / .255 are network and broadcast) or already
// assigned to a node that did not come through this allocator. Both are skipped.
const MAX_OFFSET_PROBES = 256;

/** Is either half of this address pair already assigned? One indexed probe. */
async function isVipTaken(dbOrPool, isPool, candidate) {
  if (isPool) {
    const res = await dbOrPool.query(
      'SELECT 1 FROM nodes WHERE overlay_ipv4 = $1 OR overlay_ipv6 = $2 LIMIT 1',
      [candidate.overlayIpv4, candidate.overlayIpv6]
    );
    return res.rowCount > 0;
  }

  const row = dbOrPool
    .prepare('SELECT 1 AS hit FROM nodes WHERE overlay_ipv4 = ? OR overlay_ipv6 = ? LIMIT 1')
    .get(candidate.overlayIpv4, candidate.overlayIpv6);

  return Boolean(row);
}

/**
 * Allocate the next overlay address pair.
 *
 * Backed by a database counter -- a PostgreSQL sequence, or a single-row table in
 * SQLite -- rather than by reading the nodes table and scanning for a gap. The scan
 * cost 71 ms of blocking CPU per registration at 100,000 nodes on a single-threaded
 * runtime, and two concurrent callers could read the same set of used addresses and
 * choose the same one.
 */
async function allocateNextVip(dbOrPool) {
  if (!dbOrPool) {
    return allocateVipFromRows([]);
  }

  const isPool = typeof dbOrPool.query === 'function' && typeof dbOrPool.prepare !== 'function';

  for (let probe = 0; probe < MAX_OFFSET_PROBES; probe++) {
    let offset;

    if (isPool) {
      // nextval is atomic and never blocks another caller, which is the whole point.
      const res = await dbOrPool.query("SELECT nextval('overlay_vip_seq')::bigint AS offset");
      offset = Number(res.rows[0].offset);
    } else if (typeof dbOrPool.prepare === 'function') {
      offset = dbOrPool.transaction(() => {
        const row = dbOrPool.prepare('SELECT next_offset FROM vip_allocator WHERE id = 1').get();
        const current = row ? row.next_offset : 1;
        dbOrPool.prepare('UPDATE vip_allocator SET next_offset = ? WHERE id = 1').run(current + 1);
        return current;
      })();
    } else {
      return allocateVipFromRows([]);
    }

    const candidate = vipFromOffset(offset);

    if (candidate.exhausted) {
      const err = new Error('overlay VIP pool exhausted: no free address in 100.64.0.0/10');
      err.status = 503;
      throw err;
    }

    if (!candidate.usable) {
      continue;
    }

    // One indexed lookup, not a scan. The counter alone is not sufficient: seed data
    // and imported nodes get addresses without going through it, and the counter is
    // positioned at migration time, before any of that exists. Both overlay columns
    // are UNIQUE, so an unchecked collision surfaces as a constraint violation the
    // caller cannot act on. This costs a single index probe and makes the allocator
    // correct regardless of how an address came to be in use.
    const taken = await isVipTaken(dbOrPool, isPool, candidate);
    if (!taken) {
      return { overlayIpv4: candidate.overlayIpv4, overlayIpv6: candidate.overlayIpv6 };
    }
  }

  const err = new Error('overlay VIP allocator could not find a usable address');
  err.status = 500;
  throw err;
}

module.exports = {
  vipFromOffset,
  generateCurve25519Keypair,
  buildWireGuardConfig,
  buildNoiseJsonProfile,
  generateQrCodeDataUrl,
  allocateNextVip,
  allocateVipFromRows
};
