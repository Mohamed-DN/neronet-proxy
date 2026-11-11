// H2: one WireGuard key must not be registrable twice by changing its spelling. The
// column is a case-sensitive string, and a netmap with the same key twice is a document
// every node of the organisation refuses, so the mesh stops once it goes stale.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createOrgFixture } = require('./helpers/orgFixture');
const { createApp } = require('../server');
const NetmapService = require('../services/NetmapService');

const rawKey = () => crypto.randomBytes(32);

describe('H2: duplicate public key in two encodings', () => {
  let dbHelper;
  let pool;
  let app;
  let fx;
  const auth = (name) => ({ Authorization: `Bearer ${fx.tokens[name]}` });
  const createNode = (name, body) => request(app).post('/api/nodes').set(auth(name)).send(body);

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    fx = await createOrgFixture(pool);
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('refuses a key that does not decode to 32 bytes', async () => {
    for (const bad of ['abc', 'g'.repeat(64), 'A'.repeat(44), 'x'.repeat(42) + '==', '00'.repeat(31)]) {
      const res = await createNode('memberA', { name: 'bad', public_key: bad });
      assert.strictEqual(res.status, 400, `accepted ${bad}`);
    }
  });

  it('refuses the same key in upper-case hex and in base64 once it is registered in lower-case hex', async () => {
    const raw = rawKey();
    const first = await createNode('memberA', { name: 'first', public_key: raw.toString('hex') });
    assert.strictEqual(first.status, 201);

    const upper = await createNode('memberA', { name: 'upper', public_key: raw.toString('hex').toUpperCase() });
    assert.strictEqual(upper.status, 409, 'upper-case spelling of a registered key must be refused');

    const b64 = await createNode('memberA', { name: 'b64', public_key: raw.toString('base64') });
    assert.strictEqual(b64.status, 409, 'base64 spelling of a registered key must be refused');

    const rows = await pool.query('SELECT count(*)::int AS n FROM nodes WHERE name IN ($1, $2)', ['upper', 'b64']);
    assert.strictEqual(rows.rows[0].n, 0);
  });

  it('refuses the hex spelling of a key registered in base64, across organisations', async () => {
    const raw = rawKey();
    const first = await createNode('memberA', { name: 'b64-first', public_key: raw.toString('base64') });
    assert.strictEqual(first.status, 201);
    const second = await createNode('memberB', { name: 'hex-second', public_key: raw.toString('hex') });
    assert.strictEqual(second.status, 409);
  });

  it('stores a new key in the form it was sent', async () => {
    const hex = rawKey().toString('hex');
    const res = await createNode('memberA', { name: 'as-sent', public_key: hex });
    assert.strictEqual(res.status, 201);
    const row = await pool.query('SELECT public_key FROM nodes WHERE id = $1', [res.body.node.id]);
    assert.strictEqual(row.rows[0].public_key, hex);
  });

  it('refuses a profile device whose key is already a node in another spelling', async () => {
    const raw = rawKey();
    const gwKey = rawKey().toString('base64');
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role,
                          is_healthy, is_quarantined, profile_gateway_endpoint)
       VALUES ('node-sec-gw', $1, $2, 'gw', '100.64.77.1', 'fd00:77::1', $3, 'RELAY', TRUE, FALSE, 'gw.example:51820')`,
      [fx.orgs.A, fx.ids.adminA, gwKey]
    );
    const hexNode = await createNode('memberA', { name: 'hexnode', public_key: raw.toString('hex') });
    assert.strictEqual(hexNode.status, 201);

    const res = await request(app)
      .post('/api/devices/profile')
      .set(auth('memberA'))
      .send({ name: 'phone', public_key: raw.toString('base64'), preshared_key: rawKey().toString('base64') });
    assert.strictEqual(res.status, 409);
  });

  it('lists a key once in a netmap built from a database that already holds a duplicate', async () => {
    const raw = rawKey();
    const lower = raw.toString('hex');
    const mk = async (id, key, n) =>
      pool.query(
        `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role,
                            is_healthy, is_quarantined)
         VALUES ($1, $2, $3, $1, $4, $5, $6, 'CLIENT_ORIGIN', TRUE, FALSE)`,
        [id, fx.orgs.A, fx.ids.adminA, `100.64.88.${n}`, `fd00:88::${n}`, key]
      );
    await mk('node-dup-self', crypto.randomBytes(32).toString('hex'), 1);
    await mk('node-dup-a', lower, 2);
    await mk('node-dup-b', lower.toUpperCase(), 3);
    await mk('node-dup-c', raw.toString('base64'), 4);
    await pool.query("UPDATE organizations SET default_policy = 'open' WHERE id = $1", [fx.orgs.A]);

    const doc = await NetmapService.buildNetmap('node-dup-self');
    const keys = doc.peers.map((p) => p.public_key_hex);
    assert.strictEqual(keys.filter((k) => k === lower).length, 1, `peers: ${JSON.stringify(keys)}`);
    assert.strictEqual(new Set(keys).size, keys.length);
    assert.strictEqual(doc.peers.find((p) => p.public_key_hex === lower).node_id, 'node-dup-a', 'lowest id wins');
  });
});
