/**
 * Control Plane Identity & Cryptographic Challenge Service.
 *
 * Implements ADR 0017 (Node Identity v2):
 * - Static X25519 Control Plane Identity keypair & fingerprint
 * - Challenge nonce generation with 90s TTL (Valkey / memory store)
 * - Single-use atomic nonce consumption (anti-replay)
 * - Proof of possession verification via Diffie-Hellman + HKDF + HMAC-SHA256
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { getValkeyClient, NAMESPACE } = require('../db/valkey');

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

let cachedKeypair = null;
const memoryChallengeStore = new Map();

function rawPrivateToKeyObject(rawBuffer) {
  return crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, rawBuffer]),
    format: 'der',
    type: 'pkcs8'
  });
}

function rawPublicToKeyObject(rawBuffer) {
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, rawBuffer]),
    format: 'der',
    type: 'spki'
  });
}

/**
 * Loads or initializes the static Control Plane X25519 keypair.
 */
function getControlPlaneKeypair() {
  if (cachedKeypair) {
    return cachedKeypair;
  }

  const envKey = process.env.SOVEREIGN_CONTROL_PLANE_KEY || process.env.SOVEREIGN_CONTROL_PLANE_PRIVATE_KEY;
  if (envKey && /^[0-9a-f]{64}$/i.test(envKey.trim())) {
    const rawPriv = Buffer.from(envKey.trim(), 'hex');
    const privObj = rawPrivateToKeyObject(rawPriv);
    const pubObj = crypto.createPublicKey(privObj);
    const pubDer = pubObj.export({ type: 'spki', format: 'der' });
    const rawPub = Buffer.from(pubDer.subarray(pubDer.length - 32));

    const fingerprint = crypto.createHash('sha256').update(rawPub).digest('hex');
    cachedKeypair = {
      privateKeyObject: privObj,
      publicKeyObject: pubObj,
      rawPrivate: rawPriv,
      rawPublic: rawPub,
      privateKeyHex: rawPriv.toString('hex'),
      publicKeyHex: rawPub.toString('hex'),
      fingerprint
    };
    return cachedKeypair;
  }

  // Resolve file location
  const dataDir = process.env.SOVEREIGN_DATA_DIR || path.resolve(__dirname, '../../data');
  if (!fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (e) {
      // Ignore if exists
    }
  }

  const keyFilePath = path.join(dataDir, 'control_plane_x25519.key');

  if (fs.existsSync(keyFilePath)) {
    try {
      const content = fs.readFileSync(keyFilePath, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(content)) {
        const rawPriv = Buffer.from(content, 'hex');
        const privObj = rawPrivateToKeyObject(rawPriv);
        const pubObj = crypto.createPublicKey(privObj);
        const pubDer = pubObj.export({ type: 'spki', format: 'der' });
        const rawPub = Buffer.from(pubDer.subarray(pubDer.length - 32));
        const fingerprint = crypto.createHash('sha256').update(rawPub).digest('hex');

        cachedKeypair = {
          privateKeyObject: privObj,
          publicKeyObject: pubObj,
          rawPrivate: rawPriv,
          rawPublic: rawPub,
          privateKeyHex: rawPriv.toString('hex'),
          publicKeyHex: rawPub.toString('hex'),
          fingerprint
        };
        return cachedKeypair;
      }
    } catch (err) {
      logger.warn(`Failed reading control plane key at ${keyFilePath}: ${err.message}`);
    }
  }

  // Generate a fresh static X25519 keypair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });

  const rawPriv = Buffer.from(privDer.subarray(privDer.length - 32));
  const rawPub = Buffer.from(pubDer.subarray(pubDer.length - 32));
  const fingerprint = crypto.createHash('sha256').update(rawPub).digest('hex');

  try {
    fs.writeFileSync(keyFilePath, rawPriv.toString('hex'), { mode: 0o600 });
  } catch (err) {
    logger.warn(`Could not persist control plane key to ${keyFilePath}: ${err.message}`);
  }

  cachedKeypair = {
    privateKeyObject: privateKey,
    publicKeyObject: publicKey,
    rawPrivate: rawPriv,
    rawPublic: rawPub,
    privateKeyHex: rawPriv.toString('hex'),
    publicKeyHex: rawPub.toString('hex'),
    fingerprint
  };

  return cachedKeypair;
}

function getControlPlanePublicKey() {
  return getControlPlaneKeypair().publicKeyHex;
}

function getControlPlaneFingerprint() {
  return getControlPlaneKeypair().fingerprint;
}

/**
 * Generates an ephemeral challenge nonce with 90s TTL.
 */
