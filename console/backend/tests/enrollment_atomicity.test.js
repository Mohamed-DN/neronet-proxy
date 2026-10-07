const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const PreAuthKeyService = require('../services/PreAuthKeyService');
const ControlPlaneKeyService = require('../services/ControlPlaneKeyService');
const NodeCredentialService = require('../services/NodeCredentialService');
const AclEngine = require('../services/AclEngine');
const { CryptoShreddingService: governance } = require('../services/CryptoShreddingService');
const { generateCurve25519Keypair } = require('../utils/crypto');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Enrollment commits identity, authorization, credential and epochs together', { timeout: 30000 }, () => {
  let db;
  let pool;
  let app;
  let sequence = 0;

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    assert.match(db.dbName, /^neronet_t_/);
  });
  after(async () => {
    if (db) await db.cleanup();
  });

  async function fixture({ reusable = false, platform = false } = {}) {
    const prefix = `atomic-enroll-${++sequence}`;
    const org = `${prefix}-org`;
    const owner = `${prefix}-owner`;
    const approver = `${prefix}-approver`;
    await pool.query('INSERT INTO organizations (id,name,slug) VALUES ($1,$1,$1)', [org]);
    for (const [id, role] of [
      [owner, 'owner'],
      [approver, 'admin']
    ]) {
      await pool.query(
        "INSERT INTO users (id,username,email,password_hash,role,organization_id) VALUES ($1,$1,$2,'fixture',$3,$4)",
        [id, `${id}@test.invalid`, platform ? 'super-admin' : 'user', org]
      );
      await pool.query('INSERT INTO memberships (id,user_id,organization_id,role) VALUES ($1,$2,$3,$4)', [
        `mem-${id}`,
        id,
        org,
        role
      ]);
    }
    const preauth = await PreAuthKeyService.createPreAuthKey({
      ownerId: owner,
      organizationId: org,
      isReusable: reusable
    });
    const keypair = generateCurve25519Keypair();
    return { org, owner, approver, preauth, keypair, nodeId: `pk_${keypair.publicKeyHex.slice(0, 16)}` };
  }

  async function registrationBody(f, preauth = f.preauth.secret) {
    const challenge = await request(app).post('/v4/control/challenge').send({});
    assert.equal(challenge.status, 200);
    const { nonce, cp_public_key: cpKey } = challenge.body;
    return {
      public_key_hex: f.keypair.publicKeyHex,
      role: 'CLIENT_ORIGIN',
      nonce,
      proof: ControlPlaneKeyService.computeClientProof(f.keypair.privateKeyHex, cpKey, nonce, 'CLIENT_ORIGIN'),
      ...(preauth ? { preauth_key: preauth } : {})
    };
  }

  async function epochs() {
    return (await pool.query('SELECT name,epoch FROM mesh_epochs ORDER BY name')).rows;
  }

  async function assertRolledBack(f, beforeEpochs) {
    assert.equal((await pool.query('SELECT id FROM nodes WHERE id=$1', [f.nodeId])).rowCount, 0);
    assert.equal((await pool.query('SELECT id FROM node_credentials WHERE node_id=$1', [f.nodeId])).rowCount, 0);
    assert.equal(
      (await pool.query('SELECT used_count FROM preauth_keys WHERE id=$1', [f.preauth.id])).rows[0].used_count,
      0
    );
    assert.deepEqual(await epochs(), beforeEpochs);
  }

  for (const failure of ['credential insertion', 'epoch update']) {
    it(`rolls back the real preauth consumption and node when ${failure} fails`, async () => {
      const f = await fixture();
      const beforeEpochs = await epochs();
      const service = failure === 'credential insertion' ? NodeCredentialService : AclEngine;
      const method = failure === 'credential insertion' ? 'mintCredential' : 'bumpEpoch';
      const original = service[method];
      let injected = false;
      // Fail after the real SQL operation, including a credential INSERT or both
      // epoch UPDATEs. The assertion covers rollback, not a mocked DB response.
      service[method] = async function (...args) {
        const result = await original.apply(this, args);
        if (!injected) {
          injected = true;
          throw new Error(`deliberate test failure after ${failure}`);
        }
        return result;
      };
      try {
        const rejected = await request(app)
          .post('/v4/control/register')
          .send(await registrationBody(f));
        assert.equal(rejected.status, 500);
        assert.equal(injected, true);
        await assertRolledBack(f, beforeEpochs);
      } finally {
        service[method] = original;
      }
      const retried = await request(app)
        .post('/v4/control/register')
        .send(await registrationBody(f));
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      assert.equal(
        (await pool.query('SELECT used_count FROM preauth_keys WHERE id=$1', [f.preauth.id])).rows[0].used_count,
        1
      );
      assert.equal((await NodeCredentialService.validateCredential(retried.body.credential)).ok, true);
    });
  }

  it('returns the persisted VIP to concurrent registrations of the same identity', async (t) => {
    const f = await fixture({ reusable: true });
    const bodies = await Promise.all([registrationBody(f), registrationBody(f)]);
    const consumed = deferred();
    const resume = deferred();
    const original = PreAuthKeyService.validateAndConsumePreAuthKey;
    let paused = false;
    PreAuthKeyService.validateAndConsumePreAuthKey = async function (...args) {
      const result = await original.apply(this, args);
      if (!paused && args[0] === f.preauth.secret && result.ok) {
        paused = true;
        consumed.resolve();
        await resume.promise;
      }
      return result;
    };
    const first = request(app)
      .post('/v4/control/register')
      .send(bodies[0])
      .then((res) => res);
    let second;
    try {
      await consumed.promise;
      second = request(app)
        .post('/v4/control/register')
        .send(bodies[1])
        .then((res) => res);
      const deadline = Date.now() + 5000;
      let observed = false;
      while (Date.now() < deadline) {
        const blocked = await pool.query(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
             AND query ~ '(pg_advisory_xact_lock|preauth_keys|nodes)'
             AND cardinality(pg_blocking_pids(pid)) > 0`
        );
        if (blocked.rowCount) {
          observed = true;
          break;
        }
        await delay(10);
      }
      assert.equal(observed, true, 'the second enrollment did not wait for the first identity transaction');
      resume.resolve();
      const responses = await Promise.all([first, second]);
      const stored = (await pool.query('SELECT id,overlay_ipv4,overlay_ipv6 FROM nodes WHERE id=$1', [f.nodeId])).rows;
      assert.equal(stored.length, 1);
      for (const res of responses) {
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.assigned_node_id, stored[0].id);
        assert.equal(res.body.overlay_ipv4, stored[0].overlay_ipv4);
        assert.equal(res.body.overlay_ipv6, stored[0].overlay_ipv6);
        assert.equal((await NodeCredentialService.validateCredential(res.body.credential)).ok, true);
      }
      t.diagnostic(
        JSON.stringify({
          serialized: observed,
          registration_statuses: responses.map((r) => r.status),
          node_count: stored.length
        })
      );
    } finally {
      resume.resolve();
      await Promise.allSettled([first, second]);
      PreAuthKeyService.validateAndConsumePreAuthKey = original;
    }
  });

  it('preserves the enrolled organization and VIP after the owner changes its primary organization', async () => {
    const f = await fixture();
    const initial = await request(app)
      .post('/v4/control/register')
      .send(await registrationBody(f));
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    const nextOrg = `${f.org}-next`;
    await pool.query('INSERT INTO organizations (id,name,slug) VALUES ($1,$1,$1)', [nextOrg]);
    await pool.query('UPDATE users SET organization_id=$1 WHERE id=$2', [nextOrg, f.owner]);
    // The owner remains a real member of the enrolled organization. No token is
    // consumed on restart and the node's organization cannot follow the owner.
    const restarted = await request(app)
      .post('/v4/control/register')
      .send(await registrationBody(f, null));
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
    assert.equal(restarted.body.overlay_ipv4, initial.body.overlay_ipv4);
    assert.equal(restarted.body.overlay_ipv6, initial.body.overlay_ipv6);
    const stored = (await pool.query('SELECT user_id,organization_id FROM nodes WHERE id=$1', [f.nodeId])).rows[0];
    assert.deepEqual(stored, { user_id: f.owner, organization_id: f.org });
  });

  it('rejects a new preauth for a destroyed organization even when its platform owner remains active', async () => {
    const f = await fixture({ platform: true });
    await governance.getOrCreateOrgDEK(f.org);
    const authorization = await governance.requestDestruction({
      targetType: 'organization',
      targetId: f.org,
      initiatorUserId: f.owner
    });
    assert.equal((await governance.approveAndExecuteDestruction(authorization.id, f.approver)).success, true);
    assert.equal((await pool.query('SELECT status FROM users WHERE id=$1', [f.owner])).rows[0].status, 'active');
    f.preauth = await PreAuthKeyService.createPreAuthKey({ ownerId: f.owner, organizationId: f.org });
    const res = await request(app)
      .post('/v4/control/register')
      .send(await registrationBody(f));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal((await pool.query('SELECT id FROM nodes WHERE id=$1', [f.nodeId])).rowCount, 0);
    assert.equal(
      (await pool.query('SELECT used_count FROM preauth_keys WHERE id=$1', [f.preauth.id])).rows[0].used_count,
      0
    );
  });

  it('rejects consumed-before-shred authority but permits a fresh fleet enrollment after a global wipe', async () => {
    const f = await fixture({ platform: true });
    await governance.getOrCreateOrgDEK(f.org);
    const authorization = await governance.requestDestruction({
      targetType: 'global',
      targetId: 'global',
      initiatorUserId: f.owner
    });
    assert.equal((await governance.approveAndExecuteDestruction(authorization.id, f.approver)).success, true);
    const stale = await request(app)
      .post('/v4/control/register')
      .send(await registrationBody(f));
    assert.equal(stale.status, 401, JSON.stringify(stale.body));
    assert.equal((await pool.query('SELECT id FROM nodes WHERE id=$1', [f.nodeId])).rowCount, 0);
    const previousToken = process.env.SOVEREIGN_REGISTRATION_TOKEN;
    const previousOwner = process.env.SOVEREIGN_GO_BRIDGE_OWNER_ID;
    const token = 'isolated-global-enrollment-test-token';
    process.env.SOVEREIGN_REGISTRATION_TOKEN = token;
    process.env.SOVEREIGN_GO_BRIDGE_OWNER_ID = f.owner;
    try {
      const fresh = await request(app)
        .post('/v4/control/register')
        .set('Authorization', `Bearer ${token}`)
        .send(await registrationBody(f, null));
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
      assert.equal((await NodeCredentialService.validateCredential(fresh.body.credential)).ok, true);
      assert.equal(
        (await pool.query('SELECT organization_id FROM nodes WHERE id=$1', [f.nodeId])).rows[0].organization_id,
        f.org
      );
    } finally {
      if (previousToken === undefined) delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
      else process.env.SOVEREIGN_REGISTRATION_TOKEN = previousToken;
      if (previousOwner === undefined) delete process.env.SOVEREIGN_GO_BRIDGE_OWNER_ID;
      else process.env.SOVEREIGN_GO_BRIDGE_OWNER_ID = previousOwner;
    }
  });
});
