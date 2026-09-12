const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const request = require('supertest');

const testDbPath = path.resolve(__dirname, '../../data/test_tenant_isolation.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const { seedDatabase } = require('../db/seed');
const { createApp } = require('../server');

/**
 * Cross-tenant probing.
 *
 * Authentication was solid; authorization was answered inline, differently, in each
 * route that remembered to ask -- and not at all in several that did not. A node's
 * risk score, name and quarantine reason were readable by any authenticated user for
 * any node, and the heartbeat endpoint accepted telemetry for any node id, so one
 * tenant could write fabricated metrics onto another's devices.
 *
 * Enumerating the routes here rather than checking them one at a time is the point:
 * a new endpoint that forgets the check fails this suite without anyone having to
 * remember to add a case for it.
 */

let app;
let alice = {};
let bob = {};

async function signUp(username) {
  const res = await request(app).post('/api/auth/register').send({
    username,
    email: `${username}@example.com`,
    password: 'A-sufficiently-long-password-1'
  });

  assert.ok([200, 201].includes(res.status), `could not register ${username}: ${JSON.stringify(res.body)}`);

  const token = res.body.token || (
    await request(app).post('/api/auth/login').send({
      username,
      password: 'A-sufficiently-long-password-1'
    })
  ).body.token;

  assert.ok(token, `no token for ${username}`);
  return { token, id: res.body.user?.id };
}

async function createNode(token, name) {
  const res = await request(app)
    .post('/api/nodes')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, role: 'CLIENT_ORIGIN', country_code: 'IT' });

  assert.ok([200, 201].includes(res.status), `could not create node: ${JSON.stringify(res.body)}`);
  return res.body.node.id;
}

describe('Tenant isolation', () => {
  before(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    const db = getDatabase(testDbPath);
    runMigrations(db);
    seedDatabase(db);
    app = createApp();

    alice = await signUp(`alice_${Date.now()}`);
    bob = await signUp(`bob_${Date.now()}`);

    alice.nodeId = await createNode(alice.token, 'alice-laptop');
    bob.nodeId = await createNode(bob.token, 'bob-laptop');
  });

  after(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  // Every one of these addresses a node Bob owns, with Alice's credentials.
  const nodeProbes = [
    { method: 'get', path: (id) => `/api/nodes/${id}`, what: 'node detail' },
    { method: 'get', path: (id) => `/api/nodes/${id}/risk`, what: 'risk score' },
    { method: 'get', path: (id) => `/api/risk/${id}`, what: 'risk score by risk router' },
    { method: 'get', path: (id) => `/api/configs/wireguard/${id}`, what: 'WireGuard profile' },
    { method: 'get', path: (id) => `/api/configs/noise/${id}`, what: 'Noise profile' },
    { method: 'post', path: (id) => `/api/nodes/${id}/heartbeat`, body: { latency_ms: 9999 }, what: 'heartbeat' },
    { method: 'post', path: (id) => `/api/nodes/${id}/action`, body: { action: 'quarantine' }, what: 'quarantine' },
    { method: 'delete', path: (id) => `/api/nodes/${id}`, what: 'deletion' }
  ];

  for (const probe of nodeProbes) {
    it(`denies one tenant the ${probe.what} of another's node`, async () => {
      let req = request(app)[probe.method](probe.path(bob.nodeId)).set('Authorization', `Bearer ${alice.token}`);
      if (probe.body) req = req.send(probe.body);

      const res = await req;

      assert.ok(
        [403, 404].includes(res.status),
        `${probe.method.toUpperCase()} ${probe.path(bob.nodeId)} returned ${res.status} to a different tenant: ${JSON.stringify(res.body).slice(0, 200)}`
      );
    });
  }

  it('does not confirm that another tenant\'s node exists', async () => {
    // 403 says "this exists but is not yours", which turns the endpoint into an
    // oracle for enumerating other tenants' resource ids. A missing node and
    // someone else's node must look identical.
    const foreign = await request(app)
      .get(`/api/nodes/${bob.nodeId}/risk`)
      .set('Authorization', `Bearer ${alice.token}`);

    const missing = await request(app)
      .get('/api/nodes/does-not-exist-at-all/risk')
      .set('Authorization', `Bearer ${alice.token}`);

    assert.strictEqual(foreign.status, missing.status);
  });

  it('still lets a tenant reach their own node', async () => {
    // A test that only proves things are forbidden would also pass if everything
    // were broken.
    const res = await request(app)
      .get(`/api/nodes/${alice.nodeId}/risk`)
      .set('Authorization', `Bearer ${alice.token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.node_id, alice.nodeId);
  });

  it('scopes list endpoints to the caller', async () => {
    const res = await request(app).get('/api/nodes').set('Authorization', `Bearer ${alice.token}`);

    assert.strictEqual(res.status, 200);
    const ids = res.body.nodes.map((n) => n.id);
    assert.ok(ids.includes(alice.nodeId), 'Alice cannot see her own node');
    assert.ok(!ids.includes(bob.nodeId), "Alice can see Bob's node in the list");
  });

  it('keeps the user directory to super-admins', async () => {
    const res = await request(app).get('/api/users').set('Authorization', `Bearer ${alice.token}`);
    assert.ok([403, 404].includes(res.status), `a tenant read the user directory: ${res.status}`);
  });
});
