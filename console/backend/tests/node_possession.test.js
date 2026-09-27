const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { generateCurve25519Keypair } = require('../utils/crypto');
const ControlPlaneKeyService = require('../services/ControlPlaneKeyService');
const PreAuthKeyService = require('../services/PreAuthKeyService');
const RevocationEngine = require('../services/RevocationEngine');

// Registration with the fleet-wide token took a public key and nothing else. Public
// keys are not secret -- every peer receives them in its netmap -- so anyone holding
// the token could register another node's key, receive a credential minted for that
// node and act as it. The token itself was also accepted on every per-node endpoint,
// so it read any node's netmap and forged any node's heartbeat. A revoked key could
// re-register and come back.

describe('Registration requires possession of the node key', () => {
  let dbHelper;
  let pool;
  let app;
  let savedToken;
  const TOKEN = crypto.randomBytes(24).toString('hex');

  async function challenge() {
    const ch = await request(app).post('/v4/control/challenge').send({});
    assert.strictEqual(ch.status, 200);
    return ch.body;
  }

  async function registerWithProof(kp, { role = 'CLIENT_ORIGIN', proofRole = role, token = TOKEN, preauthKey } = {}) {
    const ch = await challenge();
    const proof = ControlPlaneKeyService.computeClientProof(kp.privateKeyHex, ch.cp_public_key, ch.nonce, proofRole);
    let req = request(app).post('/v4/control/register');
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    return req.send({
      public_key_hex: kp.publicKeyHex,
      role,
      endpoints: [],
      capability: { country_code: 'DE' },
      nonce: ch.nonce,
      proof,
      ...(preauthKey ? { preauth_key: preauthKey } : {})
    });
  }

  let victim;
  let victimCredential;

  before(async () => {
    savedToken = process.env.SOVEREIGN_REGISTRATION_TOKEN;
    process.env.SOVEREIGN_REGISTRATION_TOKEN = TOKEN;
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    victim = generateCurve25519Keypair();
    const reg = await registerWithProof(victim);
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
    victimCredential = reg.body.credential;
    assert.ok(victimCredential && victimCredential.startsWith('nnt1_'));
  });

  after(async () => {
    if (savedToken === undefined) delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
    else process.env.SOVEREIGN_REGISTRATION_TOKEN = savedToken;
    if (dbHelper) await dbHelper.cleanup();
  });

  it("refuses the fleet token alone for another node's public key", async () => {
    const res = await request(app)
      .post('/v4/control/register')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ public_key_hex: victim.publicKeyHex, role: 'CLIENT_ORIGIN', endpoints: [] });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(
      res.body.credential,
      undefined,
      'no credential may be minted for a key the caller does not hold'
    );
  });

  it('refuses a proof made with a different key', async () => {
    const attacker = generateCurve25519Keypair();
    const ch = await challenge();
    const proof = ControlPlaneKeyService.computeClientProof(attacker.privateKeyHex, ch.cp_public_key, ch.nonce);
    const res = await request(app)
      .post('/v4/control/register')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ public_key_hex: victim.publicKeyHex, role: 'CLIENT_ORIGIN', endpoints: [], nonce: ch.nonce, proof });

    assert.strictEqual(res.status, 401);
  });

  it('binds the role to the proof', async () => {
    const node = generateCurve25519Keypair();
    const res = await registerWithProof(node, { role: 'EXIT_BRIDGE', proofRole: 'CLIENT_ORIGIN' });
    assert.strictEqual(res.status, 401);
  });

  it('does not accept the fleet token as a node credential', async () => {
    const victimId = (await pool.query('SELECT id FROM nodes WHERE public_key = $1', [victim.publicKeyHex])).rows[0].id;

    for (const path of [
      '/v4/control/netmap',
      '/v4/control/heartbeat',
      '/v4/control/sync-acls',
      '/v4/control/sync-routes'
    ]) {
      const res = await request(app).post(path).set('Authorization', `Bearer ${TOKEN}`).send({ node_id: victimId });
      assert.strictEqual(res.status, 401, `${path} answered ${res.status} to the fleet token`);
    }

    const own = await request(app)
      .post('/v4/control/heartbeat')
      .set('Authorization', `Bearer ${victimCredential}`)
      .send({ node_id: victimId });
    assert.strictEqual(own.status, 200, JSON.stringify(own.body));
  });

  it('refuses a revoked key', async () => {
    const node = generateCurve25519Keypair();
    const reg = await registerWithProof(node);
    assert.strictEqual(reg.status, 200);

    await RevocationEngine.revokeNodeKeys([reg.body.assigned_node_id], { reason: 'test' });

    const again = await registerWithProof(node);
    assert.strictEqual(again.status, 403);
    assert.strictEqual(again.body.credential, undefined);
  });

  it('lets an enrolled node re-register with its key alone', async () => {
    const admin = (await pool.query("SELECT id FROM users WHERE role = 'super-admin' LIMIT 1")).rows[0].id;
    const pak = await PreAuthKeyService.createPreAuthKey({ ownerId: admin, isReusable: false });
    const node = generateCurve25519Keypair();

    const first = await registerWithProof(node, { token: null, preauthKey: pak.secret });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));

    // The single-use key is spent; the node restarts and proves it holds its key.
    const restart = await registerWithProof(node, { token: null });
    assert.strictEqual(restart.status, 200, JSON.stringify(restart.body));
    assert.strictEqual(restart.body.assigned_node_id, first.body.assigned_node_id);
    assert.strictEqual(restart.body.overlay_ipv4, first.body.overlay_ipv4);
  });

  it('still needs the fleet token or a pre-auth key for a new key', async () => {
    const res = await registerWithProof(generateCurve25519Keypair(), { token: null });
    assert.strictEqual(res.status, 401);
  });
});

// NODEID-3: a nonce kept in one process's memory is single-use in that process only.
describe('Challenge nonces with the store unavailable', () => {
  const config = require('../config/env');
  const valkey = require('../db/valkey');

  it('refuses to issue one in production instead of keeping it in memory', async () => {
    const realGet = valkey.getValkeyClient;
    const savedProd = config.IS_PRODUCTION;
    const failing = { set: async () => Promise.reject(new Error('valkey down')), del: async () => 0 };
    // ControlPlaneKeyService reads the client through the module at call time.
    valkey.getValkeyClient = () => failing;
    config.IS_PRODUCTION = true;
    try {
      await assert.rejects(
        () => ControlPlaneKeyService.createChallenge(),
        (err) => err.status === 503
      );
    } finally {
      valkey.getValkeyClient = realGet;
      config.IS_PRODUCTION = savedProd;
    }
  });
});
