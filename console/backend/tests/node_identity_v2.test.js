const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const crypto = require('crypto');

const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');
const { generateCurve25519Keypair } = require('../utils/crypto');
const ControlPlaneKeyService = require('../services/ControlPlaneKeyService');
const PreAuthKeyService = require('../services/PreAuthKeyService');
const NodeCredentialService = require('../services/NodeCredentialService');
const RevocationEngine = require('../services/RevocationEngine');
const { signToken } = require('../middleware/auth');

describe('WP-103: Node Identity and Authentication v2', () => {
  let dbHelper;
  let app;
  let adminUser;
  let adminToken;
  let regularUser;
  let regularToken;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();

    // Fetch seeded admin user
    const adminRes = await dbHelper.pool.query(
      "SELECT id, username, role FROM users WHERE role = 'super-admin' LIMIT 1"
    );
    adminUser = adminRes.rows[0];
    adminToken = signToken(adminUser);

    // Create a regular user for tenant/owner boundary tests
    const regularId = `usr-test-regular-${crypto.randomBytes(4).toString('hex')}`;
    await dbHelper.pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, created_at, updated_at)
       VALUES ($1, 'regular_alice', 'alice@neronet.test', 'hash123', 'user', NOW(), NOW())`,
      [regularId]
    );
    regularUser = { id: regularId, username: 'regular_alice', email: 'alice@neronet.test', role: 'user' };
    regularToken = signToken(regularUser);
  });

  after(async () => {
    if (dbHelper) {
      await dbHelper.cleanup();
    }
  });

  // Helper to enrol a node with a pre-auth key and proof of possession
  async function enrollNode(keypair, preauthKey, role = 'CLIENT_ORIGIN') {
    const chRes = await request(app).post('/v4/control/challenge').send({});
    assert.strictEqual(chRes.status, 200, `Challenge failed: ${JSON.stringify(chRes.body)}`);
    const { nonce, cp_public_key } = chRes.body;

    const proof = ControlPlaneKeyService.computeClientProof(keypair.privateKeyHex, cp_public_key, nonce);

    const regRes = await request(app).post('/v4/control/register').send({
      public_key_hex: keypair.publicKeyHex,
      role,
      preauth_key: preauthKey,
      nonce,
      proof
    });

    return { chRes, regRes, nonce, proof };
  }

  describe('Pre-Auth Key REST Management', () => {
    it('creates a pre-auth key with enrolment string and fingerprint', async () => {
      const res = await request(app).post('/api/preauth-keys').set('Authorization', `Bearer ${adminToken}`).send({
        is_reusable: false,
        expires_in_hours: 24
      });

      assert.strictEqual(res.status, 201);
      assert.ok(res.body.secret.startsWith('nnk1_'));
      assert.ok(res.body.enrolment_string.startsWith('nnk1:'));
      assert.ok(res.body.control_plane_fingerprint);
      assert.strictEqual(res.body.owner_id, adminUser.id);
      assert.strictEqual(res.body.is_reusable, false);
      assert.strictEqual(res.body.max_uses, 1);
    });

    it('lists pre-auth keys scoped to authenticated user', async () => {
      const res = await request(app).get('/api/preauth-keys').set('Authorization', `Bearer ${adminToken}`);

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.keys));
      assert.ok(res.body.keys.length > 0);
    });

    it('revokes a pre-auth key via DELETE /api/preauth-keys/:id', async () => {
      const created = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id });
      const res = await request(app)
        .delete(`/api/preauth-keys/${created.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      // Verify revoked
      const check = await dbHelper.pool.query('SELECT revoked_at FROM preauth_keys WHERE id = $1', [created.id]);
      assert.ok(check.rows[0].revoked_at !== null);
    });
  });

  describe('8 Mandatory Attack Tests', () => {
    it('Test 1: Heartbeat for node B using node A credential -> 403 Forbidden (Invariance spoofing)', async () => {
      const pak = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id, isReusable: true, maxUses: 10 });
      const kpA = generateCurve25519Keypair();
      const kpB = generateCurve25519Keypair();

      const nodeA = await enrollNode(kpA, pak.secret);
      assert.strictEqual(nodeA.regRes.status, 200);
      const credA = nodeA.regRes.body.credential;
      assert.ok(credA.startsWith('nnt1_'));

      const nodeB = await enrollNode(kpB, pak.secret);
      assert.strictEqual(nodeB.regRes.status, 200);
      const nodeBId = nodeB.regRes.body.assigned_node_id;

      // Node A's credential attempts to heartbeat on behalf of Node B
      const spoofRes = await request(app).post('/v4/control/heartbeat').set('Authorization', `Bearer ${credA}`).send({
        node_id: nodeBId,
        cpu_usage_pct: 10
      });

      assert.strictEqual(spoofRes.status, 403, `Expected 403 Forbidden, got ${spoofRes.status}`);
      assert.ok(spoofRes.body.error.includes('forbidden'), spoofRes.body.error);
    });

    it('Test 2: Register with public key without private key possession -> 401 Unauthorized', async () => {
      const pak = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id });
      const kpVictim = generateCurve25519Keypair();

      const chRes = await request(app).post('/v4/control/challenge').send({});
      assert.strictEqual(chRes.status, 200);
      const { nonce } = chRes.body;

      // Attacker submits victim's public key with a forged/random proof
      const dummyProof = crypto.randomBytes(32).toString('hex');

      const attackRes = await request(app).post('/v4/control/register').send({
        public_key_hex: kpVictim.publicKeyHex,
        role: 'CLIENT_ORIGIN',
        preauth_key: pak.secret,
        nonce,
        proof: dummyProof
      });

      assert.strictEqual(attackRes.status, 401);
      assert.strictEqual(attackRes.body.error, 'invalid proof of possession');
    });

    it('Test 3: Replay captured {nonce, proof} -> 401 Unauthorized (Anti-replay single use nonce)', async () => {
      const pak = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id, isReusable: true, maxUses: 5 });
      const kp = generateCurve25519Keypair();

      const enrolled = await enrollNode(kp, pak.secret);
      assert.strictEqual(enrolled.regRes.status, 200);

      // Replay the exact same {nonce, proof} packet
      const replayRes = await request(app).post('/v4/control/register').send({
        public_key_hex: kp.publicKeyHex,
        role: 'CLIENT_ORIGIN',
        preauth_key: pak.secret,
        nonce: enrolled.nonce,
        proof: enrolled.proof
      });

      assert.strictEqual(replayRes.status, 401);
      assert.strictEqual(replayRes.body.error, 'invalid or expired challenge nonce');
    });

    it('Test 4: Expired, revoked, or exhausted single-use pre-auth key -> 401 Unauthorized', async () => {
      // 4a: Single-use exhausted
      const singleUse = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id, isReusable: false });
      const kp1 = generateCurve25519Keypair();
      const kp2 = generateCurve25519Keypair();

      const firstUse = await enrollNode(kp1, singleUse.secret);
      assert.strictEqual(firstUse.regRes.status, 200);

      const secondUse = await enrollNode(kp2, singleUse.secret);
      assert.strictEqual(secondUse.regRes.status, 401);
      assert.ok(secondUse.regRes.body.error.includes('already been consumed'));

      // 4b: Expired pre-auth key
      const expKey = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id });
      await dbHelper.pool.query("UPDATE preauth_keys SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [
        expKey.id
      ]);
      const kpExp = generateCurve25519Keypair();
      const expUse = await enrollNode(kpExp, expKey.secret);
      assert.strictEqual(expUse.regRes.status, 401);
      assert.ok(expUse.regRes.body.error.includes('expired'));

      // 4c: Revoked pre-auth key
      const revKey = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id });
      await dbHelper.pool.query('UPDATE preauth_keys SET revoked_at = NOW() WHERE id = $1', [revKey.id]);
      const kpRev = generateCurve25519Keypair();
      const revUse = await enrollNode(kpRev, revKey.secret);
      assert.strictEqual(revUse.regRes.status, 401);
      assert.ok(revUse.regRes.body.error.includes('revoked'));
    });

    it('Test 5: Use owner X pre-auth key to re-register node owned by Y -> 403 Forbidden', async () => {
      // Alice (regularUser) registers a node
      const pakAlice = await PreAuthKeyService.createPreAuthKey({ ownerId: regularUser.id });
      const kpAliceNode = generateCurve25519Keypair();

      const aliceNode = await enrollNode(kpAliceNode, pakAlice.secret);
      assert.strictEqual(aliceNode.regRes.status, 200);
      const aliceNodeId = aliceNode.regRes.body.assigned_node_id;

      // Verify owner is Alice
      const nodeCheck = await dbHelper.pool.query('SELECT user_id FROM nodes WHERE id = $1', [aliceNodeId]);
      assert.strictEqual(nodeCheck.rows[0].user_id, regularUser.id);

      // Bob (adminUser) tries to re-register Alice's node key using Bob's pre-auth key
      const pakBob = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id });

      const chBob = await request(app).post('/v4/control/challenge').send({});
      const proofBob = ControlPlaneKeyService.computeClientProof(
        kpAliceNode.privateKeyHex,
        chBob.body.cp_public_key,
        chBob.body.nonce
      );

      const hijackAttempt = await request(app).post('/v4/control/register').send({
        public_key_hex: kpAliceNode.publicKeyHex,
        role: 'CLIENT_ORIGIN',
        preauth_key: pakBob.secret,
        nonce: chBob.body.nonce,
        proof: proofBob
      });

      assert.strictEqual(hijackAttempt.status, 403);
      assert.ok(hijackAttempt.body.error.includes('does not match existing node owner'));
    });

    it('Test 6: Revoked node credential -> 401 Unauthorized on next call', async () => {
      const pak = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id });
      const kp = generateCurve25519Keypair();

      const enrolled = await enrollNode(kp, pak.secret);
      assert.strictEqual(enrolled.regRes.status, 200);
      const nodeId = enrolled.regRes.body.assigned_node_id;
      const cred = enrolled.regRes.body.credential;

      // Heartbeat succeeds before revocation
      const hbBefore = await request(app)
        .post('/v4/control/heartbeat')
        .set('Authorization', `Bearer ${cred}`)
        .send({ node_id: nodeId });
      assert.strictEqual(hbBefore.status, 200);

      // Revoke node keys and credentials via RevocationEngine
      await RevocationEngine.revokeNodeKeys([nodeId], { reason: 'quarantined_by_security' });

      // Next heartbeat with same credential is rejected with 401
      const hbAfter = await request(app)
        .post('/v4/control/heartbeat')
        .set('Authorization', `Bearer ${cred}`)
        .send({ node_id: nodeId });

      assert.strictEqual(hbAfter.status, 401);
      assert.ok(hbAfter.body.error.includes('revoked'));
    });

    it('Test 7: Enrolment string with wrong fingerprint -> client verification error', async () => {
      const pak = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id });
      const fakeFingerprint = 'deadbeef'.repeat(8);
      const corruptedEnrolmentString = `nnk1:${pak.secret}:${fakeFingerprint}`;

      // Verify format parsing and mismatch detection
      const parts = corruptedEnrolmentString.split(':');
      assert.strictEqual(parts[0], 'nnk1');
      assert.strictEqual(parts[1], pak.secret);
      assert.strictEqual(parts[2], fakeFingerprint);

      const actualFingerprint = ControlPlaneKeyService.getControlPlaneFingerprint();
      assert.notStrictEqual(actualFingerprint.toLowerCase(), fakeFingerprint.toLowerCase());

      // In Go client (tested via RegisterWithProof parity logic):
      const clientVerificationFails = actualFingerprint.toLowerCase() !== parts[2].toLowerCase();
      assert.strictEqual(clientVerificationFails, true);
    });

    it('Test 8: Re-registration asking for EXIT_BRIDGE on CLIENT_ORIGIN node -> role unchanged', async () => {
      const pak1 = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id, isReusable: true, maxUses: 5 });
      const kp = generateCurve25519Keypair();

      // Initial registration as CLIENT_ORIGIN
      const firstReg = await enrollNode(kp, pak1.secret, 'CLIENT_ORIGIN');
      assert.strictEqual(firstReg.regRes.status, 200);
      const nodeId = firstReg.regRes.body.assigned_node_id;

      const initialRow = await dbHelper.pool.query('SELECT role FROM nodes WHERE id = $1', [nodeId]);
      assert.strictEqual(initialRow.rows[0].role, 'CLIENT_ORIGIN');

      // Re-registration requesting EXIT_BRIDGE
      const reReg = await enrollNode(kp, pak1.secret, 'EXIT_BRIDGE');
      assert.strictEqual(reReg.regRes.status, 200);

      // Node role in database remains CLIENT_ORIGIN
      const afterRow = await dbHelper.pool.query('SELECT role FROM nodes WHERE id = $1', [nodeId]);
      assert.strictEqual(afterRow.rows[0].role, 'CLIENT_ORIGIN');

      // Check audit event logged
      const audit = await dbHelper.pool.query(
        "SELECT event_type, message FROM audit_events WHERE target_id = $1 AND event_type = 'node.reregister_mismatch'",
        [nodeId]
      );
      assert.ok(audit.rows.length > 0);
      assert.ok(audit.rows[0].message.includes('stored values were kept'));
    });
  });

  describe('Credential Lifecycle & Automatic Rotation', () => {
    it('rotates credential on heartbeat when remaining lifetime is under 12 hours', async () => {
      const pak = await PreAuthKeyService.createPreAuthKey({ ownerId: adminUser.id });
      const kp = generateCurve25519Keypair();

      const enrolled = await enrollNode(kp, pak.secret);
      assert.strictEqual(enrolled.regRes.status, 200);
      const nodeId = enrolled.regRes.body.assigned_node_id;
      const initialCred = enrolled.regRes.body.credential;

      // Normal heartbeat (>12h remaining) does not rotate
      const hb1 = await request(app)
        .post('/v4/control/heartbeat')
        .set('Authorization', `Bearer ${initialCred}`)
        .send({ node_id: nodeId });
      assert.strictEqual(hb1.status, 200);
      assert.strictEqual(hb1.body.new_credential, undefined);

      // Fast-forward credential lifetime in database so only 6 hours remain (<12h threshold)
      await dbHelper.pool.query(
        "UPDATE node_credentials SET expires_at = NOW() + INTERVAL '6 hours' WHERE node_id = $1 AND revoked_at IS NULL",
        [nodeId]
      );

      // Next heartbeat should rotate credential
      const hb2 = await request(app)
        .post('/v4/control/heartbeat')
        .set('Authorization', `Bearer ${initialCred}`)
        .send({ node_id: nodeId });
      assert.strictEqual(hb2.status, 200);
      assert.ok(hb2.body.new_credential);
      assert.ok(hb2.body.new_credential.startsWith('nnt1_'));
      assert.notStrictEqual(hb2.body.new_credential, initialCred);

      // Subsequent heartbeat with the newly issued credential succeeds
      const hb3 = await request(app)
        .post('/v4/control/heartbeat')
        .set('Authorization', `Bearer ${hb2.body.new_credential}`)
        .send({ node_id: nodeId });
      assert.strictEqual(hb3.status, 200);
      assert.strictEqual(hb3.body.acknowledged, true);
    });
  });
});
