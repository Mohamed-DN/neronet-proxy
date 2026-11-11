// M5: a 5xx tells the client nothing about the inside of the server. The detail is
// logged; the client gets a fixed text. 4xx messages are written for the client and stay.
const crypto = require('node:crypto');
const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createOrgFixture } = require('./helpers/orgFixture');
const { nodeKey, register } = require('./helpers/nodeEnrolment');
const { createApp } = require('../server');
const { errorHandler } = require('../middleware/errorHandler');
const NetmapService = require('../services/NetmapService');

const SECRET = 'relation "secret_internal_table" does not exist';

function run(err) {
  const out = {};
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    }
  };
  errorHandler(err, { method: 'GET', originalUrl: '/x', path: '/x' }, res, () => {});
  return out;
}

describe('M5: internal error text', () => {
  let dbHelper;
  let app;
  let fx;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();
    fx = await createOrgFixture(dbHelper.pool);
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('answers a fixed text for a 500 and keeps the message for a 4xx', () => {
    const fiveHundred = run(new Error(SECRET));
    assert.strictEqual(fiveHundred.status, 500);
    assert.strictEqual(fiveHundred.body.error, 'Internal Server Error');

    const bad = Object.assign(new Error('name is required'), { status: 400 });
    assert.deepStrictEqual(run(bad).body, { error: 'name is required' });

    const gateway = Object.assign(new Error(SECRET), { statusCode: 502 });
    assert.strictEqual(run(gateway).body.error, 'Internal Server Error');
  });

  it('does not echo a database error from an ACL rule that collides on its id', async () => {
    const auth = { Authorization: `Bearer ${fx.tokens.superAdmin}` };
    const body = { id: 'acl-collide', priority: 1, source_cidr: '100.64.1.0/24', destination_cidr: '100.64.2.0/24' };
    const first = await request(app).post('/api/acl/rules').set(auth).send(body);
    assert.strictEqual(first.status, 201);
    const second = await request(app).post('/api/acl/rules').set(auth).send(body);
    assert.ok(second.status >= 500, `expected a server error, got ${second.status}`);
    assert.strictEqual(second.body.error, 'Internal Server Error');
    assert.ok(!/acl_rules|constraint|duplicate/i.test(JSON.stringify(second.body)), JSON.stringify(second.body));
  });

  it('does not echo the internal error of a pre-auth key that cannot be stored', async () => {
    const res = await request(app)
      .post('/api/preauth-keys')
      .set({ Authorization: `Bearer ${fx.tokens.adminA}` })
      .send({ expires_in_hours: 1e15 });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.error, 'Internal Server Error');
  });

  it('does not echo the internal error of a failed netmap build', async () => {
    const reg = await register(
      app,
      { public_key_hex: nodeKey(), role: 'CLIENT_ORIGIN', endpoints: [], capability: { country_code: 'IT' } },
      { token: REGISTRATION_TOKEN }
    );
    assert.strictEqual(reg.status, 200);
    const original = NetmapService.buildNetmap;
    NetmapService.buildNetmap = async () => {
      throw new Error(SECRET);
    };
    try {
      const res = await request(app)
        .post('/v4/control/netmap')
        .set({ Authorization: `Bearer ${reg.body.credential}` })
        .send({ node_id: reg.body.assigned_node_id, version: 0 });
      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.body.error, 'Internal Server Error');
    } finally {
      NetmapService.buildNetmap = original;
    }
  });
});