async function createChallenge() {
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAtMs = Date.now() + 90 * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const valkey = getValkeyClient();
  const key = `${NAMESPACE ? `${NAMESPACE}:` : ''}challenge:${nonce}`;

  if (valkey) {
    try {
      await valkey.set(key, '1', 'EX', 90);
    } catch (err) {
      logger.warn(`Valkey set challenge failed: ${err.message}`);
      memoryChallengeStore.set(nonce, expiresAtMs);
    }
  } else {
    memoryChallengeStore.set(nonce, expiresAtMs);
  }

  return {
    nonce,
    cp_public_key: getControlPlanePublicKey(),
    expires_at: expiresAt
  };
}

/**
 * Validates and atomically consumes a challenge nonce (single-use anti-replay).
 */
async function consumeChallenge(nonce) {
  if (!nonce || typeof nonce !== 'string' || !/^[0-9a-f]{64}$/i.test(nonce.trim())) {
    return false;
  }
  const cleanNonce = nonce.trim().toLowerCase();

  const valkey = getValkeyClient();
  const key = `${NAMESPACE ? `${NAMESPACE}:` : ''}challenge:${cleanNonce}`;

  if (valkey) {
    try {
      const deleted = await valkey.del(key);
      if (deleted === 1) {
        return true;
      }
    } catch (err) {
      logger.warn(`Valkey del challenge failed: ${err.message}`);
    }
  }

  if (memoryChallengeStore.has(cleanNonce)) {
    const expiry = memoryChallengeStore.get(cleanNonce);
    memoryChallengeStore.delete(cleanNonce);
    if (Date.now() <= expiry) {
      return true;
    }
  }

  return false;
}

/**
 * Verifies proof of possession for a given node public key and nonce.
 *
 * Formula:
 * proof = HMAC-SHA256(HKDF-SHA256(X25519(cp_priv, node_pub), info="neronet/v4/register"), nonce || node_pub)
 */
function verifyProof(nodePublicKeyHex, nonceHex, proofHex) {
  if (!nodePublicKeyHex || !nonceHex || !proofHex) {
    return false;
  }
  if (
    !/^[0-9a-f]{64}$/i.test(nodePublicKeyHex.trim()) ||
    !/^[0-9a-f]{64}$/i.test(nonceHex.trim()) ||
    !/^[0-9a-f]{64}$/i.test(proofHex.trim())
  ) {
    return false;
  }

  try {
    const kp = getControlPlaneKeypair();
    const rawNodePub = Buffer.from(nodePublicKeyHex.trim(), 'hex');
    const nodePubObj = rawPublicToKeyObject(rawNodePub);

    const sharedSecret = crypto.diffieHellman({
      privateKey: kp.privateKeyObject,
      publicKey: nodePubObj
    });

    const derivedKey = Buffer.from(
      crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from('neronet/v4/register', 'utf8'), 32)
    );

    const hmac = crypto.createHmac('sha256', derivedKey);
    hmac.update(Buffer.concat([Buffer.from(nonceHex.trim(), 'hex'), rawNodePub]));
    const expectedProof = hmac.digest();
    const actualProof = Buffer.from(proofHex.trim(), 'hex');

    if (expectedProof.length !== actualProof.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedProof, actualProof);
  } catch (err) {
    logger.warn(`Diffie-Hellman proof verification failed: ${err.message}`);
    return false;
  }
}

/**
 * Computes client-side proof (helper for testing and Go client parity).
 */
function computeClientProof(nodePrivateKeyHex, cpPublicKeyHex, nonceHex) {
  const rawNodePriv = Buffer.from(nodePrivateKeyHex.trim(), 'hex');
  const rawCpPub = Buffer.from(cpPublicKeyHex.trim(), 'hex');

  const nodePrivObj = rawPrivateToKeyObject(rawNodePriv);
  const cpPubObj = rawPublicToKeyObject(rawCpPub);

  const sharedSecret = crypto.diffieHellman({
    privateKey: nodePrivObj,
    publicKey: cpPubObj
  });

  const nodePubObj = crypto.createPublicKey(nodePrivObj);
  const nodePubDer = nodePubObj.export({ type: 'spki', format: 'der' });
  const rawNodePub = Buffer.from(nodePubDer.subarray(nodePubDer.length - 32));

  const derivedKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from('neronet/v4/register', 'utf8'), 32)
  );

  const hmac = crypto.createHmac('sha256', derivedKey);
  hmac.update(Buffer.concat([Buffer.from(nonceHex.trim(), 'hex'), rawNodePub]));
  return hmac.digest('hex');
}

module.exports = {
  getControlPlaneKeypair,
  getControlPlanePublicKey,
  getControlPlaneFingerprint,
  createChallenge,
  consumeChallenge,
  verifyProof,
  computeClientProof
};
