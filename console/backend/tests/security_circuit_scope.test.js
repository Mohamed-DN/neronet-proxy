// H3: a circuit is built from the requester's own organisation only. Relays of another
// tenant must never appear as hops, and must not make a short pool look long enough.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createOrgFixture } = require('./helpers/orgFixture');
const { createApp } = require('../server');
const CircuitEngine = require('../modules/onion/CircuitEngine');

describe('H3: circuit hops stay inside the requester organisation', () => {
  let dbHelper;
  let pool;
  let app;
  let fx;
  let n = 0;

  async function addRelay(id, org, userId) {
    n += 1;
    await pool.query(
      `INSERT INTO nodes (id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6, role,
                          country_code, asn, is_healthy, is_quarantined, latency_ms)
       VALUES ($1, $2, $3, $1, $4, $5, $6, 'EXIT_BRIDGE', 'US', $7, TRUE, FALSE, 1)`,
      [id, userId, org, crypto.randomBytes(32).toString('hex'), `100.64.66.${n}`, `fd00:66::${n}`, 1000 + n]
    );
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    fx = await createOrgFixture(pool);
    await pool.query("UPDATE nodes SET role = 'CLIENT_ORIGIN'");
    for (const i of [1, 2, 3, 4]) await addRelay(`relay-a${i}`, fx.orgs.A, fx.ids.adminA);
    for (const i of [1, 2, 3, 4]) await addRelay(`relay-b${i}`, fx.orgs.B, fx.ids.adminB);
    await addRelay('requester-b', fx.orgs.B, fx.ids.memberB);
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('chooses every hop among the nodes of the requesting organisation', async () => {
    for (let i = 0; i < 20; i++) {
      const circuit = await CircuitEngine.buildCircuit({
        requesterNodeId: 'requester-b',
        organizationId: fx.orgs.B,
        targetCountry: 'US'
      });
      for (const hop of circuit.hops) {
        assert.ok(hop.node_id.startsWith('relay-b'), `hop ${hop.node_id} is not an organisation B node`);
      }
    }
  });

  it('does not borrow another organisation relays when its own are too few', async () => {
    await pool.query("UPDATE nodes SET is_healthy = FALSE WHERE id IN ('relay-b3', 'relay-b4')");
    await assert.rejects(
      CircuitEngine.buildCircuit({ requesterNodeId: 'requester-b', organizationId: fx.orgs.B, targetCountry: 'US' }),
      (err) => err instanceof CircuitEngine.CircuitError && err.status === 503
    );
    await pool.query("UPDATE nodes SET is_healthy = TRUE WHERE id IN ('relay-b3', 'relay-b4')");
  });

  it('answers a node of organisation A over HTTP without any organisation B node', async () => {
    await pool.query("UPDATE nodes SET role = 'CLIENT_ORIGIN' WHERE id LIKE 'relay-a%'");
    await addRelay('requester-a', fx.orgs.A, fx.ids.memberA);
    // Organisation A now has no relay or exit of its own, only organisation B does.
    const res = await request(app).post('/v4/control/circuit').send({ target_country: 'US', node_id: 'requester-a' });
    const leaked = JSON.stringify(res.body);
    assert.ok(!leaked.includes('relay-b'), `organisation B nodes leaked: ${leaked}`);
    assert.strictEqual(res.status, 503);
  });
});
