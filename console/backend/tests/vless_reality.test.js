// ADR 0036: the vless-reality access method. The organisation allows it, the gateway advertises
// it (capability vless-v1 and a port), the person chooses it. The REALITY key pair and short ids
// are generated per organisation and are a secret of the same kind as a key; each device gets
// its own VLESS uuid.
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
const Resolver = require('../services/ConnectionOrderResolver');
const { settleAuditWrites } = require('../utils/audit');

const key = () => crypto.randomBytes(32).toString('base64');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const b64OfHex = (hex) => Buffer.from(hex, 'hex').toString('base64');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY43 = /^[A-Za-z0-9_-]{43}$/;
const DEST = 'www.example.com:443';

describe('REALITY parameter generation', () => {
  it('makes a real X25519 pair in the encoding Xray reads, and short ids in hex', () => {
    const p = AccessMethodService.generateVlessParams(DEST);
    assert.match(p.private_key, KEY43);
    assert.match(p.public_key, KEY43);
    assert.ok(AccessMethodService.validVlessParams(p));
    // the public key is the one that belongs to the private key
    const priv = crypto.createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', d: p.private_key, x: p.public_key },
      format: 'jwk'
    });
    const derived = crypto.createPublicKey(priv).export({ format: 'jwk' }).x;
    assert.equal(derived, p.public_key);
    assert.ok(p.short_ids.length >= 1);
    for (const id of p.short_ids) assert.match(id, /^([0-9a-f]{2}){1,8}$/);
    assert.equal(p.dest, DEST);
    assert.deepEqual(p.server_names, ['www.example.com']);
  });

  it('never repeats', () => {
    const seen = new Set();
    for (let i = 0; i < 20; i++) seen.add(AccessMethodService.generateVlessParams(DEST).private_key);
    assert.equal(seen.size, 20);
  });

  it('refuses what could not have been generated', () => {
    const good = AccessMethodService.generateVlessParams(DEST);
    const other = AccessMethodService.generateVlessParams(DEST);
    assert.ok(!AccessMethodService.validVlessParams({ ...good, public_key: other.public_key }), 'key mismatch');
    assert.ok(!AccessMethodService.validVlessParams({ ...good, short_ids: ['abc'] }));
    assert.ok(!AccessMethodService.validVlessParams({ ...good, short_ids: [] }));
    assert.ok(!AccessMethodService.validVlessParams({ ...good, dest: 'no-port' }));
    assert.ok(!AccessMethodService.validVlessParams({ ...good, extra: 1 }));
    assert.ok(!AccessMethodService.validVlessParams(null));
  });

  it('needs a fallback target the operator chose', () => {
    assert.throws(() => AccessMethodService.generateVlessParams(''), /dest/);
    assert.throws(() => AccessMethodService.generateVlessParams('nohost'), /dest/);
  });
});

describe('connection order knows vless-reality', () => {
  it('accepts it in an order, keeps openvpn and ikev2 reserved, and tries it last in Automatico', () => {
    assert.deepEqual(Resolver.validateOrder(['wireguard', 'vless-reality']), {
      ok: true,
      order: ['wireguard', 'vless-reality']
    });
    assert.equal(Resolver.validateOrder(['openvpn']).code, 'method_reserved');
    assert.equal(Resolver.validateOrder(['ikev2']).code, 'method_reserved');
    assert.deepEqual(Resolver.DEFAULT_ORDER, ['wireguard', 'wireguard-wss', 'amneziawg', 'vless-reality']);
    assert.deepEqual(Resolver.ceilingOf(['vless-reality']), ['wireguard', 'vless-reality']);
    assert.deepEqual(AccessMethodService.METHODS, ['wireguard', 'wireguard-wss', 'amneziawg', 'vless-reality']);
  });
});

