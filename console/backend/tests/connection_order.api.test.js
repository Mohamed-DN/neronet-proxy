// ADR 0037 through the API: storage per scope, who may write it, the safety refusal, the preview,
// the netmap fields, and the profile flow following the order. The resolution rules themselves
// are covered without a database in connection_order.resolve.test.js.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { nodeKey, register: enrolNode } = require('./helpers/nodeEnrolment');
const { createApp } = require('../server');
const NetmapService = require('../services/NetmapService');
const { settleAuditWrites } = require('../utils/audit');

const key = () => crypto.randomBytes(32).toString('base64');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const WG = 'wireguard';
const WSS = 'wireguard-wss';
const AWG = 'amneziawg';

describe('ADR 0037: connection order through the API', () => {
  const ORG = 'org-co-a';
  const OTHER = 'org-co-b';
  let db;
  let pool;
  let app;
  let admin;
  let netAdmin;
  let member;
  let stranger;
  let otherAdmin;
  let gw;
  let plainGw;
  const WSS_ENV = { prefix: process.env.NERONET_WSS_PATH_PREFIX, url: process.env.NERONET_WSS_PUBLIC_URL };

  const get = (path, token) => request(app).get(`/api/connection-order${path}`).set(auth(token));
  const put = (path, token, body) => request(app).put(`/api/connection-order${path}`).set(auth(token)).send(body);
  const preview = (token, body) => request(app).post('/api/connection-order/preview').set(auth(token)).send(body);
  const addDevice = (token, body = {}) =>
    request(app)
      .post('/api/devices/profile')
      .set(auth(token))
      .send({ name: 'phone', public_key: key(), preshared_key: key(), ...body });
  const methods = (token) => request(app).get('/api/devices/profile/methods').set(auth(token));

  async function enrol(name, org) {
    const publicKeyHex = nodeKey();
    const res = await enrolNode(app, { public_key_hex: publicKeyHex, role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const id = res.body.assigned_node_id;
    await pool.query('UPDATE nodes SET organization_id = $1, name = $2 WHERE id = $3', [org, name, id]);
    return { id };
  }

  const setOrg = (body) => put('/organization', admin, body);
  const deviceIn = async (token, body) => {
    const res = await addDevice(token, body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.device_id;
  };
  const peerOf = async (gateway, deviceId) =>
    (await NetmapService.buildNetmap(gateway.id)).peers.find((p) => p.node_id === deviceId);

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ($1, 'CO A', 'co-a', 'deny'), ($2, 'CO B', 'co-b', 'deny')`,
      [ORG, OTHER]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-co-admin', 'coadmin', 'a@co.local', 'x', 'admin', $1),
         ('usr-co-net', 'conet', 'n@co.local', 'x', 'user', $1),
         ('usr-co-member', 'comember', 'm@co.local', 'x', 'user', $1),
         ('usr-co-stranger', 'costranger', 's@co.local', 'x', 'user', $1),
         ('usr-co-badmin', 'cobadmin', 'b@co.local', 'x', 'admin', $2)`,
      [ORG, OTHER]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-co-admin', 'usr-co-admin', $1, 'admin'),
         ('mem-co-net', 'usr-co-net', $1, 'network_admin'),
         ('mem-co-member', 'usr-co-member', $1, 'member'),
         ('mem-co-stranger', 'usr-co-stranger', $1, 'member'),
         ('mem-co-badmin', 'usr-co-badmin', $2, 'admin')`,
      [ORG, OTHER]
    );
    await pool.query(
      `INSERT INTO compartments (id, organization_id, name, slug) VALUES
         ('cmp-co-travel', $1, 'Viaggiatori', 'travel'), ('cmp-co-office', $1, 'Ufficio', 'office'),
         ('cmp-co-foreign', $2, 'Altrove', 'elsewhere')`,
      [ORG, OTHER]
    );
    const token = (id, username, role, org) =>
      issueConsoleTestToken({ sub: id, id, username, role, organization_id: org });
    admin = await token('usr-co-admin', 'coadmin', 'admin', ORG);
    netAdmin = await token('usr-co-net', 'conet', 'user', ORG);
    member = await token('usr-co-member', 'comember', 'user', ORG);
    stranger = await token('usr-co-stranger', 'costranger', 'user', ORG);
    otherAdmin = await token('usr-co-badmin', 'cobadmin', 'admin', OTHER);
    gw = await enrol('gw-awg', ORG);
    plainGw = await enrol('gw-plain', ORG);
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM nodes WHERE device_kind = 'profile'");
    await pool.query('DELETE FROM user_connection_orders');
    await pool.query(
      `UPDATE organizations SET allowed_access_methods = ARRAY['wireguard','wireguard-wss','amneziawg']::text[],
              connection_order = NULL, connection_forced = FALSE, members_choose_connection = FALSE,
              awg_params = NULL WHERE id IN ($1, $2)`,
      [ORG, OTHER]
    );
    await pool.query(
      `UPDATE compartments SET connection_order = NULL, connection_forced = FALSE, connection_locked = FALSE`
    );
    await pool.query(
      `UPDATE nodes SET profile_gateway_endpoint = NULL, is_default_profile_gateway = FALSE,
              node_capabilities = '{}', awg_port = NULL WHERE id IN ($1, $2)`,
      [gw.id, plainGw.id]
    );
    await pool.query(
      `UPDATE nodes SET profile_gateway_endpoint = 'gw.example.com:51820', is_default_profile_gateway = TRUE,
              node_capabilities = ARRAY['awg-v1']::text[], awg_port = 51821 WHERE id = $1`,
      [gw.id]
    );
    await pool.query(`UPDATE nodes SET profile_gateway_endpoint = 'plain.example.com:51820' WHERE id = $1`, [
      plainGw.id
    ]);
    // AmneziaWG parameters exist so the method is usable where a gateway runs it.
    await request(app)
      .put(`/api/organizations/${ORG}/access-methods`)
      .set(auth(admin))
      .send({ wireguard_wss: true, amneziawg: true });
    process.env.NERONET_WSS_PATH_PREFIX = crypto.randomBytes(24).toString('hex');
    process.env.NERONET_WSS_PUBLIC_URL = 'wss://vpn.example.com';
  });

  after(async () => {
    for (const [name, value] of [
      ['NERONET_WSS_PATH_PREFIX', WSS_ENV.prefix],
      ['NERONET_WSS_PUBLIC_URL', WSS_ENV.url]
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (db) await db.cleanup();
  });

  describe('organisation', () => {
    it('answers Automatico by default', async () => {
      const res = await get('/organization', member);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.effective.order, [WG, WSS, AWG]);
      assert.equal(res.body.effective.origin.scope, 'default');
      assert.equal(res.body.own.order, null);
      assert.equal(res.body.members_may_choose, false);
    });

    it('lets only an owner or admin write it', async () => {
      assert.equal((await put('/organization', member, { order: [WG] })).status, 403);
      assert.equal((await put('/organization', netAdmin, { order: [WG] })).status, 403);
      assert.equal((await put('/organization', admin, { order: [WSS, WG] })).status, 200);
    });

    it('stores order, forced flag and members_may_choose, and returns the effective order', async () => {
      const res = await setOrg({ order: [WSS, WG], forced: true, members_may_choose: true });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.effective.order, [WSS]);
      assert.equal(res.body.effective.forced, true);
      assert.equal(res.body.members_may_choose, true);
      const row = (await pool.query('SELECT * FROM organizations WHERE id = $1', [ORG])).rows[0];
      assert.deepEqual(row.connection_order, [WSS, WG]);
      assert.equal(row.connection_forced, true);
      assert.equal(row.members_choose_connection, true);
    });

    it('refuses invalid input with a code', async () => {
      const code = async (body) => {
        const res = await setOrg(body);
        assert.equal(res.status, 400, JSON.stringify(body));
        return res.body.code;
      };
      assert.equal(await code({ order: [] }), 'invalid_order');
      assert.equal(await code({ order: [WG, WG] }), 'invalid_order');
      assert.equal(await code({ order: ['bogus'] }), 'invalid_order');
      assert.equal(await code({ order: [WG, 'vless-reality'] }), 'method_reserved');
      assert.equal(await code({ order: [WG], forced: 'yes' }), 'invalid_flag');
      assert.equal(await code({ forced: true }), 'forced_needs_order');
    });

    it('refuses a method the ceiling does not allow', async () => {
      await request(app)
        .put(`/api/organizations/${ORG}/access-methods`)
        .set(auth(admin))
        .send({ wireguard_wss: false, amneziawg: false });
      const res = await setOrg({ order: [WG, WSS] });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'method_not_allowed');
      assert.deepEqual(res.body.methods, [WSS]);
    });

    it('goes back to Automatico with null', async () => {
      await setOrg({ order: [AWG, WG] });
      const res = await setOrg({ order: null });
      assert.equal(res.status, 200);
      assert.equal(res.body.effective.origin.scope, 'default');
      assert.equal(res.body.own.forced, false);
    });

    it('audits before and after, with methods only', async () => {
      await setOrg({ order: [WSS, WG] });
      await setOrg({ order: [WG], forced: true });
      await settleAuditWrites();
      const rows = (
        await pool.query(
          "SELECT metadata_json FROM audit_events WHERE event_type = 'CONNECTION_ORDER_UPDATED' ORDER BY id DESC LIMIT 1"
        )
      ).rows;
      const meta =
        typeof rows[0].metadata_json === 'string' ? JSON.parse(rows[0].metadata_json) : rows[0].metadata_json;
      assert.equal(meta.scope, 'organization');
      assert.deepEqual(meta.before.order, [WSS, WG]);
      assert.deepEqual(meta.after.order, [WG]);
      assert.equal(meta.after.forced, true);
    });
  });

  describe('line', () => {
    it('is written by an owner, admin or network admin, never a member', async () => {
      assert.equal((await put('/lines/cmp-co-travel', member, { order: [WG] })).status, 403);
      assert.equal((await put('/lines/cmp-co-travel', netAdmin, { order: [WSS, WG] })).status, 200);
      assert.equal((await put('/lines/cmp-co-travel', admin, { order: [WG, WSS] })).status, 200);
    });

    it('is invisible across organisations', async () => {
      assert.equal((await get('/lines/cmp-co-foreign', admin)).status, 404);
      assert.equal((await put('/lines/cmp-co-foreign', admin, { order: [WG] })).status, 404);
      assert.equal((await put('/lines/cmp-co-travel', otherAdmin, { order: [WG] })).status, 404);
    });

    it('shows its own setting, what it would inherit, and the effective order', async () => {
      await setOrg({ order: [WSS, WG] });
      const res = await put('/lines/cmp-co-travel', admin, { order: [WG, WSS], locked: true });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.own, { order: [WG, WSS], forced: false, locked: true });
      assert.deepEqual(res.body.inherited.order, [WSS, WG]);
      assert.deepEqual(res.body.effective.order, [WG, WSS]);
      assert.equal((await get('/lines/cmp-co-office', member)).body.effective.origin.scope, 'organization');
    });

    it('refuses a method above the ceiling', async () => {
      await request(app)
        .put(`/api/organizations/${ORG}/access-methods`)
        .set(auth(admin))
        .send({ wireguard_wss: true, amneziawg: false });
      const res = await put('/lines/cmp-co-travel', admin, { order: [AWG, WG] });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'method_not_allowed');
    });
  });

  describe('device', () => {
    it('is written by an administrator, and the origin names the line when it inherits', async () => {
      const id = await deviceIn(member);
      await pool.query("UPDATE nodes SET compartment_id = 'cmp-co-travel' WHERE id = $1", [id]);
      await put('/lines/cmp-co-travel', admin, { order: [WSS, WG] });
      const inherit = await get(`/devices/${id}`, admin);
      assert.deepEqual(inherit.body.effective.origin, { scope: 'line', id: 'cmp-co-travel', name: 'Viaggiatori' });
      assert.deepEqual(inherit.body.effective.order, [WSS, WG]);

      const own = await put(`/devices/${id}`, admin, { order: [WG, WSS], forced: true });
      assert.equal(own.status, 200, JSON.stringify(own.body));
      assert.deepEqual(own.body.effective.order, [WG]);
      assert.equal(own.body.effective.origin.scope, 'device');
      assert.deepEqual(own.body.inherited.order, [WSS, WG]);
    });

    it('is visible only to administrators and its owner', async () => {
      const id = await deviceIn(member);
      assert.equal((await get(`/devices/${id}`, member)).status, 200);
      assert.equal((await get(`/devices/${id}`, stranger)).status, 404);
      assert.equal((await put(`/devices/${id}`, stranger, { order: [WG] })).status, 404);
      assert.equal((await get(`/devices/${id}`, otherAdmin)).status, 404);
    });

    it('lets the owner choose only when members may choose, and never lock', async () => {
      const id = await deviceIn(member);
      const off = await put(`/devices/${id}`, member, { order: [WSS, WG] });
      assert.equal(off.status, 403);
      assert.equal(off.body.code, 'members_may_not_choose');
      assert.equal((await get(`/devices/${id}`, member)).body.can_edit, false);

      await setOrg({ members_may_choose: true });
      assert.equal((await get(`/devices/${id}`, member)).body.can_edit, true);
      const on = await put(`/devices/${id}`, member, { order: [WSS, WG] });
      assert.equal(on.status, 200, JSON.stringify(on.body));
      assert.deepEqual(on.body.effective.order, [WSS, WG]);
      const lock = await put(`/devices/${id}`, member, { order: [WG], locked: true });
      assert.equal(lock.status, 403);
      assert.equal(lock.body.code, 'admin_only');
    });

    it('stops the owner when an administrator locked the device or its line', async () => {
      await setOrg({ members_may_choose: true });
      const id = await deviceIn(member);
      await put(`/devices/${id}`, admin, { order: [WG], locked: true });
      const res = await put(`/devices/${id}`, member, { order: [WSS, WG] });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'locked');
      assert.equal((await get(`/devices/${id}`, member)).body.can_edit, false);

      await put(`/devices/${id}`, admin, { order: null, locked: false });
      await pool.query("UPDATE nodes SET compartment_id = 'cmp-co-travel' WHERE id = $1", [id]);
      await put('/lines/cmp-co-travel', admin, { locked: true });
      assert.equal((await put(`/devices/${id}`, member, { order: [WG] })).status, 403);
    });

    it('keeps a device inside what its line enables', async () => {
      const id = await deviceIn(member);
      await pool.query("UPDATE nodes SET compartment_id = 'cmp-co-travel' WHERE id = $1", [id]);
      await put('/lines/cmp-co-travel', admin, { order: [WG, WSS] });
      const res = await put(`/devices/${id}`, admin, { order: [AWG, WG] });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'method_not_allowed');
      assert.deepEqual(res.body.methods, [AWG]);
    });

    it('puts the effective order and its origin in the netmap of the serving gateway', async () => {
      const id = await deviceIn(member);
      await pool.query("UPDATE nodes SET compartment_id = 'cmp-co-travel' WHERE id = $1", [id]);
      const plain = await peerOf(gw, id);
      assert.deepEqual(plain.connection_order, [WG, WSS, AWG]);
      assert.deepEqual(plain.connection_origin, { scope: 'default' });

      await put('/lines/cmp-co-travel', admin, { order: [WSS, WG] });
      const viaLine = await peerOf(gw, id);
      assert.deepEqual(viaLine.connection_order, [WSS, WG]);
      assert.deepEqual(viaLine.connection_origin, { scope: 'line', id: 'cmp-co-travel', name: 'Viaggiatori' });

      await put(`/devices/${id}`, admin, { order: [WG], forced: true });
      const own = await peerOf(gw, id);
      assert.deepEqual(own.connection_order, [WG]);
      assert.equal(own.connection_origin.scope, 'device');
    });

    it('filters the netmap order to what the serving gateway runs', async () => {
      const id = await deviceIn(admin, { gateway_node_id: plainGw.id });
      const peer = await peerOf(plainGw, id);
      assert.deepEqual(peer.connection_order, [WG, WSS]);
    });
  });

  describe('person', () => {
    it('is refused until the organisation lets members choose', async () => {
      const res = await put('/me', member, { order: [WSS, WG] });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'members_may_not_choose');
      assert.equal((await get('/me', member)).body.members_may_choose, false);
    });

    it('applies to the persons new devices and to the methods the profile flow offers', async () => {
      await setOrg({ members_may_choose: true });
      const res = await put('/me', member, { order: [WSS, WG] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.effective.origin.scope, 'person');

      const offered = await methods(member);
      assert.equal(offered.body.default, WSS);
      assert.deepEqual(
        offered.body.methods.map((m) => m.id),
        [WSS, WG]
      );
      // Another person is not affected.
      assert.equal((await methods(stranger)).body.default, WG);

      const id = await deviceIn(member);
      const row = (await pool.query('SELECT access_method FROM nodes WHERE id = $1', [id])).rows[0];
      assert.equal(row.access_method, WSS, 'the profile is written for the first method');
      const peer = await peerOf(gw, id);
      assert.deepEqual(peer.connection_order, [WSS, WG]);
      assert.equal(peer.connection_origin.scope, 'person');
    });

    it('can force one method, and a method outside the order is not made', async () => {
      await setOrg({ members_may_choose: true });
      await put('/me', member, { order: [WSS, WG], forced: true });
      assert.deepEqual(
        (await methods(member)).body.methods.map((m) => m.id),
        [WSS]
      );
      const res = await addDevice(member, { access_method: WG });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'method_not_in_order');
      assert.equal((await addDevice(member, { access_method: WSS })).status, 201);
    });

    it('does not apply to a device an administrator locked', async () => {
      await setOrg({ members_may_choose: true });
      const id = await deviceIn(member);
      await put(`/devices/${id}`, admin, { order: [WG], locked: true });
      await put('/me', member, { order: [WSS, WG] });
      const view = await get(`/devices/${id}`, member);
      assert.deepEqual(view.body.effective.order, [WG]);
      assert.equal(view.body.effective.person_blocked, 'locked');
    });

    it('stops applying when the organisation switches members_may_choose off again', async () => {
      await setOrg({ members_may_choose: true });
      await put('/me', member, { order: [WSS, WG] });
      await setOrg({ members_may_choose: false });
      assert.equal((await methods(member)).body.default, WG);
    });

    it('can be cleared with null', async () => {
      await setOrg({ members_may_choose: true });
      await put('/me', member, { order: [WSS, WG] });
      const res = await put('/me', member, { order: null });
      assert.equal(res.status, 200);
      assert.equal(res.body.own.order, null);
      assert.equal((await pool.query('SELECT 1 FROM user_connection_orders')).rows.length, 0);
    });
  });

  describe('safety', () => {
    it('refuses a change that would leave a device with no method its gateway runs, naming the devices', async () => {
      const stuck = await deviceIn(admin, { gateway_node_id: plainGw.id });
      const fine = await deviceIn(admin);
      const res = await setOrg({ order: [AWG, WG], forced: true });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.code, 'would_strand_devices');
      assert.deepEqual(
        res.body.devices.map((d) => d.id),
        [stuck]
      );
      assert.ok(!res.body.devices.some((d) => d.id === fine));
      const row = (await pool.query('SELECT connection_order FROM organizations WHERE id = $1', [ORG])).rows[0];
      assert.equal(row.connection_order, null, 'nothing was written');
    });

    it('refuses the same at line and device scope', async () => {
      const stuck = await deviceIn(admin, { gateway_node_id: plainGw.id });
      await pool.query("UPDATE nodes SET compartment_id = 'cmp-co-travel' WHERE id = $1", [stuck]);
      const line = await put('/lines/cmp-co-travel', admin, { order: [AWG], forced: true });
      assert.equal(line.status, 409);
      assert.equal(line.body.devices[0].id, stuck);
      const device = await put(`/devices/${stuck}`, admin, { order: [AWG], forced: true });
      assert.equal(device.status, 409);
    });

    it('also refuses a member forcing a method their gateway does not run', async () => {
      await setOrg({ members_may_choose: true });
      const id = await deviceIn(member);
      await pool.query('UPDATE nodes SET gateway_node_id = $2 WHERE id = $1', [id, plainGw.id]);
      const res = await put(`/devices/${id}`, member, { order: [AWG], forced: true });
      assert.equal(res.status, 409);
      assert.equal(res.body.devices[0].id, id);
    });

    it('previews who would lose connectivity and who must import a profile again, without writing', async () => {
      const stuck = await deviceIn(admin, { gateway_node_id: plainGw.id });
      const awgDevice = await deviceIn(admin, { access_method: AWG });
      const wgDevice = await deviceIn(admin);

      const strand = await preview(admin, { scope: 'organization', settings: { order: [AWG], forced: true } });
      assert.equal(strand.status, 200);
      assert.deepEqual(
        strand.body.strands.map((d) => d.id),
        [stuck]
      );
      assert.equal(strand.body.strands_total, 1);

      const reimport = await preview(admin, { scope: 'organization', settings: { order: [WG, WSS] } });
      assert.equal(reimport.status, 200);
      assert.deepEqual(reimport.body.strands, []);
      assert.deepEqual(
        reimport.body.reimport.map((d) => d.id),
        [awgDevice]
      );
      assert.ok(!reimport.body.reimport.some((d) => d.id === wgDevice));

      const row = (await pool.query('SELECT connection_order FROM organizations WHERE id = $1', [ORG])).rows[0];
      assert.equal(row.connection_order, null);
    });

    it('lets a change that keeps a path go through and reports the devices that must import again', async () => {
      const awgDevice = await deviceIn(admin, { access_method: AWG });
      const res = await setOrg({ order: [WG, WSS] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        res.body.plan.reimport.map((d) => d.id),
        [awgDevice]
      );
    });

    it('restricts the preview to those who could write the scope', async () => {
      assert.equal((await preview(member, { scope: 'organization', settings: { order: [WG] } })).status, 403);
      assert.equal(
        (await preview(member, { scope: 'line', id: 'cmp-co-travel', settings: { order: [WG] } })).status,
        403
      );
      assert.equal(
        (await preview(netAdmin, { scope: 'line', id: 'cmp-co-travel', settings: { order: [WG] } })).status,
        200
      );
      assert.equal((await preview(admin, { scope: 'nonsense' })).status, 400);
      assert.equal(
        (await preview(admin, { scope: 'line', id: 'cmp-co-foreign', settings: { order: [WG] } })).status,
        404
      );
    });
  });
  describe('access methods switched off (ADR 0036 settings)', () => {
    const switchAwg = (body) =>
      request(app)
        .put(`/api/organizations/${ORG}/access-methods`)
        .set(auth(admin))
        .send({ wireguard_wss: true, amneziawg: false, ...body });
    const previewSwitch = (body = {}) =>
      request(app)
        .post(`/api/organizations/${ORG}/access-methods/preview`)
        .set(auth(admin))
        .send({ wireguard_wss: true, amneziawg: false, ...body });
    const allowed = async () =>
      (await pool.query('SELECT allowed_access_methods FROM organizations WHERE id = $1', [ORG])).rows[0]
        .allowed_access_methods;

    it('refuses with 409 and the devices when one is forced to the method being switched off', async () => {
      const forcedId = await deviceIn(admin);
      const free = await deviceIn(admin);
      assert.equal((await put(`/devices/${forcedId}`, admin, { order: [AWG], forced: true })).status, 200);
      const res = await switchAwg();
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.code, 'would_strand_devices');
      assert.deepEqual(
        res.body.devices.map((d) => d.id),
        [forcedId]
      );
      assert.ok(!res.body.devices.some((d) => d.id === free));
      assert.deepEqual(await allowed(), [WG, WSS, AWG], 'nothing was written');
    });

    it('also refuses when a line or the person forces the method', async () => {
      await setOrg({ members_may_choose: true });
      const id = await deviceIn(member);
      await pool.query("UPDATE nodes SET compartment_id = 'cmp-co-travel' WHERE id = $1", [id]);
      await put('/lines/cmp-co-travel', admin, { order: [AWG, WG], forced: true });
      assert.equal((await switchAwg()).status, 409);
      await put('/lines/cmp-co-travel', admin, { order: null });
      await put('/me', member, { order: [AWG, WG], forced: true });
      const res = await switchAwg();
      assert.equal(res.status, 409);
      assert.equal(res.body.devices[0].id, id);
    });

    it('asks for confirmation when a device profile was made for the method, then lets it through', async () => {
      const awgDevice = await deviceIn(admin, { access_method: AWG });
      await deviceIn(admin);
      const asked = await switchAwg();
      assert.equal(asked.status, 409, JSON.stringify(asked.body));
      assert.equal(asked.body.code, 'reimport_confirmation_required');
      assert.deepEqual(
        asked.body.reimport.map((d) => d.id),
        [awgDevice]
      );
      assert.deepEqual(await allowed(), [WG, WSS, AWG]);
      const done = await switchAwg({ confirm_reimport: true });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual(
        done.body.plan.reimport.map((d) => d.id),
        [awgDevice]
      );
      assert.deepEqual(await allowed(), [WG, WSS]);
    });

    it('previews the same two lists without writing, and only for an owner or admin', async () => {
      const forcedId = await deviceIn(admin);
      const awgDevice = await deviceIn(admin, { access_method: AWG });
      await put(`/devices/${forcedId}`, admin, { order: [AWG], forced: true });
      const res = await previewSwitch();
      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.strands.map((d) => d.id),
        [forcedId]
      );
      assert.ok(res.body.reimport.some((d) => d.id === awgDevice));
      assert.deepEqual(await allowed(), [WG, WSS, AWG]);
      const denied = await request(app)
        .post(`/api/organizations/${ORG}/access-methods/preview`)
        .set(auth(member))
        .send({ wireguard_wss: true, amneziawg: false });
      assert.equal(denied.status, 403);
      assert.equal((await previewSwitch({ amneziawg: 'no' })).status, 400);
    });

    it('lets a change that affects no device go straight through', async () => {
      await deviceIn(admin);
      assert.equal((await switchAwg()).status, 200);
      assert.equal((await switchAwg({ wireguard_wss: false })).status, 200);
    });

    it('resolves a stored order that names a method no longer allowed, instead of keeping it', async () => {
      const id = await deviceIn(admin);
      await pool.query("UPDATE organizations SET connection_order = ARRAY['amneziawg','wireguard'] WHERE id = $1", [
        ORG
      ]);
      await pool.query(
        "UPDATE nodes SET connection_order = ARRAY['amneziawg'], connection_forced = TRUE WHERE id = $1",
        [id]
      );
      await pool.query(
        "UPDATE organizations SET allowed_access_methods = ARRAY['wireguard','wireguard-wss']::text[] WHERE id = $1",
        [ORG]
      );
      const view = await get(`/devices/${id}`, admin);
      assert.deepEqual(view.body.effective.order, [WG]);
      assert.ok(!view.body.effective.order.includes(AWG));
      const peer = await peerOf(gw, id);
      assert.deepEqual(peer.connection_order, [WG]);
    });
  });
});
