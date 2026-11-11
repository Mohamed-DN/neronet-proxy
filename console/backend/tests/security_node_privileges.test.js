// H3: a plain member may register and edit their own client node, nothing that places it
// in other people's circuits (role, latency, health) and nothing that lifts a quarantine.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createOrgFixture } = require('./helpers/orgFixture');
const { createApp } = require('../server');

const hexKey = () => crypto.randomBytes(32).toString('hex');

describe('H3: node privileges by organisation role', () => {
  let dbHelper;
  let pool;
  let app;
  let fx;
  const auth = (name) => ({ Authorization: `Bearer ${fx.tokens[name]}` });
  const create = (who, body) =>
    request(app)
      .post('/api/nodes')
      .set(auth(who))
      .send({ name: 'n', public_key: hexKey(), ...body });
  const update = (who, id, body) => request(app).put(`/api/nodes/${id}`).set(auth(who)).send(body);
  const roleOf = async (id) => (await pool.query('SELECT role FROM nodes WHERE id = $1', [id])).rows[0].role;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    fx = await createOrgFixture(pool);
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('creation', () => {
    it('refuses a member who asks for any role but CLIENT_ORIGIN', async () => {
      for (const role of ['EXIT_BRIDGE', 'RELAY', 'HYBRID']) {
        const res = await create('memberA', { role });
        assert.strictEqual(res.status, 403, `member created a ${role}`);
      }
    });

    it('lets a member create a client node, with or without naming the role', async () => {
      assert.strictEqual((await create('memberA', { role: 'CLIENT_ORIGIN' })).status, 201);
      const plain = await create('memberA', {});
      assert.strictEqual(plain.status, 201);
      assert.strictEqual(plain.body.node.role, 'CLIENT_ORIGIN');
    });

    it('refuses a member who sets latency, health or status fields instead of ignoring them', async () => {
      for (const body of [{ latency_ms: 1 }, { is_healthy: true }, { status: 'active' }, { is_quarantined: false }]) {
        const res = await create('memberA', body);
        assert.strictEqual(res.status, 403, `member sent ${JSON.stringify(body)}`);
      }
    });

    it('refuses a role outside the list with 400, for a member and for an administrator', async () => {
      for (const who of ['memberA', 'adminA']) {
        assert.strictEqual((await create(who, { role: 'ROOT' })).status, 400, who);
        assert.strictEqual((await create(who, { role: 42 })).status, 400, who);
      }
    });

    it('lets owner, admin, network_admin and the platform super-admin create an exit', async () => {
      for (const who of ['ownerA', 'adminA', 'netAdminA', 'superAdmin']) {
        const res = await create(who, { role: 'EXIT_BRIDGE' });
        assert.strictEqual(res.status, 201, `${who}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.node.role, 'EXIT_BRIDGE');
      }
    });

    it('refuses endpoints that are not public ip:port, and stores valid ones', async () => {
      for (const endpoints of [['not-an-endpoint'], ['127.0.0.1:51820'], ['198.51.100.7:99999'], 'x:1', [{}]]) {
        const res = await create('adminA', { endpoints });
        assert.strictEqual(res.status, 400, `accepted ${JSON.stringify(endpoints)}`);
      }
      const ok = await create('adminA', { endpoints: ['198.51.100.7:51820'] });
      assert.strictEqual(ok.status, 201);
      assert.deepStrictEqual(ok.body.node.endpoints, ['198.51.100.7:51820']);
    });
  });

  describe('update', () => {
    let nodeId;
    before(async () => {
      nodeId = (await create('memberA', {})).body.node.id;
    });

    it('lets a member rename and set the kill switch on their own node', async () => {
      const res = await update('memberA', nodeId, { name: 'renamed', kill_switch_enabled: true });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.node.name, 'renamed');
    });

    it('refuses a member who promotes their node, and leaves the row unchanged', async () => {
      for (const role of ['EXIT_BRIDGE', 'RELAY', 'HYBRID']) {
        assert.strictEqual((await update('memberA', nodeId, { role })).status, 403, role);
      }
      assert.strictEqual(await roleOf(nodeId), 'CLIENT_ORIGIN');
    });

    it('refuses a member who sets latency, health or status', async () => {
      for (const body of [{ latency_ms: 1 }, { is_healthy: false }, { status: 'active' }, { status: 'quarantined' }]) {
        assert.strictEqual((await update('memberA', nodeId, body)).status, 403, JSON.stringify(body));
      }
      const row = (await pool.query('SELECT latency_ms, is_healthy FROM nodes WHERE id = $1', [nodeId])).rows[0];
      assert.strictEqual(Number(row.latency_ms), 15);
      assert.strictEqual(row.is_healthy, true);
    });

    it('refuses an unknown role with 400 even for an administrator', async () => {
      assert.strictEqual((await update('adminA', nodeId, { role: 'ROOT' })).status, 400);
      assert.strictEqual(await roleOf(nodeId), 'CLIENT_ORIGIN');
    });

    it('lets an administrator set role and latency', async () => {
      const res = await update('netAdminA', nodeId, { role: 'RELAY', latency_ms: 20 });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(await roleOf(nodeId), 'RELAY');
      await pool.query("UPDATE nodes SET role = 'CLIENT_ORIGIN' WHERE id = $1", [nodeId]);
    });

    it('refuses the set_exit action to a member and allows it to an administrator', async () => {
      const act = (who) => request(app).post(`/api/nodes/${nodeId}/action`).set(auth(who)).send({ action: 'set_exit' });
      assert.strictEqual((await act('memberA')).status, 403);
      assert.strictEqual(await roleOf(nodeId), 'CLIENT_ORIGIN');
      assert.strictEqual((await act('adminA')).status, 200);
      assert.strictEqual(await roleOf(nodeId), 'EXIT_BRIDGE');
      await pool.query("UPDATE nodes SET role = 'CLIENT_ORIGIN' WHERE id = $1", [nodeId]);
    });
  });

  describe('quarantine', () => {
    let nodeId;
    const quarantine = () =>
      pool.query('UPDATE nodes SET is_quarantined = TRUE, is_healthy = FALSE, quarantine_reason = $2 WHERE id = $1', [
        nodeId,
        'incident'
      ]);
    const quarantined = async () =>
      (await pool.query('SELECT is_quarantined FROM nodes WHERE id = $1', [nodeId])).rows[0].is_quarantined;
    before(async () => {
      nodeId = (await create('memberA', {})).body.node.id;
    });

    it('does not let the node owner lift the quarantine through any of the three routes', async () => {
      await quarantine();
      assert.strictEqual(
        (await request(app).post(`/api/nodes/${nodeId}/unquarantine`).set(auth('memberA')).send({})).status,
        403
      );
      assert.strictEqual(
        (
          await request(app)
            .post(`/api/nodes/${nodeId}/action`)
            .set(auth('memberA'))
            .send({ action: 'lift_quarantine' })
        ).status,
        403
      );
      assert.strictEqual((await update('memberA', nodeId, { status: 'active' })).status, 403);
      assert.strictEqual(await quarantined(), true);
    });

    it('lets an administrator lift it', async () => {
      const res = await request(app).post(`/api/nodes/${nodeId}/unquarantine`).set(auth('adminA')).send({});
      assert.strictEqual(res.status, 200);
      assert.strictEqual(await quarantined(), false);
    });
  });
});
