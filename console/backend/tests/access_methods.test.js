// ADR 0036: access methods a profile device can use. The organisation allows them, the
// gateway advertises them, the person chooses. AmneziaWG parameters are generated per
// organisation at random and are a secret of the same kind as a key.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { nodeKey, register: enrolNode } = require('./helpers/nodeEnrolment');
const { createApp } = require('../server');
const AccessMethodService = require('../services/AccessMethodService');
const NetmapService = require('../services/NetmapService');
const { settleAuditWrites } = require('../utils/audit');

const key = () => crypto.randomBytes(32).toString('base64');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const b64OfHex = (hex) => Buffer.from(hex, 'hex').toString('base64');

describe('AmneziaWG parameter generation', () => {
  it('stays inside the documented ranges for every draw', () => {
    for (let i = 0; i < 300; i++) {
      const p = AccessMethodService.generateAwgParams();
      assert.ok(AccessMethodService.validAwgParams(p), JSON.stringify(p));
      assert.ok(p.jc >= 4 && p.jc <= 12);
      assert.ok(p.jmin < p.jmax && p.jmax <= 1280);
      assert.notEqual(p.s1 + 56, p.s2);
      // amneziawg-go: header protection needs S1..S4 >= 12.
      assert.ok(p.s3 >= 12 && p.s3 <= 64 && p.s4 >= 12 && p.s4 <= 32);
      assert.ok(p.s1 >= 12 && p.s2 >= 12);
    }
  });

  it('never repeats: two organisations do not get the same parameters', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(JSON.stringify(AccessMethodService.generateAwgParams()));
    assert.equal(seen.size, 50);
  });

  it('makes four disjoint header ranges that avoid the values WireGuard uses', () => {
    for (let i = 0; i < 200; i++) {
      const p = AccessMethodService.generateAwgParams();
      const ranges = ['h1', 'h2', 'h3', 'h4'].map((k) => p[k].split('-').map(Number)).sort((a, b) => a[0] - b[0]);
      assert.ok(ranges[0][0] >= 5);
      for (let j = 1; j < 4; j++) assert.ok(ranges[j][0] > ranges[j - 1][1]);
      // Recommended H range 5..2147483647: some clients read headers as signed 32-bit.
      assert.ok(ranges[3][1] <= 2147483647);
    }
  });

  it('refuses a value that could not have been generated', () => {
    const good = AccessMethodService.generateAwgParams();
    assert.ok(!AccessMethodService.validAwgParams({ ...good, jmin: good.jmax }));
    assert.ok(!AccessMethodService.validAwgParams({ ...good, s3: 8 }));
    assert.ok(!AccessMethodService.validAwgParams({ ...good, s4: 4 }));
    assert.ok(!AccessMethodService.validAwgParams({ ...good, h4: '3000000000-3000001000' }));
    assert.ok(!AccessMethodService.validAwgParams({ ...good, s2: good.s1 + 56 }));
    assert.ok(!AccessMethodService.validAwgParams({ ...good, h1: '1-2' }));
    assert.ok(!AccessMethodService.validAwgParams({ ...good, h2: good.h1 }));
    assert.ok(!AccessMethodService.validAwgParams({ ...good, extra: 1 }));
    assert.ok(!AccessMethodService.validAwgParams(null));
  });
});

