const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { nodeKey, register } = require('./helpers/nodeEnrolment');

// The bridge only enforces the shared token when one is configured; with the
// variable unset it warns and lets every caller in, which is the development
// default the other bridge suites run under.
const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

/**
 * /v4/control/heartbeat was the only /v4/control handler that authenticated
 * nothing. It looked the node up first and answered 404 for an id it did not know
 * and 200 for one it did, so an unauthenticated caller could enumerate node ids and
 * forge telemetry and read the quarantine state of any node whose id they guessed.
 */

const GO_PUBKEY = nodeKey();
const UNKNOWN_NODE_ID = 'pk_00000000deadbeef';

describe('Heartbeat authentication', () => {
  let dbHelper;
  let app;
  let nodeId;
  let credential;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();

    const registered = await register(
      app,
      { public_key_hex: GO_PUBKEY, role: 'RELAY', endpoints: [], capability: { country_code: 'DE' } },
      { token: REGISTRATION_TOKEN }
    );

    assert.strictEqual(registered.status, 200, `registration failed: ${JSON.stringify(registered.body)}`);
    nodeId = registered.body.assigned_node_id;
    credential = registered.body.credential;
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('refuses a heartbeat that carries no credential', async () => {
    const res = await request(app).post('/v4/control/heartbeat').send({ node_id: nodeId, cpu_usage_pct: 12 });

    assert.strictEqual(res.status, 401);
  });

  it('refuses a heartbeat that carries the wrong token', async () => {
    const res = await request(app)
      .post('/v4/control/heartbeat')
      .set('Authorization', `Bearer ${crypto.randomBytes(24).toString('hex')}`)
      .send({ node_id: nodeId });

    assert.strictEqual(res.status, 401);
  });

  it('answers an unauthenticated caller the same way whether the node exists or not', async () => {
    const known = await request(app).post('/v4/control/heartbeat').send({ node_id: nodeId });
    const unknown = await request(app).post('/v4/control/heartbeat').send({ node_id: UNKNOWN_NODE_ID });

    // The 404/200 split was an existence oracle: knowing which ids answer 200 is
    // the first half of forging another node's telemetry.
    assert.strictEqual(known.status, 401);
    assert.strictEqual(unknown.status, 401);
    assert.deepStrictEqual(known.body, unknown.body);
  });

  it('does not read the nodes table before authenticating', async () => {
    const realQuery = dbHelper.pool.query.bind(dbHelper.pool);
    let nodeReads = 0;

    dbHelper.pool.query = (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
      if (/from\s+nodes/i.test(sql)) nodeReads += 1;
      return realQuery(...args);
    };

    try {
      await request(app).post('/v4/control/heartbeat').send({ node_id: nodeId });
      await request(app).post('/v4/control/heartbeat').send({ node_id: UNKNOWN_NODE_ID });
    } finally {
      dbHelper.pool.query = realQuery;
    }

    // Rejecting after the lookup would still leak existence through timing and
    // would let an anonymous caller drive database work.
    assert.strictEqual(nodeReads, 0, `the handler read the nodes table ${nodeReads} time(s) before authenticating`);
  });

  it('accepts a heartbeat that carries the node credential', async () => {
    const res = await request(app)
      .post('/v4/control/heartbeat')
      .set('Authorization', `Bearer ${credential}`)
      .send({ node_id: nodeId, cpu_usage_pct: 12, rtt_ms: 7 });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.acknowledged, true);
    assert.strictEqual(typeof res.body.policy_epoch, 'number');
  });

  // The enrolment token is shared by the whole fleet and names no node, so accepting
  // it here let any holder beat for any node id.
  it('refuses the enrolment token, known node or not', async () => {
    for (const id of [nodeId, UNKNOWN_NODE_ID]) {
      const res = await request(app)
        .post('/v4/control/heartbeat')
        .set('Authorization', `Bearer ${REGISTRATION_TOKEN}`)
        .send({ node_id: id });
      assert.strictEqual(res.status, 401);
    }
  });

  it("refuses a credential used for another node's id", async () => {
    const res = await request(app)
      .post('/v4/control/heartbeat')
      .set('Authorization', `Bearer ${credential}`)
      .send({ node_id: UNKNOWN_NODE_ID });

    assert.strictEqual(res.status, 403);
  });
});
