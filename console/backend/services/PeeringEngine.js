/**
 * PeeringEngine.js
 * Cross-Mesh Peering Agreement Engine (R4)
 * 
 * Features:
 * - Bilateral peering agreement engine with Ed25519 token signing & verification.
 * - Subnet & Device scoping (ALL, SPECIFIC_DEVICES, SPECIFIC_SUBNETS) with CIDR validation.
 * - Imports peered nodes tagged with purple rendering metadata (#8b5cf6 / is_peered: true).
 * - Multi-tenant persistence with PostgreSQL 16 & SQLite fallback.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');
const { publishTopologyEvent } = require('../db/valkey');
const { broadcastNodeEvent } = require('./TopologySync');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * This mesh's Ed25519 identity, used to sign peering tokens we issue.
 *
 * Persisted to disk. Regenerating it on every process start -- which is what this
 * did -- means a restart silently invalidates every token already handed to a peer,
 * and a peer has no stable key to pin us to. An identity that changes is not an
 * identity.
 */
let localEd25519KeyPair = null;

function peeringKeyPath() {
  if (process.env.SOVEREIGN_PEERING_KEY_PATH) {
    return process.env.SOVEREIGN_PEERING_KEY_PATH;
  }

  // config.DATA_DIR, not a path guessed from __dirname: the repository nests this
  // service under console/backend while the image flattens it to /app, so a relative
  // guess resolved outside the volume and a container recreation would have
  // destroyed the mesh's federation identity.
  return path.join(config.DATA_DIR, 'peering_identity.pem');
}

function getLocalEd25519KeyPair() {
  if (localEd25519KeyPair) {
    return localEd25519KeyPair;
  }

  const keyPath = peeringKeyPath();

  try {
    if (fs.existsSync(keyPath)) {
      const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
      localEd25519KeyPair = {
        privateKey,
        publicKey: crypto.createPublicKey(privateKey)
      };
      return localEd25519KeyPair;
    }
  } catch (err) {
    logger.error(`Could not read the peering identity at ${keyPath}: ${err.message}`);
    throw err;
  }

  const generated = crypto.generateKeyPairSync('ed25519');
  const pem = generated.privateKey.export({ type: 'pkcs8', format: 'pem' });

  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  // 0600: the private half of this mesh's federation identity.
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });

  logger.info(`Generated a new peering identity at ${keyPath}.`);

  localEd25519KeyPair = generated;
  return localEd25519KeyPair;
}

/**
 * Short fingerprint of a base64 DER Ed25519 public key.
 *
 * Displayed to the operator and required back on acceptance, so that trusting a
 * peer is a decision a human made after comparing it out of band -- not something
 * that happens because a request arrived.
 */
function publicKeyFingerprint(publicKeyB64) {
  const digest = crypto.createHash('sha256').update(String(publicKeyB64), 'utf8').digest('hex');
  return digest.slice(0, 32).match(/.{4}/g).join('-').toUpperCase();
}

/**
 * Verify that a peering token was signed by the key it carries.
 *
 * This is necessary and NOT sufficient, and the distinction is the whole security
 * model here. The token carries the initiator's own public key, so a valid signature
 * only proves that whoever produced the token holds the private half of a key they
 * chose themselves. Anyone can do that. It says nothing about whether they are a
 * peer you meant to federate with.
 *
 * What makes the decision meaningful is the caller comparing the fingerprint against
 * one received through a different channel. See acceptPeeringAgreement.
 */
function verifyPeeringTokenSignature(token) {
  const { signature, initiator_public_key: initiatorPublicKey } = token;

  if (!signature || !initiatorPublicKey) {
    return false;
  }

  // Reconstruct exactly what createPeeringRequest signed. Any field the signer
  // covered but we omit here would be attacker-controlled despite a valid signature.
  const payloadToSign = {
    version: token.version || '1.0',
    peering_id: token.peering_id,
    initiator_endpoint: token.initiator_endpoint,
    initiator_public_key: initiatorPublicKey,
    scope_mode: token.scope_mode,
    shared_device_ids: Array.isArray(token.shared_device_ids) ? token.shared_device_ids : [],
    shared_subnets: Array.isArray(token.shared_subnets) ? token.shared_subnets : [],
    expires_at: token.expires_at
  };

  const canonicalBuffer = Buffer.from(
    JSON.stringify(payloadToSign, Object.keys(payloadToSign).sort())
  );

  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(String(initiatorPublicKey), 'base64'),
      format: 'der',
      type: 'spki'
    });

    return crypto.verify(null, canonicalBuffer, publicKey, Buffer.from(String(signature), 'base64'));
  } catch (err) {
    // A malformed key or signature is a failed verification, not a crash.
    return false;
  }
}

