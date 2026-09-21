const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

/**
 * A node can state a city and coordinates. Nothing verifies them, so the control plane
 * stores them and says where they came from: location_source is "declared" for those
 * and null for a node that stated nothing.
 */

const KEY_SYDNEY = 'c1'.repeat(32);
const KEY_NONE = 'c2'.repeat(32);
const KEY_LATE = 'c3'.repeat(32);
const KEY_BAD = 'c4'.repeat(32);

const SYDNEY = { city: 'Sydney', latitude: -33.8688, longitude: 151.2093 };

const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

function registerBody(publicKeyHex, capability) {
  return {
    public_key_hex: publicKeyHex,
    role: 'CLIENT_ORIGIN',
    endpoints: [],
    client_version: '4.0.0',
    capability: { enabled: false, country_code: 'AU', ...capability }
  };
}

function register(app, publicKeyHex, capability) {
  return request(app)
    .post('/v4/control/register')
    .set('Authorization', `Bearer ${REGISTRATION_TOKEN}`)
    .send(registerBody(publicKeyHex, capability));
}

describe('Declared node location', () => {
  let dbHelper;
  let app;
  let token;

  const nodeIdOf = (key) => `pk_${key.slice(0, 16)}`;

  async function apiNode(key) {
    const res = await request(app)
      .get(`/api/nodes/${nodeIdOf(key)}`)
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 200, `node ${key.slice(0, 4)} not readable: ${JSON.stringify(res.body)}`);
    return res.body.node;
  }

  const mismatches = async () =>
    (await dbHelper.pool.query("SELECT * FROM audit_events WHERE event_type = 'node.reregister_mismatch' ORDER BY id"))
      .rows;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();

    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin_password' });
    assert.strictEqual(login.status, 200, `admin login failed: ${JSON.stringify(login.body)}`);
    token = login.body.token;
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('stores what the node declared and reports it as declared', async () => {
    const res = await register(app, KEY_SYDNEY, SYDNEY);
    assert.strictEqual(res.status, 200, `registration failed: ${JSON.stringify(res.body)}`);

    const qRes = await dbHelper.pool.query('SELECT city, latitude, longitude FROM nodes WHERE id = $1', [
      nodeIdOf(KEY_SYDNEY)
    ]);
    const row = qRes.rows[0];
    assert.strictEqual(row.city, 'Sydney');
    assert.strictEqual(Number(row.latitude), SYDNEY.latitude);
    assert.strictEqual(Number(row.longitude), SYDNEY.longitude);

    const node = await apiNode(KEY_SYDNEY);
    assert.strictEqual(node.city, 'Sydney');
    assert.strictEqual(node.latitude, SYDNEY.latitude);
    assert.strictEqual(node.longitude, SYDNEY.longitude);
    assert.strictEqual(node.location_source, 'declared');
  });

  it('lists the declared location in the node list as well', async () => {
    const res = await request(app).get('/api/nodes?limit=200').set('Authorization', `Bearer ${token}`);
    const node = res.body.nodes.find((n) => n.id === nodeIdOf(KEY_SYDNEY));
    assert.ok(node, 'the node is missing from the list');
    assert.strictEqual(node.location_source, 'declared');
    assert.strictEqual(node.latitude, SYDNEY.latitude);
  });

  it('reports no position for a node that declared none', async () => {
    const res = await register(app, KEY_NONE, {});
    assert.strictEqual(res.status, 200);

    const node = await apiNode(KEY_NONE);
    assert.strictEqual(node.latitude, null, 'a coordinate was invented for a node that declared none');
    assert.strictEqual(node.longitude, null);
    assert.strictEqual(node.location_source, null);
  });

  it('accepts the declaration of 0,0 as a position', async () => {
    const key = 'c5'.repeat(32);
    const res = await register(app, key, { city: 'Null Island', latitude: 0, longitude: 0 });
    assert.strictEqual(res.status, 200);

    const node = await apiNode(key);
    assert.strictEqual(node.latitude, 0);
    assert.strictEqual(node.longitude, 0);
    assert.strictEqual(node.location_source, 'declared');
  });

  it('refuses coordinates that are not a valid pair', async () => {
    const cases = {
      'latitude alone': { latitude: 10 },
      'longitude alone': { longitude: 10 },
      'latitude out of range': { latitude: 91, longitude: 0 },
      'longitude out of range': { latitude: 0, longitude: 181 },
      strings: { latitude: '10', longitude: '20' },
      'null and a number': { latitude: null, longitude: 20 }
    };

    for (const [name, capability] of Object.entries(cases)) {
      const res = await register(app, KEY_BAD, capability);
      assert.strictEqual(res.status, 400, `${name} was accepted: ${JSON.stringify(res.body)}`);
    }

    const qRes = await dbHelper.pool.query('SELECT id FROM nodes WHERE id = $1', [nodeIdOf(KEY_BAD)]);
    const stored = qRes.rows[0];
    assert.strictEqual(stored, undefined, 'a rejected registration still created a node');
  });

  it('keeps the stored position when a re-registration declares another one', async () => {
    const beforeList = await mismatches();
    const before = beforeList.length;
    const res = await register(app, KEY_SYDNEY, { city: 'Perth', latitude: -31.9505, longitude: 115.8605 });
    assert.strictEqual(res.status, 200);

    const node = await apiNode(KEY_SYDNEY);
    assert.strictEqual(node.city, 'Sydney');
    assert.strictEqual(node.latitude, SYDNEY.latitude);
    assert.strictEqual(node.longitude, SYDNEY.longitude);

    const afterList = await mismatches();
    const events = afterList.slice(before);
    assert.strictEqual(events.length, 1, 'the attempt to move the node left no audit event');
    const metadata =
      typeof events[0].metadata_json === 'string' ? JSON.parse(events[0].metadata_json) : events[0].metadata_json;
    assert.deepStrictEqual(metadata.changed, ['latitude', 'longitude']);
  });

  it('does not report a mismatch when the same position is declared again', async () => {
    const beforeList = await mismatches();
    const before = beforeList.length;
    const res = await register(app, KEY_SYDNEY, SYDNEY);
    assert.strictEqual(res.status, 200);
    const afterList = await mismatches();
    assert.strictEqual(afterList.length, before);
  });

  it('gives a position to a node that enrolled without one and declares it later', async () => {
    const first = await register(app, KEY_LATE, {});
    assert.strictEqual(first.status, 200);
    assert.strictEqual((await apiNode(KEY_LATE)).location_source, null);

    const second = await register(app, KEY_LATE, { city: 'Reykjavik', latitude: 64.1466, longitude: -21.9426 });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.overlay_ipv4, first.body.overlay_ipv4, 'the node lost its address');

    const node = await apiNode(KEY_LATE);
    assert.strictEqual(node.city, 'Reykjavik');
    assert.strictEqual(node.latitude, 64.1466);
    assert.strictEqual(node.location_source, 'declared');
  });

  it('keeps other metadata when it marks the position as declared', async () => {
    const key = 'c6'.repeat(32);
    await register(app, key, {});
    await dbHelper.pool.query('UPDATE nodes SET metadata = $1::jsonb WHERE id = $2', [
      JSON.stringify({ label: 'kept' }),
      nodeIdOf(key)
    ]);

    await register(app, key, SYDNEY);

    const node = await apiNode(key);
    assert.strictEqual(node.location_source, 'declared');
    assert.strictEqual(node.metadata.label, 'kept');
  });
});