describe('ADR 0036: access methods through the API', () => {
  const ORG = 'org-am-a';
  const OTHER = 'org-am-b';
  let db;
  let pool;
  let app;
  let admin;
  let member;
  let otherAdmin;
  let gw;
  let plainGw;
  const WSS = { prefix: process.env.NERONET_WSS_PATH_PREFIX, url: process.env.NERONET_WSS_PUBLIC_URL };

  const settings = (token, org = ORG) => request(app).get(`/api/organizations/${org}/access-methods`).set(auth(token));
  const setMethods = (token, body, org = ORG) =>
    request(app).put(`/api/organizations/${org}/access-methods`).set(auth(token)).send(body);
  const regenerate = (token, org = ORG) =>
    request(app).post(`/api/organizations/${org}/access-methods/regenerate`).set(auth(token)).send({});
  const methods = (token, query = '') => request(app).get(`/api/devices/profile/methods${query}`).set(auth(token));
  const addDevice = (token, body = {}) =>
    request(app)
      .post('/api/devices/profile')
      .set(auth(token))
      .send({ name: 'phone', public_key: key(), preshared_key: key(), ...body });
  const ids = (res) => res.body.methods.map((m) => m.id);

  async function enrol(name, org, capability = {}) {
    const publicKeyHex = nodeKey();
    const res = await enrolNode(app, {
      public_key_hex: publicKeyHex,
      role: 'CLIENT_ORIGIN',
      endpoints: [],
      ...capability
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const id = res.body.assigned_node_id;
    await pool.query('UPDATE nodes SET organization_id = $1, name = $2 WHERE id = $3', [org, name, id]);
    return { id, credential: res.body.credential, publicKey: b64OfHex(publicKeyHex) };
  }

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ($1, 'AM A', 'am-a', 'deny'), ($2, 'AM B', 'am-b', 'deny')`,
      [ORG, OTHER]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-am-admin', 'amadmin', 'a@am.local', 'x', 'admin', $1),
         ('usr-am-member', 'ammember', 'm@am.local', 'x', 'user', $1),
         ('usr-am-badmin', 'ambadmin', 'b@am.local', 'x', 'admin', $2)`,
      [ORG, OTHER]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-am-admin', 'usr-am-admin', $1, 'admin'),
         ('mem-am-member', 'usr-am-member', $1, 'member'),
         ('mem-am-badmin', 'usr-am-badmin', $2, 'admin')`,
      [ORG, OTHER]
    );
    const token = (id, username, role, org) =>
      issueConsoleTestToken({ sub: id, id, username, role, organization_id: org });
    admin = await token('usr-am-admin', 'amadmin', 'admin', ORG);
    member = await token('usr-am-member', 'ammember', 'user', ORG);
    otherAdmin = await token('usr-am-badmin', 'ambadmin', 'admin', OTHER);
    gw = await enrol('gw-awg', ORG);
    plainGw = await enrol('gw-plain', ORG);
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM nodes WHERE device_kind = 'profile'");
    await pool.query(
      `UPDATE organizations SET allowed_access_methods = ARRAY['wireguard','wireguard-wss']::text[], awg_params = NULL
        WHERE id IN ($1, $2)`,
      [ORG, OTHER]
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
    delete process.env.NERONET_WSS_PATH_PREFIX;
    delete process.env.NERONET_WSS_PUBLIC_URL;
  });

  after(async () => {
    for (const [name, value] of [
      ['NERONET_WSS_PATH_PREFIX', WSS.prefix],
      ['NERONET_WSS_PUBLIC_URL', WSS.url]
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (db) await db.cleanup();
  });

  const switchOnWss = () => {
    process.env.NERONET_WSS_PATH_PREFIX = crypto.randomBytes(24).toString('hex');
    process.env.NERONET_WSS_PUBLIC_URL = 'wss://vpn.example.com';
  };

  it('defaults to plain WireGuard and WebSocket, with no parameters', async () => {
    const res = await settings(admin);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.allowed_access_methods, ['wireguard', 'wireguard-wss']);
    assert.equal(res.body.amneziawg, false);
    assert.equal(res.body.amneziawg_ready, false);
    const row = (await pool.query('SELECT awg_params FROM organizations WHERE id = $1', [ORG])).rows[0];
    assert.equal(row.awg_params, null);
  });

  it('lets only an owner or admin change the switches, and only in their own organisation', async () => {
    assert.equal((await setMethods(member, { wireguard_wss: true, amneziawg: true })).status, 403);
    assert.equal((await setMethods(otherAdmin, { wireguard_wss: true, amneziawg: true }, ORG)).status, 404);
    assert.equal((await setMethods(admin, { wireguard_wss: 'yes', amneziawg: true })).status, 400);
    assert.equal((await setMethods(admin, { wireguard_wss: true })).status, 400);
  });

  it('generates the parameters once, keeps them when switched off, and never returns them', async () => {
    const on = await setMethods(admin, { wireguard_wss: false, amneziawg: true });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.allowed_access_methods, ['wireguard', 'amneziawg']);
    assert.equal(on.body.amneziawg_ready, true);
    assert.ok(!JSON.stringify(on.body).includes('jmin'), 'no parameter in the answer');
    const first = (await pool.query('SELECT awg_params FROM organizations WHERE id = $1', [ORG])).rows[0].awg_params;
    assert.ok(AccessMethodService.validAwgParams(first));

    await setMethods(admin, { wireguard_wss: false, amneziawg: false });
    await setMethods(admin, { wireguard_wss: false, amneziawg: true });
    const again = (await pool.query('SELECT awg_params FROM organizations WHERE id = $1', [ORG])).rows[0].awg_params;
    assert.deepEqual(again, first, 'switching off and on again keeps the parameters');
  });

  it('regenerates on request, counts the devices that must import again, and audits without the values', async () => {
    assert.equal((await regenerate(admin)).status, 409, 'not while AmneziaWG is off');
    await setMethods(admin, { wireguard_wss: false, amneziawg: true });
    const before = (await pool.query('SELECT awg_params FROM organizations WHERE id = $1', [ORG])).rows[0].awg_params;
    await pool.query("UPDATE nodes SET profile_gateway_endpoint = 'gw.example.com:51820' WHERE id = $1", [gw.id]);
    const device = await addDevice(member, { access_method: 'amneziawg' });
    assert.equal(device.status, 201, JSON.stringify(device.body));
    assert.equal((await regenerate(member)).status, 403);
    const res = await regenerate(admin);
    assert.equal(res.status, 200);
    assert.equal(res.body.devices_to_redo, 1);
    const after = (await pool.query('SELECT awg_params FROM organizations WHERE id = $1', [ORG])).rows[0].awg_params;
    assert.notDeepEqual(after, before);
    await settleAuditWrites();
    const audit = (
      await pool.query(
        "SELECT message, metadata_json FROM audit_events WHERE event_type = 'ACCESS_METHODS_AWG_REGENERATED'"
      )
    ).rows;
    assert.ok(audit.length >= 1);
    for (const row of audit) {
      const text = JSON.stringify(row);
      for (const value of Object.values(after)) assert.ok(!text.includes(`"${value}"`) && !text.includes(`${value}-`));
    }
  });

  it('lists only the methods that are allowed and advertised, with plain labels', async () => {
    assert.deepEqual(ids(await methods(member)), ['wireguard']);

    switchOnWss();
    const wss = await methods(member);
    assert.deepEqual(ids(wss), ['wireguard', 'wireguard-wss']);
    assert.equal(wss.body.methods[0].label, 'Normal');

    // Allowed by the organisation but not advertised by the gateway: not offered.
    await setMethods(admin, { wireguard_wss: true, amneziawg: true });
    assert.deepEqual(ids(await methods(member)), ['wireguard', 'wireguard-wss', 'amneziawg']);
    await pool.query("UPDATE nodes SET node_capabilities = '{}' WHERE id = $1", [gw.id]);
    assert.deepEqual(ids(await methods(member)), ['wireguard', 'wireguard-wss']);

    // Advertised by the gateway but not allowed by the organisation: not offered.
    await pool.query("UPDATE nodes SET node_capabilities = ARRAY['awg-v1']::text[] WHERE id = $1", [gw.id]);
    await setMethods(admin, { wireguard_wss: true, amneziawg: false });
    assert.deepEqual(ids(await methods(member)), ['wireguard', 'wireguard-wss']);
  });

  it('answers with no methods while the organisation has no gateway', async () => {
    await pool.query('UPDATE nodes SET profile_gateway_endpoint = NULL WHERE id = $1', [gw.id]);
    const res = await methods(member);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.methods, []);
  });

  it('refuses a method with 409 method_not_available unless both sides allow it', async () => {
    const noWss = await addDevice(member, { access_method: 'wireguard-wss' });
    assert.equal(noWss.status, 409);
    assert.equal(noWss.body.code, 'method_not_available');

    const offAwg = await addDevice(member, { access_method: 'amneziawg' });
    assert.equal(offAwg.status, 409);
    assert.equal(offAwg.body.code, 'method_not_available');

    await setMethods(admin, { wireguard_wss: true, amneziawg: true });
    await pool.query("UPDATE nodes SET node_capabilities = '{}' WHERE id = $1", [gw.id]);
    const unadvertised = await addDevice(member, { access_method: 'amneziawg' });
    assert.equal(unadvertised.status, 409);
    assert.equal(unadvertised.body.code, 'method_not_available');
    assert.equal(
      (await pool.query("SELECT 1 FROM nodes WHERE device_kind = 'profile'")).rowCount,
      0,
      'a refused request leaves no device behind'
    );

    assert.equal((await addDevice(member, { access_method: 'carrier-pigeon' })).status, 400);
  });

  it('judges the method against the gateway that would serve the device', async () => {
    await setMethods(admin, { wireguard_wss: true, amneziawg: true });
    await pool.query("UPDATE nodes SET profile_gateway_endpoint = 'plain.example.com:51820' WHERE id = $1", [
      plainGw.id
    ]);
    const res = await addDevice(admin, { access_method: 'amneziawg', gateway_node_id: plainGw.id });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'method_not_available');
    const ok = await addDevice(admin, { access_method: 'amneziawg', gateway_node_id: gw.id });
    assert.equal(ok.status, 201);
  });

  it('answers an AmneziaWG device with the parameters and the AmneziaWG endpoint', async () => {
    await setMethods(admin, { wireguard_wss: false, amneziawg: true });
    const stored = (await pool.query('SELECT awg_params FROM organizations WHERE id = $1', [ORG])).rows[0].awg_params;
    const res = await addDevice(member, { access_method: 'amneziawg' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.access_method, 'amneziawg');
    assert.deepEqual(res.body.amneziawg, { endpoint: 'gw.example.com:51821', params: stored });
    assert.equal(res.body.gateway.endpoint, 'gw.example.com:51820');
    assert.match(String(res.headers['cache-control']), /no-store/);
    const row = (await pool.query('SELECT access_method FROM nodes WHERE id = $1', [res.body.device_id])).rows[0];
    assert.equal(row.access_method, 'amneziawg');
  });

  it('records the method of a WebSocket device and keeps plain WireGuard the default', async () => {
    switchOnWss();
    const wss = await addDevice(member, { access_method: 'wireguard-wss' });
    assert.equal(wss.status, 201, JSON.stringify(wss.body));
    assert.equal(wss.body.access_method, 'wireguard-wss');
    assert.equal(wss.body.strict_network.url, 'wss://vpn.example.com');
    assert.equal(wss.body.amneziawg, undefined);

    const plain = await addDevice(member);
    assert.equal(plain.status, 201);
    assert.equal(plain.body.access_method, 'wireguard');
    const rows = (await pool.query("SELECT access_method FROM nodes WHERE device_kind = 'profile' ORDER BY created_at"))
      .rows;
    assert.deepEqual(
      rows.map((r) => r.access_method),
      ['wireguard-wss', 'wireguard']
    );
  });

  it('records the AmneziaWG capability and port a gateway reports, and nothing without the capability', async () => {
    const TransportPolicyService = require('../services/TransportPolicyService');
    await TransportPolicyService.recordNodeCapability(plainGw.id, { capabilities: ['awg-v1'], awg_port: 51822 });
    let row = (await pool.query('SELECT node_capabilities, awg_port FROM nodes WHERE id = $1', [plainGw.id])).rows[0];
    assert.deepEqual(row.node_capabilities, ['awg-v1']);
    assert.equal(row.awg_port, 51822);

    await TransportPolicyService.recordNodeCapability(plainGw.id, { awg_port: 51822 });
    row = (await pool.query('SELECT node_capabilities, awg_port FROM nodes WHERE id = $1', [plainGw.id])).rows[0];
    assert.deepEqual(row.node_capabilities, []);
    assert.equal(row.awg_port, null, 'a port without the capability is not kept');

    await TransportPolicyService.recordNodeCapability(plainGw.id, { capabilities: ['awg-v1'], awg_port: 70000 });
    row = (await pool.query('SELECT awg_port FROM nodes WHERE id = $1', [plainGw.id])).rows[0];
    assert.equal(row.awg_port, null, 'an impossible port is not kept');
  });

  it('puts the parameters in the netmap of the organisation gateway that runs the listener, and nowhere else', async () => {
    await setMethods(admin, { wireguard_wss: false, amneziawg: true });
    const stored = (await pool.query('SELECT awg_params FROM organizations WHERE id = $1', [ORG])).rows[0].awg_params;
    const device = await addDevice(member, { access_method: 'amneziawg' });
    assert.equal(device.status, 201);

    const forGateway = await NetmapService.buildNetmap(gw.id);
    assert.deepEqual(forGateway.self.awg, { listen_port: 51821, params: stored });
    const entry = forGateway.peers.find((p) => p.node_id === device.body.device_id);
    assert.equal(entry.access_method, 'amneziawg');

    // A node that is not a gateway, and a gateway that reports no listener, get nothing.
    const other = await NetmapService.buildNetmap(plainGw.id);
    assert.equal(other.self.awg, undefined);
    assert.ok(!JSON.stringify(other).includes('"jmin"'));

    // Switched off: the listener is not started, so the parameters are not sent either. The device
    // above has an AmneziaWG profile, so ADR 0037 asks for confirmation first.
    const asked = await setMethods(admin, { wireguard_wss: false, amneziawg: false });
    assert.equal(asked.status, 409);
    assert.equal(asked.body.code, 'reimport_confirmation_required');
    await setMethods(admin, { wireguard_wss: false, amneziawg: false, confirm_reimport: true });
    const off = await NetmapService.buildNetmap(gw.id);
    assert.equal(off.self.awg, undefined);
    assert.ok(!JSON.stringify(off).includes('"jmin"'));
  });

  it('keeps the parameters of one organisation out of another organisation gateway', async () => {
    await setMethods(admin, { wireguard_wss: false, amneziawg: true });
    const foreign = await enrol('gw-foreign', OTHER);
    await pool.query(
      `UPDATE nodes SET profile_gateway_endpoint = 'other.example.com:51820', node_capabilities = ARRAY['awg-v1']::text[],
              awg_port = 51821 WHERE id = $1`,
      [foreign.id]
    );
    const map = await NetmapService.buildNetmap(foreign.id);
    assert.equal(map.self.awg, undefined, 'organisation B never enabled the method');
  });
});