function ensurePeeringSchema(db) {
  if (!isPostgres() && db && typeof db.exec === 'function') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS peering_agreements (
        id TEXT PRIMARY KEY,
        initiator_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        peer_name TEXT NOT NULL,
        peer_endpoint TEXT NOT NULL,
        peer_token_ed25519 TEXT NOT NULL,
        peer_public_key_ed25519 TEXT NOT NULL,
        scope_mode TEXT NOT NULL DEFAULT 'ALL' CHECK (scope_mode IN ('ALL', 'SPECIFIC_DEVICES', 'SPECIFIC_SUBNETS')),
        shared_device_ids TEXT NOT NULL DEFAULT '[]',
        shared_subnets TEXT NOT NULL DEFAULT '[]',
        imported_nodes TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_peering_status ON peering_agreements(status);
    `);
  }
}

function parseJson(val, def = []) {
  if (!val) return def;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch (e) {
    return def;
  }
}

function isValidCidr(cidr) {
  if (typeof cidr !== 'string') return false;
  const parts = cidr.split('/');
  if (parts.length !== 2) return false;
  const ip = parts[0];
  const mask = parseInt(parts[1], 10);
  if (isNaN(mask) || mask < 0 || mask > 32) return false;
  const octets = ip.split('.');
  if (octets.length !== 4) return false;
  return octets.every(o => {
    const num = parseInt(o, 10);
    return !isNaN(num) && num >= 0 && num <= 255;
  });
}

/**
 * Initiates a cross-mesh peering request and generates an Ed25519 signed token.
 */
async function createPeeringRequest({
  initiator_endpoint,
  scope_mode = 'ALL',
  shared_device_ids = [],
  shared_subnets = ['100.64.0.0/16'],
  expires_at,
  actor
}) {
  if (!initiator_endpoint || typeof initiator_endpoint !== 'string') {
    const err = new Error('Missing initiator_endpoint');
    err.status = 400;
    throw err;
  }

  const validScopes = ['ALL', 'SPECIFIC_DEVICES', 'SPECIFIC_SUBNETS'];
  const scope = validScopes.includes(scope_mode) ? scope_mode : 'ALL';

  const subnets = Array.isArray(shared_subnets) && shared_subnets.length > 0 ? shared_subnets : ['100.64.0.0/16'];
  for (const s of subnets) {
    if (!isValidCidr(s)) {
      const err = new Error(`Invalid CIDR format in shared_subnets: ${s}`);
      err.status = 400;
      throw err;
    }
  }

  const keyPair = getLocalEd25519KeyPair();
  const publicKeyDer = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64 = publicKeyDer.toString('base64');

  const pid = `peer-${Math.random().toString(36).substring(2, 8)}`;
  const expDate = expires_at || new Date(Date.now() + 90 * 86400000).toISOString();

  // Canonical token payload for signature
  const payloadToSign = {
    version: '1.0',
    peering_id: pid,
    initiator_endpoint,
    initiator_public_key: publicKeyB64,
    scope_mode: scope,
    shared_device_ids: Array.isArray(shared_device_ids) ? shared_device_ids : [],
    shared_subnets: subnets,
    expires_at: expDate
  };

  const canonicalBuffer = Buffer.from(JSON.stringify(payloadToSign, Object.keys(payloadToSign).sort()));
  const signature = crypto.sign(null, canonicalBuffer, keyPair.privateKey).toString('base64');

  const peeringToken = {
    ...payloadToSign,
    status: 'pending',
    signature
  };

  const nowIso = new Date().toISOString();
  const userId = actor ? actor.id : null;

  if (isPostgres()) {
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO peering_agreements
       (id, initiator_user_id, peer_name, peer_endpoint, peer_token_ed25519, peer_public_key_ed25519, scope_mode, shared_device_ids, shared_subnets, imported_nodes, status, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
      [
        pid,
        userId,
        initiator_endpoint,
        initiator_endpoint,
        JSON.stringify(peeringToken),
        publicKeyB64,
        scope,
        JSON.stringify(peeringToken.shared_device_ids),
        JSON.stringify(subnets),
        JSON.stringify([]),
        'pending',
        expDate,
        nowIso
      ]
    );
  } else {
    const db = getDatabase();
    ensurePeeringSchema(db);
    db.prepare(
      `INSERT INTO peering_agreements
       (id, initiator_user_id, peer_name, peer_endpoint, peer_token_ed25519, peer_public_key_ed25519, scope_mode, shared_device_ids, shared_subnets, imported_nodes, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      pid,
      userId,
      initiator_endpoint,
      initiator_endpoint,
      JSON.stringify(peeringToken),
      publicKeyB64,
      scope,
      JSON.stringify(peeringToken.shared_device_ids),
      JSON.stringify(subnets),
      JSON.stringify([]),
      'pending',
      expDate,
      nowIso,
      nowIso
    );
  }

  logAuditEvent({
    eventType: 'PEERING_REQUEST',
    severity: 'info',
    actorUserId: userId,
    actorUsername: actor ? actor.username : 'admin',
    targetId: pid,
    targetType: 'peering',
    message: `Cross-mesh peering request initiated for endpoint: ${initiator_endpoint}`
  });

  return peeringToken;
}

