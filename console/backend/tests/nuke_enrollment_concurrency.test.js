const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { CryptoShreddingService: service } = require('../services/CryptoShreddingService');
const PreAuthKeyService = require('../services/PreAuthKeyService');
const ControlPlaneKeyService = require('../services/ControlPlaneKeyService');
const NodeCredentialService = require('../services/NodeCredentialService');
const { generateCurve25519Keypair } = require('../utils/crypto');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Destruction governance includes in-flight enrollment', { timeout: 30000 }, () => {
  let db;
  let pool;
  let app;

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    assert.match(db.dbName, /^neronet_t_/);
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  async function waitForBlockedOperation() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const locks = await pool.query(
        `SELECT pid, query FROM pg_stat_activity WHERE datname=current_database()
          AND pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query ~ '(organizations|nodes|preauth_keys|users|pg_advisory_xact_lock)'`
      );
      if (locks.rowCount) return 'serialized';
      await delay(10);
    }
    throw new Error('Neither shred completion nor an enrollment serialization lock was observed');
  }

  for (const global of [false, true]) {
    it(`leaves no unrevoked enrollment surviving a concurrent ${global ? 'global' : 'tenant'} shred`, async (t) => {
      const prefix = global ? 'enroll-global' : 'enroll-tenant';
      const org = `${prefix}-org`;
      const initiator = `${prefix}-initiator`;
      const approver = `${prefix}-approver`;
      await pool.query('INSERT INTO organizations (id,name,slug) VALUES ($1,$1,$1)', [org]);
      for (const [id, role] of [
        [initiator, 'owner'],
        [approver, 'admin']
      ]) {
        await pool.query(
          "INSERT INTO users (id,username,email,password_hash,role,organization_id) VALUES ($1,$1,$2,'fixture',$3,$4)",
          [id, `${id}@test.invalid`, global ? 'super-admin' : 'user', org]
        );
        if (!global)
          await pool.query('INSERT INTO memberships (id,user_id,organization_id,role) VALUES ($1,$2,$3,$4)', [
            `mem-${id}`,
            id,
            org,
            role
          ]);
      }
      await service.getOrCreateOrgDEK(org);
      const preauth = await PreAuthKeyService.createPreAuthKey({ ownerId: initiator, organizationId: org });
      const authorization = await service.requestDestruction({
        targetType: global ? 'global' : 'organization',
        targetId: global ? 'global' : org,
        initiatorUserId: initiator
      });
      const keypair = generateCurve25519Keypair();
      const challenge = await request(app).post('/v4/control/challenge').send({});
      assert.equal(challenge.status, 200);
      const { nonce, cp_public_key: cpKey } = challenge.body;
      const proof = ControlPlaneKeyService.computeClientProof(keypair.privateKeyHex, cpKey, nonce, 'CLIENT_ORIGIN');

      // Only pause scheduling after the real production preauth consumption. Its
      // transaction/locks, the HTTP register and the shred all remain real.
      const originalConsume = PreAuthKeyService.validateAndConsumePreAuthKey;
      const consumed = deferred();
      const resumeEnrollment = deferred();
      PreAuthKeyService.validateAndConsumePreAuthKey = async function (...args) {
        const result = await originalConsume.apply(this, args);
        if (args[0] === preauth.secret && result.ok) {
          consumed.resolve();
          await resumeEnrollment.promise;
        }
        return result;
      };
      const registration = request(app)
        .post('/v4/control/register')
        .send({
          public_key_hex: keypair.publicKeyHex,
          role: 'CLIENT_ORIGIN',
          preauth_key: preauth.secret,
          nonce,
          proof
        })
        .then((res) => res);
      let approval;
      try {
        await consumed.promise;
        approval = service.approveAndExecuteDestruction(authorization.id, approver);
        approval.catch(() => {});
        const order = await Promise.race([
          approval.then(() => 'shred committed before enrollment resumed'),
          waitForBlockedOperation()
        ]);
        resumeEnrollment.resolve();
        const [registered, executed] = await Promise.all([registration, approval]);
        assert.equal(executed.success, true);
        assert.ok(
          registered.status === 200 || (registered.status >= 400 && registered.status < 500),
          `registration returned unexpected status ${registered.status}: ${JSON.stringify(registered.body)}`
        );
        const survivor = await pool.query('SELECT id,organization_id FROM nodes WHERE public_key=$1', [
          keypair.publicKeyHex
        ]);
        const revoked = await pool.query('SELECT 1 FROM revoked_keys WHERE public_key_hex=$1', [keypair.publicKeyHex]);
        const credentialValid = registered.body.credential
          ? (await NodeCredentialService.validateCredential(registered.body.credential)).ok
          : false;
        t.diagnostic(
          JSON.stringify({
            order,
            registration_status: registered.status,
            surviving_nodes: survivor.rowCount,
            revoked_keys: revoked.rowCount,
            credential_valid: credentialValid
          })
        );
        assert.equal(
          (await pool.query('SELECT status FROM organization_keys WHERE organization_id=$1', [org])).rows[0].status,
          'destroyed'
        );
        assert.equal(
          (await pool.query('SELECT status FROM nuke_authorizations WHERE id=$1', [authorization.id])).rows[0].status,
          'executed'
        );
        assert.equal(
          survivor.rowCount,
          0,
          'a node inserted by an enrollment already in progress survived the committed shred'
        );
        assert.equal(credentialValid, false, 'the concurrent enrollment retained a valid node credential after shred');
      } finally {
        resumeEnrollment.resolve();
        await Promise.allSettled([registration, approval]);
        PreAuthKeyService.validateAndConsumePreAuthKey = originalConsume;
      }
    });
  }
});
