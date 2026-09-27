const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { nodeKey, register } = require('./helpers/nodeEnrolment');
const RevocationEngine = require('../services/RevocationEngine');
const jwt = require('jsonwebtoken');
const config = require('../config/env');

/**
 * WP-205: Revocation-to-Data-Plane
 *
 * When a node is quarantined or revoked via the API:
 *   1. Its WireGuard public key is written to the revoked_keys table.
 *   2. The ACL/netmap epoch is bumped immediately.
 *   3. Every peer receives the revoked key on its next heartbeat response.
 *
 * This test verifies the full chain from HTTP action → revoked_keys insert
 * → heartbeat response delivery, without requiring a live WireGuard interface.
 */

describe('WP-205: Revocation-to-Data-Plane propagation', () => {
  let app;
  let dbHelper;
  let pool;

  // Three nodes: alpha is the observer (heartbeater), beta will be quarantined,
  // gamma will be fully revoked/deleted.
  let alpha;
  let beta;
  let gamma;
  let betaKey;
  let gammaKey;

  // Admin token for action/delete endpoints
  let adminToken;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    betaKey = nodeKey();
    gammaKey = nodeKey();

    alpha = (await register(app, { public_key_hex: nodeKey(), role: 'CLIENT_ORIGIN', endpoints: [] })).body;

    beta = (await register(app, { public_key_hex: betaKey, role: 'CLIENT_ORIGIN', endpoints: [] })).body;

    gamma = (await register(app, { public_key_hex: gammaKey, role: 'CLIENT_ORIGIN', endpoints: [] })).body;

    // Retrieve beta's and gamma's node IDs and user IDs for direct API calls
    const betaNode = (await pool.query('SELECT * FROM nodes WHERE public_key = $1', [betaKey])).rows[0];
    const gammaNode = (await pool.query('SELECT * FROM nodes WHERE public_key = $1', [gammaKey])).rows[0];

    // Build an admin token for the same user as beta/gamma so access is permitted
    const userId = betaNode.user_id;
    adminToken = jwt.sign(
      {
        sub: userId,
        id: userId,
        username: 'testadmin',
        role: 'super-admin',
        compartment_access: 'standard'
      },
      config.JWT_SECRET
    );

    beta.node_id = betaNode.id;
    gamma.node_id = gammaNode.id;
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('heartbeat carries empty revoked_keys before any revocation', async () => {
    const res = await request(app).post('/v4/control/heartbeat').send({ node_id: alpha.assigned_node_id });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.revoked_keys, []);
  });

  it('quarantine action writes beta key to revoked_keys and alpha heartbeat receives it', async () => {
    // STEP 1: Quarantine beta via the node action API
    const actionRes = await request(app)
      .post(`/api/nodes/${beta.node_id}/action`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'quarantine', reason: 'WP-205 test quarantine' });

    assert.strictEqual(actionRes.status, 200);
    assert.ok(actionRes.body.result?.is_quarantined, 'Node must be marked quarantined');

    // STEP 2: Verify the key is in revoked_keys
    const active = await RevocationEngine.activeRevocations();
    assert.ok(active.includes(betaKey), 'Beta WireGuard key must be in revoked_keys after quarantine');

    // STEP 3: Alpha heartbeat must include beta's key (simulating ≤20s delivery)
    const hbRes = await request(app).post('/v4/control/heartbeat').send({ node_id: alpha.assigned_node_id });

    assert.strictEqual(hbRes.status, 200);
    assert.ok(
      hbRes.body.revoked_keys.includes(betaKey),
      `Alpha heartbeat must carry beta's revoked key. Got: ${JSON.stringify(hbRes.body.revoked_keys)}`
    );
  });

  it('deleting gamma via API writes its key to revoked_keys and alpha heartbeat receives it', async () => {
    // STEP 1: Delete/revoke gamma via the delete endpoint
    const deleteRes = await request(app)
      .delete(`/api/nodes/${gamma.node_id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    assert.strictEqual(deleteRes.status, 200);
    assert.ok(deleteRes.body.success);

    // STEP 2: Verify key is in revoked_keys
    const active = await RevocationEngine.activeRevocations();
    assert.ok(active.includes(gammaKey), 'Gamma WireGuard key must be in revoked_keys after deletion');

    // STEP 3: Alpha heartbeat must carry gamma's revoked key
    const hbRes = await request(app).post('/v4/control/heartbeat').send({ node_id: alpha.assigned_node_id });

    assert.strictEqual(hbRes.status, 200);
    assert.ok(
      hbRes.body.revoked_keys.includes(gammaKey),
      `Alpha heartbeat must carry gamma's revoked key. Got: ${JSON.stringify(hbRes.body.revoked_keys)}`
    );
  });

  it('ACL epoch is bumped on each revocation so peers re-sync their policy', async () => {
    const { bumpEpoch, getEpoch } = require('../services/AclEngine');
    const delta = nodeKey();
    const deltaNode = (await register(app, { public_key_hex: delta, role: 'CLIENT_ORIGIN', endpoints: [] })).body;

    const epochBefore = await getEpoch('acl');

    await RevocationEngine.revokeNodeKeys([deltaNode.assigned_node_id], { reason: 'epoch-test' });

    const epochAfter = await getEpoch('acl');
    assert.ok(epochAfter > epochBefore, 'ACL epoch must advance after revocation');
  });

  it('revocation is idempotent: revoking beta twice does not duplicate entries', async () => {
    // beta was already revoked in the quarantine test above
    await RevocationEngine.revokeNodeKeys([beta.node_id], { reason: 'duplicate-test' });

    const active = await RevocationEngine.activeRevocations();
    const count = active.filter((k) => k === betaKey).length;
    assert.strictEqual(count, 1, 'Revoked key must appear exactly once despite double revocation');
  });
});