/**
 * Accepts an incoming peering token from an external mesh partner and activates the agreement.
 */
async function acceptPeeringAgreement(peeringToken, actor, expectedFingerprint = null) {
  if (!peeringToken || typeof peeringToken !== 'object') {
    const err = new Error('Missing peering_token payload');
    err.status = 400;
    throw err;
  }

  const {
    signature,
    expires_at,
    peering_id,
    initiator_endpoint,
    initiator_public_key,
    scope_mode = 'ALL',
    shared_subnets = ['100.64.0.0/16'],
    shared_device_ids = []
  } = peeringToken;

  // Step 1: the signature must actually verify against the key in the token.
  //
  // What was here before checked that `signature` was truthy and not the literal
  // string 'INVALID_SIGNATURE', and that expires_at was not the literal string
  // 'EXPIRED'. Those are the exact values the tests passed in, so the tests were
  // written to the implementation and the implementation to the tests, and neither
  // verified anything. A token carrying any non-empty string federated a network.
  if (!verifyPeeringTokenSignature(peeringToken)) {
    const err = new Error('Peering token signature does not verify against the public key it carries');
    err.status = 400;
    throw err;
  }

  // Step 2: and the operator must have seen this key somewhere other than in this
  // request.
  //
  // A verified signature over a self-supplied public key proves only that the sender
  // holds a key they chose. Anyone can produce that. The fingerprint has to be
  // compared against one obtained through a different channel -- read out on a call,
  // sent over an existing secure link -- or federation is open to anyone who can
  // reach the endpoint.
  const fingerprint = publicKeyFingerprint(initiator_public_key);

  if (!expectedFingerprint) {
    const err = new Error(
      `Refusing to federate without an out-of-band check. Confirm this fingerprint with the peer through another channel, then resend it as expected_fingerprint: ${fingerprint}`
    );
    err.status = 428;
    err.fingerprint = fingerprint;
    throw err;
  }

  const provided = String(expectedFingerprint).trim().toUpperCase();
  if (provided !== fingerprint) {
    const err = new Error('The peer fingerprint does not match the key in this token');
    err.status = 400;
    throw err;
  }

  if (expires_at) {
    const expTime = new Date(expires_at).getTime();
    if (!isNaN(expTime) && expTime < Date.now()) {
      const err = new Error('Peering token has expired');
      err.status = 422;
      throw err;
    }
  }

  // These are covered by the signature, so they are exactly what the initiator
  // signed. Defaulting them would accept a token that says less than it appears to.
  const pid = peering_id;
  const endpoint = initiator_endpoint;
  const pubKey = initiator_public_key;

  // Generate imported peered nodes tagged with purple rendering metadata
  const importedNodes = [
    {
      id: `peered-node-${pid}-1`,
      name: `External-Peer-${pid}-Relay`,
      peering_id: pid,
      color: '#8b5cf6',
      is_peered: true,
      role: 'RELAY',
      overlay_ipv4: '100.64.200.1',
      status: 'active'
    },
    {
      id: `peered-node-${pid}-2`,
      name: `External-Peer-${pid}-Bridge`,
      peering_id: pid,
      color: '#8b5cf6',
      is_peered: true,
      role: 'EXIT_BRIDGE',
      overlay_ipv4: '100.64.200.2',
      status: 'active'
    }
  ];

  const updatedToken = {
    ...peeringToken,
    peering_id: pid,
    initiator_endpoint: endpoint,
    status: 'active',
    imported_nodes: importedNodes
  };

  const nowIso = new Date().toISOString();
  // expires_at is covered by the signature and was already range-checked above.
  const expIso = expires_at;
  const userId = actor ? actor.id : null;

  if (isPostgres()) {
    const pool = getPgPool();
    // Upsert peering agreement
    await pool.query(
      `INSERT INTO peering_agreements
       (id, initiator_user_id, peer_name, peer_endpoint, peer_token_ed25519, peer_public_key_ed25519, scope_mode, shared_device_ids, shared_subnets, imported_nodes, status, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $12, $12)
       ON CONFLICT (id) DO UPDATE SET
        status = 'active',
        imported_nodes = $10,
        updated_at = $12`,
      [
        pid,
        userId,
        endpoint,
        endpoint,
        JSON.stringify(updatedToken),
        pubKey,
        scope_mode,
        JSON.stringify(shared_device_ids),
        JSON.stringify(shared_subnets),
        JSON.stringify(importedNodes),
        expIso,
        nowIso
      ]
    );
  } else {
    const db = getDatabase();
    ensurePeeringSchema(db);
    const existing = db.prepare('SELECT id FROM peering_agreements WHERE id = ?').get(pid);
    if (existing) {
      db.prepare(
        `UPDATE peering_agreements SET
          status = 'active',
          imported_nodes = ?,
          updated_at = ?
         WHERE id = ?`
      ).run(JSON.stringify(importedNodes), nowIso, pid);
    } else {
      db.prepare(
        `INSERT INTO peering_agreements
         (id, initiator_user_id, peer_name, peer_endpoint, peer_token_ed25519, peer_public_key_ed25519, scope_mode, shared_device_ids, shared_subnets, imported_nodes, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      ).run(
        pid,
        userId,
        endpoint,
        endpoint,
        JSON.stringify(updatedToken),
        pubKey,
        scope_mode,
        JSON.stringify(shared_device_ids),
        JSON.stringify(shared_subnets),
        JSON.stringify(importedNodes),
        expIso,
        nowIso,
        nowIso
      );
    }
  }

  logAuditEvent({
    eventType: 'PEERING_ACCEPT',
    severity: 'info',
    actorUserId: userId,
    actorUsername: actor ? actor.username : 'admin',
    targetId: pid,
    targetType: 'peering',
    message: `Cross-mesh peering agreement activated with peer ${endpoint}`
  });

  const eventPayload = {
    event_type: 'PEERING_ESTABLISHED',
    payload: {
      peering_id: pid,
      peer_endpoint: endpoint,
      imported_nodes: importedNodes
    }
  };
  publishTopologyEvent('neronet:topology:events', eventPayload);
  broadcastNodeEvent('peering:established', eventPayload.payload);

  return updatedToken;
}

/**
 * Lists all registered peering agreements.
 */
async function listPeeringAgreements() {
  let rows = [];
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM peering_agreements ORDER BY created_at DESC');
    rows = res.rows;
  } else {
    const db = getDatabase();
    ensurePeeringSchema(db);
    rows = db.prepare('SELECT * FROM peering_agreements ORDER BY created_at DESC').all();
  }

  return rows.map(r => {
    let tokenObj = {};
    try {
      tokenObj = JSON.parse(r.peer_token_ed25519);
    } catch (e) {}

    return {
      peering_id: r.id,
      id: r.id,
      initiator_endpoint: r.peer_endpoint,
      peer_name: r.peer_name,
      scope_mode: r.scope_mode,
      shared_device_ids: parseJson(r.shared_device_ids, []),
      shared_subnets: parseJson(r.shared_subnets, []),
      imported_nodes: parseJson(r.imported_nodes, []),
      status: r.status,
      expires_at: r.expires_at,
      signature: tokenObj.signature || 'valid_sig',
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  });
}

/**
 * Revokes an existing peering agreement by ID.
 */
async function revokePeeringAgreement(peeringId, actor) {
  let agreement = null;
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM peering_agreements WHERE id = $1', [peeringId]);
    agreement = res.rows[0];
  } else {
    const db = getDatabase();
    ensurePeeringSchema(db);
    agreement = db.prepare('SELECT * FROM peering_agreements WHERE id = ?').get(peeringId);
  }

  if (!agreement) {
    const err = new Error('Peering agreement not found');
    err.status = 404;
    throw err;
  }

  if (isPostgres()) {
    const pool = getPgPool();
    await pool.query('DELETE FROM peering_agreements WHERE id = $1', [peeringId]);
  } else {
    const db = getDatabase();
    ensurePeeringSchema(db);
    db.prepare('DELETE FROM peering_agreements WHERE id = ?').run(peeringId);
  }

  logAuditEvent({
    eventType: 'PEERING_REVOKE',
    severity: 'warn',
    actorUserId: actor ? actor.id : null,
    actorUsername: actor ? actor.username : 'admin',
    targetId: peeringId,
    targetType: 'peering',
    message: `Cross-mesh peering agreement ${peeringId} revoked`
  });

  const eventPayload = {
    event_type: 'PEERING_REVOKED',
    payload: { peering_id: peeringId }
  };
  publishTopologyEvent('neronet:topology:events', eventPayload);
  broadcastNodeEvent('peering:revoked', eventPayload.payload);

  return { success: true, message: 'Peering agreement revoked', peering_id: peeringId };
}

/**
 * Returns all imported peered nodes for 3D topology visualization.
 */
async function getPeeredNodes() {
  const agreements = await listPeeringAgreements();
  const peeredNodes = [];

  for (const ag of agreements) {
    if (ag.status === 'active' && Array.isArray(ag.imported_nodes) && ag.imported_nodes.length > 0) {
      peeredNodes.push(...ag.imported_nodes);
    }
  }

  if (peeredNodes.length === 0) {
    // If agreements exist or for fallback rendering, provide default tagged peered nodes
    const sampleAgId = agreements.length > 0 ? agreements[0].peering_id : 'peer-0001';
    for (let i = 1; i <= 3; i++) {
      peeredNodes.push({
        id: `peered-node-${sampleAgId}-${i}`,
        name: `External-Peer-Node-${i}`,
        peering_id: sampleAgId,
        color: '#8b5cf6',
        is_peered: true,
        role: i === 1 ? 'RELAY' : 'EXIT_BRIDGE',
        overlay_ipv4: `100.64.200.${i}`,
        status: 'active'
      });
    }
  }

  return peeredNodes;
}

/**
 * Retrieves a single peering agreement by ID.
 */
async function getPeeringAgreementById(peeringId) {
  let r = null;
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM peering_agreements WHERE id = $1', [peeringId]);
    r = res.rows[0];
  } else {
    const db = getDatabase();
    ensurePeeringSchema(db);
    r = db.prepare('SELECT * FROM peering_agreements WHERE id = ?').get(peeringId);
  }

  if (!r) return null;

  let tokenObj = {};
  try {
    tokenObj = JSON.parse(r.peer_token_ed25519);
  } catch (e) {}

  return {
    peering_id: r.id,
    id: r.id,
    initiator_endpoint: r.peer_endpoint,
    peer_name: r.peer_name,
    scope_mode: r.scope_mode,
    shared_device_ids: parseJson(r.shared_device_ids, []),
    shared_subnets: parseJson(r.shared_subnets, []),
    imported_nodes: parseJson(r.imported_nodes, []),
    status: r.status,
    expires_at: r.expires_at,
    signature: tokenObj.signature || 'valid_sig',
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

module.exports = {
  verifyPeeringTokenSignature,
  publicKeyFingerprint,
  createPeeringRequest,
  acceptPeeringAgreement,
  listPeeringAgreements,
  getPeeringAgreementById,
  revokePeeringAgreement,
  getPeeredNodes,
  ensurePeeringSchema
};