describe('ADR 0036: vless-reality through the API', () => {
  const ORG = 'org-vl-a';
  const OTHER = 'org-vl-b';
  let db;
  let pool;
  let app;
  let admin;
  let member;
  let gw;
  let plainGw;
  let mesh;
  const saved = { dest: process.env.NERONET_REALITY_DEST };

  const settings = (token, org = ORG) => request(app).get(`/api/organizations/${org}/access-methods`).set(auth(token));
  const setMethods = (token, body, org = ORG) =>
    request(app).put(`/api/organizations/${org}/access-methods`).set(auth(token)).send(body);
  const base = { wireguard_wss: false, amneziawg: false };
  const regenerate = (token, body = { method: 'vless-reality' }) =>
    request(app).post(`/api/organizations/${ORG}/access-methods/regenerate`).set(auth(token)).send(body);
  const methods = (token) => request(app).get('/api/devices/profile/methods').set(auth(token));
  const addDevice = (token, body = {}) =>
    request(app)
      .post('/api/devices/profile')
      .set(auth(token))
      .send({ name: 'phone', public_key: key(), preshared_key: key(), ...body });
  const stored = async () =>
    (await pool.query('SELECT vless_params FROM organizations WHERE id = $1', [ORG])).rows[0].vless_params;

  async function enrol(name, org) {
    const publicKeyHex = nodeKey();
    const res = await enrolNode(app, { public_key_hex: publicKeyHex, role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const id = res.body.assigned_node_id;
    await pool.query('UPDATE nodes SET organization_id = $1, name = $2 WHERE id = $3', [org, name, id]);
    return { id, publicKey: b64OfHex(publicKeyHex) };
  }

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ($1, 'VL A', 'vl-a', 'deny'), ($2, 'VL B', 'vl-b', 'deny')`,
      [ORG, OTHER]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-vl-admin', 'vladmin', 'a@vl.local', 'x', 'admin', $1),
         ('usr-vl-member', 'vlmember', 'm@vl.local', 'x', 'user', $1)`,
      [ORG]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-vl-admin', 'usr-vl-admin', $1, 'admin'), ('mem-vl-member', 'usr-vl-member', $1, 'member')`,
      [ORG]
    );
    const token = (id, username, role) => issueConsoleTestToken({ sub: id, id, username, role, organization_id: ORG });
    admin = await token('usr-vl-admin', 'vladmin', 'admin');
    member = await token('usr-vl-member', 'vlmember', 'user');
    gw = await enrol('gw-vless', ORG);
    plainGw = await enrol('gw-plain', ORG);
    mesh = await enrol('mesh-node', ORG);
  });

  beforeEach(async () => {
    process.env.NERONET_REALITY_DEST = DEST;
    await pool.query("DELETE FROM nodes WHERE device_kind = 'profile'");
    await pool.query(
      `UPDATE organizations SET allowed_access_methods = ARRAY['wireguard','wireguard-wss']::text[], awg_params = NULL,
              vless_params = NULL WHERE id IN ($1, $2)`,
      [ORG, OTHER]
    );
    await pool.query(
      `UPDATE nodes SET profile_gateway_endpoint = NULL, is_default_profile_gateway = FALSE,
              node_capabilities = '{}', awg_port = NULL, vless_port = NULL WHERE id IN ($1, $2)`,
      [gw.id, plainGw.id]
    );
    await pool.query(
      `UPDATE nodes SET profile_gateway_endpoint = 'gw.example.com:51820', is_default_profile_gateway = TRUE,
              node_capabilities = ARRAY['vless-v1']::text[], vless_port = 443 WHERE id = $1`,
      [gw.id]
    );
  });

  after(async () => {
    if (saved.dest === undefined) delete process.env.NERONET_REALITY_DEST;
    else process.env.NERONET_REALITY_DEST = saved.dest;
    if (db) await db.cleanup();
  });

  it('refuses to switch on without a fallback target the operator configured', async () => {
    delete process.env.NERONET_REALITY_DEST;
    const res = await setMethods(admin, { ...base, vless: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'reality_dest_not_configured');
    assert.equal(await stored(), null);
  });

  it('generates the REALITY parameters once, keeps them when switched off, and never returns them', async () => {
    const on = await setMethods(admin, { ...base, vless: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual(on.body.allowed_access_methods, ['wireguard', 'vless-reality']);
    assert.equal(on.body.vless, true);
    assert.equal(on.body.vless_ready, true);
    const first = await stored();
    assert.ok(AccessMethodService.validVlessParams(first));
    const text = JSON.stringify(on.body);
    assert.ok(!text.includes(first.private_key) && !text.includes(first.public_key), 'no key in the answer');
    const got = await settings(admin);
    assert.ok(!JSON.stringify(got.body).includes(first.private_key));

    await setMethods(admin, { ...base, vless: false });
    await setMethods(admin, { ...base, vless: true });
    assert.deepEqual(await stored(), first, 'switching off and on again keeps the parameters');
  });

  it('leaves vless as it is when the request does not mention it', async () => {
    await setMethods(admin, { ...base, vless: true });
    const res = await setMethods(admin, { wireguard_wss: true, amneziawg: false });
    assert.equal(res.status, 200);
    assert.ok(res.body.allowed_access_methods.includes('vless-reality'));
    assert.equal((await setMethods(admin, { ...base, vless: 'yes' })).status, 400);
  });

  it('lets only an administrator switch it', async () => {
    assert.equal((await setMethods(member, { ...base, vless: true })).status, 403);
  });

  it('regenerates the key pair on request, counts the devices that must import again, audits without values', async () => {
    assert.equal((await regenerate(admin)).status, 409, 'not while the method is off');
    await setMethods(admin, { ...base, vless: true });
    const before = await stored();
    const device = await addDevice(member, { access_method: 'vless-reality' });
    assert.equal(device.status, 201, JSON.stringify(device.body));
    assert.equal((await regenerate(member)).status, 403);
    const res = await regenerate(admin);
    assert.equal(res.status, 200);
    assert.equal(res.body.devices_to_redo, 1);
    const after = await stored();
    assert.notEqual(after.private_key, before.private_key);
    await settleAuditWrites();
    const audit = (await pool.query("SELECT message, metadata_json FROM audit_events WHERE event_type LIKE 'ACCESS_METHODS%'"))
      .rows;
    assert.ok(audit.length >= 1);
    for (const row of audit) {
      const text = JSON.stringify(row);
      for (const secret of [before.private_key, after.private_key, ...after.short_ids]) {
        assert.ok(!text.includes(secret), 'an audit entry carries a secret');
      }
    }
  });

  it('offers it only when allowed, advertised by the gateway and ready, with a plain label', async () => {
    assert.ok(!(await methods(member)).body.methods.some((m) => m.id === 'vless-reality'), 'not allowed yet');
    await setMethods(admin, { ...base, vless: true });
    const res = await methods(member);
    const entry = res.body.methods.find((m) => m.id === 'vless-reality');
    assert.ok(entry);
    assert.equal(entry.label, 'Heavily censored network (VLESS)');

    await pool.query("UPDATE nodes SET node_capabilities = '{}', vless_port = NULL WHERE id = $1", [gw.id]);
    assert.ok(!(await methods(member)).body.methods.some((m) => m.id === 'vless-reality'), 'gateway runs none');
  });

  it('refuses with 409 method_not_available unless both sides allow it', async () => {
    const off = await addDevice(member, { access_method: 'vless-reality' });
    assert.equal(off.status, 409);
    assert.equal(off.body.code, 'method_not_available');
    await setMethods(admin, { ...base, vless: true });
    await pool.query("UPDATE nodes SET node_capabilities = '{}', vless_port = NULL WHERE id = $1", [gw.id]);
    assert.equal((await addDevice(member, { access_method: 'vless-reality' })).status, 409);
  });

  it('answers a VLESS device with its own uuid, a share link and the manual fields, and stores the uuid', async () => {
    await setMethods(admin, { ...base, vless: true });
    const params = await stored();
    const res = await addDevice(member, { access_method: 'vless-reality', name: 'my phone' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.access_method, 'vless-reality');
    assert.match(String(res.headers['cache-control']), /no-store/);
    const v = res.body.vless;
    assert.match(v.uuid, UUID);
    assert.equal(v.endpoint, 'gw.example.com:443');
    assert.equal(v.server_name, 'www.example.com');
    assert.equal(v.public_key, params.public_key);
    assert.ok(params.short_ids.includes(v.short_id));
    assert.equal(v.flow, 'xtls-rprx-vision');
    const link = new URL(v.link);
    assert.equal(link.protocol, 'vless:');
    assert.equal(link.username, v.uuid);
    assert.equal(link.host, 'gw.example.com:443');
    assert.equal(link.searchParams.get('security'), 'reality');
    assert.equal(link.searchParams.get('flow'), 'xtls-rprx-vision');
    assert.equal(link.searchParams.get('encryption'), 'none');
    assert.equal(link.searchParams.get('pbk'), params.public_key);
    assert.equal(link.searchParams.get('sni'), 'www.example.com');
    assert.equal(link.searchParams.get('sid'), v.short_id);
    assert.equal(decodeURIComponent(link.hash.slice(1)), 'my phone');
    assert.ok(!v.link.includes(params.private_key), 'the private key never reaches a device');
    const row = (await pool.query('SELECT access_method, vless_uuid FROM nodes WHERE id = $1', [res.body.device_id]))
      .rows[0];
    assert.equal(row.access_method, 'vless-reality');
    assert.equal(row.vless_uuid, v.uuid);

    const second = await addDevice(member, { access_method: 'vless-reality' });
    assert.notEqual(second.body.vless.uuid, v.uuid, 'one uuid per device');
    const other = await addDevice(member);
    assert.equal(other.body.vless, undefined);
  });

  it('does not hand a device uuid or the private key to the console lists', async () => {
    await setMethods(admin, { ...base, vless: true });
    const params = await stored();
    const device = await addDevice(member, { access_method: 'vless-reality' });
    assert.equal(device.status, 201);
    for (const path of ['/api/nodes', '/api/devices', '/api/devices/profile']) {
      const res = await request(app).get(path).set(auth(admin));
      if (res.status !== 200) continue;
      const text = JSON.stringify(res.body);
      assert.ok(!text.includes(device.body.vless.uuid), `${path} lists a uuid`);
      assert.ok(!text.includes(params.private_key), `${path} lists the private key`);
    }
  });

  it('records the capability and port a gateway reports, and nothing without the capability', async () => {
    const TransportPolicyService = require('../services/TransportPolicyService');
    await TransportPolicyService.recordNodeCapability(plainGw.id, { capabilities: ['vless-v1'], vless_port: 8443 });
    let row = (await pool.query('SELECT node_capabilities, vless_port FROM nodes WHERE id = $1', [plainGw.id])).rows[0];
    assert.deepEqual(row.node_capabilities, ['vless-v1']);
    assert.equal(row.vless_port, 8443);
    await TransportPolicyService.recordNodeCapability(plainGw.id, { vless_port: 8443 });
    row = (await pool.query('SELECT vless_port FROM nodes WHERE id = $1', [plainGw.id])).rows[0];
    assert.equal(row.vless_port, null, 'a port without the capability is not kept');
    await TransportPolicyService.recordNodeCapability(plainGw.id, { capabilities: ['vless-v1'], vless_port: 70000 });
    row = (await pool.query('SELECT vless_port FROM nodes WHERE id = $1', [plainGw.id])).rows[0];
    assert.equal(row.vless_port, null, 'an impossible port is not kept');
  });

  it('puts the REALITY parameters and the uuid in the netmap of the gateway that runs it, and nowhere else', async () => {
    await setMethods(admin, { ...base, vless: true });
    const params = await stored();
    const device = await addDevice(member, { access_method: 'vless-reality' });
    assert.equal(device.status, 201);

    const forGateway = await NetmapService.buildNetmap(gw.id);
    assert.deepEqual(forGateway.self.vless, {
      listen_port: 443,
      dest: DEST,
      server_names: ['www.example.com'],
      private_key: params.private_key,
      short_ids: params.short_ids
    });
    const entry = forGateway.peers.find((p) => p.node_id === device.body.device_id);
    assert.equal(entry.access_method, 'vless-reality');
    assert.equal(entry.vless_uuid, device.body.vless.uuid);

    for (const node of [plainGw, mesh]) {
      const map = await NetmapService.buildNetmap(node.id);
      assert.equal(map.self.vless, undefined);
      const text = JSON.stringify(map);
      assert.ok(!text.includes(params.private_key), 'private key leaked to a node that is not the gateway');
      assert.ok(!text.includes(device.body.vless.uuid), 'uuid leaked to a node that is not the gateway');
    }

    // Switched off with a device on it: ADR 0037 asks for confirmation; then nothing is sent.
    const asked = await setMethods(admin, { ...base, vless: false });
    assert.equal(asked.status, 409);
    assert.equal(asked.body.code, 'reimport_confirmation_required');
    await setMethods(admin, { ...base, vless: false, confirm_reimport: true });
    const off = await NetmapService.buildNetmap(gw.id);
    assert.equal(off.self.vless, undefined);
    assert.ok(!JSON.stringify(off).includes(params.private_key));
    assert.equal(off.peers.find((p) => p.node_id === device.body.device_id).vless_uuid, undefined);
  });

  it('keeps the parameters of one organisation out of another organisation gateway', async () => {
    await setMethods(admin, { ...base, vless: true });
    const foreign = await enrol('gw-foreign', OTHER);
    await pool.query(
      `UPDATE nodes SET profile_gateway_endpoint = 'other.example.com:51820', node_capabilities = ARRAY['vless-v1']::text[],
              vless_port = 443 WHERE id = $1`,
      [foreign.id]
    );
    const map = await NetmapService.buildNetmap(foreign.id);
    assert.equal(map.self.vless, undefined, 'organisation B never enabled the method');
  });
});
