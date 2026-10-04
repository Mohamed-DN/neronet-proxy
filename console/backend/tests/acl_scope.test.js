const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const {
  NODES,
  DEFAULT_COMPARTMENT,
  HIDDEN_COMPARTMENT,
  tokens: makeTokens,
  seedHiddenTier
} = require('./helpers/hiddenTier');

/**
 * The ACL read endpoints answer for a node the caller names. They checked who was
 * asking and nothing else, so any signed-in user could read the compiled policy of any
 * node on the platform: its overlay address and the address of every peer it may reach,
 * across organisations and into hidden compartments. The simulator told a hidden node's
 * address from an unused one by its reason text.
 */
describe('ACL read endpoints stay inside the caller organisation and tier', () => {
  let dbHelper;
  let app;
  let t;

  const get = (path, token) => request(app).get(path).set('Authorization', `Bearer ${token}`);
  const post = (path, token, body) => request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();
    await seedHiddenTier(dbHelper.pool);
    t = makeTokens();

    // The hidden compartment is peered with the default one, which is how a visible
    // node comes to name a hidden node's address among its peers.
    await dbHelper.pool.query(
      `INSERT INTO compartment_peerings (id, organization_id, src_compartment_id, dst_compartment_id, policy)
       VALUES ('peer-sec-acl', 'org-sec-a', $1, $2, 'allow')`,
      [DEFAULT_COMPARTMENT, HIDDEN_COMPARTMENT]
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it("refuses the compiled policy of another organisation's node", async () => {
    const res = await get(`/api/acl/compiled/${NODES.b1.id}`, t.owner);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.ok(!JSON.stringify(res.body).includes(NODES.b1.vip), 'the address of another tenant node was returned');
  });

  it('answers for an unknown node and for another organisation node alike', async () => {
    const unknown = await get('/api/acl/compiled/node-sec-does-not-exist', t.owner);
    const foreign = await get(`/api/acl/compiled/${NODES.b1.id}`, t.owner);
    assert.strictEqual(unknown.status, foreign.status);
    assert.deepStrictEqual(unknown.body, { error: 'no node node-sec-does-not-exist' });
    assert.strictEqual(foreign.body.error, `no node ${NODES.b1.id}`);
  });

  it('treats a node in a hidden compartment as absent below the root tier', async () => {
    const standard = await get(`/api/acl/compiled/${NODES.h1.id}`, t.owner);
    assert.strictEqual(standard.status, 404, JSON.stringify(standard.body));

    const root = await get(`/api/acl/compiled/${NODES.h1.id}`, t.rootOwner);
    assert.strictEqual(root.status, 200, 'the root tier must still read it');
  });

  it('lets a member read the policy of their own node and of no one else’s', async () => {
    const own = await get(`/api/acl/compiled/${NODES.v2.id}`, t.member);
    assert.strictEqual(own.status, 200, JSON.stringify(own.body));
    assert.strictEqual(own.body.node_id, NODES.v2.id);

    const other = await get(`/api/acl/compiled/${NODES.v1.id}`, t.member);
    assert.strictEqual(other.status, 404);
  });

  it('lets an organisation owner read any visible node of the organisation', async () => {
    const res = await get(`/api/acl/compiled/${NODES.v1.id}`, t.owner);
    assert.strictEqual(res.status, 200);
  });

  it('does not name a hidden node among the peers of a visible one', async () => {
    const standard = await get(`/api/acl/compiled/${NODES.v1.id}`, t.owner);
    assert.strictEqual(standard.status, 200);
    assert.ok(
      !JSON.stringify(standard.body).includes(NODES.h1.vip),
      'the compiled policy of a visible node named a hidden node by its address'
    );

    const root = await get(`/api/acl/compiled/${NODES.v1.id}`, t.rootOwner);
    assert.ok(JSON.stringify(root.body).includes(NODES.h1.vip), 'the root tier must see its own hidden peer');
  });

  it('keeps a hidden peer out of a preview as well, and a hidden node cannot be previewed', async () => {
    const standard = await post('/api/acl/preview', t.admin, { node_id: NODES.v1.id });
    assert.strictEqual(standard.status, 200, JSON.stringify(standard.body));
    assert.ok(!JSON.stringify(standard.body).includes(NODES.h1.vip), 'the preview named a hidden peer');

    const hidden = await post('/api/acl/preview', t.admin, { node_id: NODES.h1.id });
    assert.strictEqual(hidden.status, 404, 'a hidden node was previewed below the root tier');

    const root = await post('/api/acl/preview', t.rootAdmin, { node_id: NODES.v1.id });
    assert.ok(JSON.stringify(root.body).includes(NODES.h1.vip), 'the root tier must see its own hidden peer');
  });

  it('answers a packet to a hidden node as it does for an address nobody holds', async () => {
    // A hidden node in a compartment that is not the source's, and an address that is
    // allocated to nobody: the two must not be told apart.
    await dbHelper.pool.query('DELETE FROM compartment_peerings');
    const hiddenUnpeered = await post('/api/acl/simulate', t.owner, {
      source_ip: NODES.v1.vip,
      destination_ip: NODES.h1.vip
    });
    const nobody = await post('/api/acl/simulate', t.owner, {
      source_ip: NODES.v1.vip,
      destination_ip: '100.64.77.200'
    });

    for (const probe of [hiddenUnpeered, nobody]) assert.strictEqual(probe.status, 200);
    assert.deepStrictEqual(
      { verdict: hiddenUnpeered.body.verdict, reason: hiddenUnpeered.body.reason },
      { verdict: nobody.body.verdict, reason: nobody.body.reason },
      'the simulator distinguished a hidden node from an unused address'
    );

    const root = await post('/api/acl/simulate', t.rootOwner, {
      source_ip: NODES.v1.vip,
      destination_ip: NODES.h1.vip
    });
    assert.strictEqual(root.body.verdict, 'DROP', 'the root tier still sees the boundary');
  });
});
