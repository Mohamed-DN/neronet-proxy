const request = require('supertest');
const { generateCurve25519Keypair } = require('../../utils/crypto');
const ControlPlaneKeyService = require('../../services/ControlPlaneKeyService');

// Registration requires proof that the caller holds the node's private key, so the
// suites cannot enrol made-up public keys any more. nodeKey() makes a real key and
// keeps its private half for register().
const privateKeys = new Map();

/** A fresh node public key (hex) whose private half register() can prove. */
function nodeKey() {
  const kp = generateCurve25519Keypair();
  privateKeys.set(kp.publicKeyHex, kp.privateKeyHex);
  return kp.publicKeyHex;
}

/**
 * POST /v4/control/register the way the Go node does: fetch a challenge, prove
 * possession of the key named in `body.public_key_hex`, send. `token`, when given,
 * goes in the Authorization header.
 */
async function register(app, body, { token } = {}) {
  const privateKeyHex = privateKeys.get(String(body.public_key_hex || '').toLowerCase());
  if (!privateKeyHex) {
    throw new Error(`register(): ${body.public_key_hex} was not made with nodeKey()`);
  }
  const ch = await request(app).post('/v4/control/challenge').send({});
  if (ch.status !== 200) throw new Error(`challenge failed: ${ch.status}`);
  const proof = ControlPlaneKeyService.computeClientProof(
    privateKeyHex,
    ch.body.cp_public_key,
    ch.body.nonce,
    body.role || 'CLIENT_ORIGIN'
  );
  let req = request(app).post('/v4/control/register');
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  return req.send({ ...body, nonce: ch.body.nonce, proof });
}

module.exports = { nodeKey, register };