// A quarantine revokes the node's key and its credential, and a revoked key cannot
// register. Lifting the quarantine left the revocation in place, so the node could
// never get a credential again and stayed cut off.
describe('Lifting a quarantine', () => {
  let app;
  let dbHelper;
  let pool;
  let adminToken;
  let observer;

  async function enrol(key) {
    const res = await register(app, { public_key_hex: key, role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.strictEqual(res.status, 200, `register: ${res.status} ${JSON.stringify(res.body)}`);
    const row = (await pool.query('SELECT id, user_id FROM nodes WHERE public_key = $1', [key])).rows[0];
    return { ...res.body, node_id: row.id, user_id: row.user_id };
  }

  function action(nodeId, body) {
    return request(app).post(`/api/nodes/${nodeId}/action`).set('Authorization', `Bearer ${adminToken}`).send(body);
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    observer = await enrol(nodeKey());
    adminToken = jwt.sign(
      {
        sub: observer.user_id,
        id: observer.user_id,
        username: 'testadmin',
        role: 'super-admin',
        compartment_access: 'standard'
      },
      config.JWT_SECRET
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('lets the node register again and stops sending its key as revoked', async () => {
    const key = nodeKey();
    const node = await enrol(key);

    assert.strictEqual((await action(node.node_id, { action: 'quarantine', reason: 'test' })).status, 200);
    const refused = await register(app, { public_key_hex: key, role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.strictEqual(refused.status, 403, 'a quarantined key must not register');

    assert.strictEqual((await action(node.node_id, { action: 'lift_quarantine' })).status, 200);

    assert.strictEqual(await RevocationEngine.isRevoked(key), false);
    const hb = await request(app).post('/v4/control/heartbeat').send({ node_id: observer.assigned_node_id });
    assert.strictEqual(hb.status, 200);
    assert.ok(!hb.body.revoked_keys.includes(key), 'peers must stop receiving the lifted key');

    const again = await register(app, { public_key_hex: key, role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.strictEqual(again.status, 200, `re-registration after the lift: ${again.status}`);
  });

  it('does not undo a revocation made for another reason', async () => {
    const key = nodeKey();
    const node = await enrol(key);

    await RevocationEngine.revokeNodeKeys([node.node_id], { reason: 'compromised' });
    assert.strictEqual((await action(node.node_id, { action: 'quarantine', reason: 'test' })).status, 200);
    assert.strictEqual((await action(node.node_id, { action: 'lift_quarantine' })).status, 200);

    assert.strictEqual(await RevocationEngine.isRevoked(key), true);
    const refused = await register(app, { public_key_hex: key, role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.strictEqual(refused.status, 403);
  });
});
