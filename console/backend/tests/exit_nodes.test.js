// ADR 0032 phase 1: a profile device sends all its traffic through an exit, the gateway
// itself or a mesh node started as an exit. Who may choose is an administrator, or the
// device's owner when the organisation allows it; the netmap tells the gateway where each
// device leaves and tells the mesh exit which devices leave through it.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { validateResponse } = require('../middleware/contractValidator');
const { vipFromOffset } = require('../utils/crypto');

const key = () => crypto.randomBytes(32).toString('base64');

describe('ADR 0032: exits for profile devices', () => {
  const NetmapService = require('../services/NetmapService');
  let dbHelper;
  let pool;
  let app;
  let adminToken;
  let memberToken;
  let otherMemberToken;
  const org = 'org-exit';
  const otherOrg = 'org-exit-other';
  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ($1, 'Exit', 'exit', 'deny'), ($2, 'Exit other', 'exit-other', 'deny')`,
      [org, otherOrg]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-exit-admin', 'exitadmin', 'ea@exit.local', 'x', 'admin', $1),
         ('usr-exit-member', 'exitmember', 'em@exit.local', 'x', 'user', $1),
         ('usr-exit-member2', 'exitmember2', 'em2@exit.local', 'x', 'user', $1)`,
      [org]
    );
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
       VALUES ('node-exit-gw', $1, 'usr-exit-admin', 'home', '100.64.60.1', 'fd00:60::1', $2, 'EXIT_BRIDGE', TRUE, FALSE),
              ('node-exit-a', $1, 'usr-exit-admin', 'exit-a', '100.64.60.2', 'fd00:60::2', $3, 'EXIT_BRIDGE', TRUE, FALSE),
              ('node-exit-b', $1, 'usr-exit-admin', 'exit-b', '100.64.60.3', 'fd00:60::3', $4, 'HYBRID', TRUE, FALSE),
              ('node-exit-plain', $1, 'usr-exit-admin', 'plain', '100.64.60.4', 'fd00:60::4', $5, 'CLIENT_ORIGIN', TRUE, FALSE),
              ('node-exit-foreign', $6, 'usr-exit-admin', 'foreign', '100.64.60.5', 'fd00:60::5', $7, 'EXIT_BRIDGE', TRUE, FALSE)`,
      [
        org,
        crypto.randomBytes(32).toString('hex'),
        crypto.randomBytes(32).toString('hex'),
        crypto.randomBytes(32).toString('hex'),
        crypto.randomBytes(32).toString('hex'),
        otherOrg,
        crypto.randomBytes(32).toString('hex')
      ]
    );
    const token = (id, username, role) => issueConsoleTestToken({ sub: id, id, username, role, organization_id: org });
    adminToken = await token('usr-exit-admin', 'exitadmin', 'admin');
    memberToken = await token('usr-exit-member', 'exitmember', 'user');
    otherMemberToken = await token('usr-exit-member2', 'exitmember2', 'user');
    const gw = await request(app)
      .put('/api/devices/gateway')
      .set(auth(adminToken))
      .send({ node_id: 'node-exit-gw', endpoint: 'home.example:51820' });
    assert.strictEqual(gw.status, 200);
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM nodes WHERE device_kind = 'profile'");
    await pool.query('DELETE FROM acl_rules WHERE organization_id = $1', [org]);
    await pool.query('UPDATE organizations SET exit_self_service = FALSE WHERE id = $1', [org]);
    await pool.query("UPDATE nodes SET is_healthy = TRUE WHERE id LIKE 'node-exit-%'");
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  const register = (token, body) =>
    request(app)
      .post('/api/devices/profile')
      .set(auth(token))
      .send({ name: 'phone', public_key: key(), preshared_key: key(), ...body });
  const checkContract = (doc) => {
    const check = validateResponse('NetmapResponse', { ...doc, generated_at_unix: 1 });
    assert.ok(check.valid, `netmap breaks the contract at ${check.pointer}: ${check.message}`);
  };

  it('lists the exits of the organisation only, the gateway first, and who may choose', async () => {
    const asMember = await request(app).get('/api/devices/exits').set(auth(memberToken));
    assert.strictEqual(asMember.status, 200);
    assert.strictEqual(asMember.body.can_choose, false);
    assert.deepStrictEqual(
      asMember.body.exits.map((e) => [e.node_id, e.kind]),
      [
        ['node-exit-gw', 'gateway'],
        ['node-exit-a', 'node'],
        ['node-exit-b', 'node']
      ]
    );
    const asAdmin = await request(app).get('/api/devices/exits').set(auth(adminToken));
    assert.strictEqual(asAdmin.body.can_choose, true);
  });

  it('refuses a full-tunnel profile to a member unless the organisation allows self-service', async () => {
    const refused = await register(memberToken, { exit_node_id: 'node-exit-gw' });
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(refused.body.code, 'exit_not_permitted');

    const policy = await request(app)
      .put('/api/devices/exit-policy')
      .set(auth(memberToken))
      .send({ self_service: true });
    assert.strictEqual(policy.status, 403, 'only an administrator sets the policy');
    assert.strictEqual(
      (await request(app).put('/api/devices/exit-policy').set(auth(adminToken)).send({ self_service: true })).status,
      200
    );
    const ok = await register(memberToken, { exit_node_id: 'node-exit-gw' });
    assert.strictEqual(ok.status, 201);
    assert.deepStrictEqual(ok.body.allowed_ips, ['0.0.0.0/0', '::/0']);
    assert.deepStrictEqual(ok.body.dns, ['100.100.100.100']);
    assert.deepStrictEqual(ok.body.exit, { node_id: 'node-exit-gw', name: 'home', kind: 'gateway' });
  });

  it('accepts only an exit node of the organisation', async () => {
    for (const id of ['node-exit-plain', 'node-exit-foreign', 'nope']) {
      const res = await register(adminToken, { exit_node_id: id });
      assert.strictEqual(res.status, 404, id);
      assert.strictEqual(res.body.code, 'no_such_exit');
    }
    const plain = await register(adminToken, {});
    assert.deepStrictEqual(plain.body.allowed_ips, ['100.64.0.0/10'], 'a profile without an exit is unchanged');
    assert.deepStrictEqual(plain.body.dns, []);
  });

  it("lets an owner change their own device's exit under self-service, never another's, and the LAN only for admins", async () => {
    await pool.query('UPDATE organizations SET exit_self_service = TRUE WHERE id = $1', [org]);
    const dev = await register(memberToken, { exit_node_id: 'node-exit-gw' });
    const id = dev.body.device_id;
    const put = (token, body) => request(app).put(`/api/devices/${id}/exit`).set(auth(token)).send(body);

    assert.strictEqual((await put(otherMemberToken, { exit_node_id: 'node-exit-a' })).status, 403);
    assert.strictEqual((await put(memberToken, { exit_node_id: 'node-exit-a', allow_lan: true })).status, 403);
    const before = Number((await pool.query("SELECT epoch FROM mesh_epochs WHERE name='netmap'")).rows[0].epoch);
    const moved = await put(memberToken, { exit_node_id: 'node-exit-a' });
    assert.strictEqual(moved.status, 200);
    assert.strictEqual(moved.body.exit.node_id, 'node-exit-a');
    const afterEpoch = Number((await pool.query("SELECT epoch FROM mesh_epochs WHERE name='netmap'")).rows[0].epoch);
    assert.ok(afterEpoch > before, 'the netmap moves so the gateway learns the new exit');
    const lan = await put(adminToken, { exit_node_id: 'node-exit-a', allow_lan: true });
    assert.strictEqual(lan.body.allow_lan, true);
    const removed = await put(memberToken, { exit_node_id: null });
    assert.strictEqual(removed.body.exit, null);
    assert.strictEqual(removed.body.allow_lan, false, 'removing the exit removes the LAN access with it');
  });

  it('tells the gateway it is the exit, with the device internet rules and not its mesh rules', async () => {
    const dev = (await register(adminToken, { exit_node_id: 'node-exit-gw' })).body;
    await pool.query(
      `INSERT INTO acl_rules (id, priority, source_cidr, destination_cidr, protocol, port_start, port_end, action, organization_id) VALUES
         ('acl-exit-inet', 5, $1, '198.51.100.0/24', 'ALL', 0, 65535, 'DROP', $2),
         ('acl-exit-mesh', 6, $1, '100.64.0.0/10', 'ALL', 0, 65535, 'DROP', $2),
         ('acl-exit-elsewhere', 7, '100.64.99.0/24', '0.0.0.0/0', 'ALL', 0, 65535, 'DROP', $2)`,
      [`${dev.overlay_ipv4}/32`, org]
    );
    const gw = await NetmapService.buildNetmap('node-exit-gw');
    checkContract(gw);
    const entry = gw.peers.find((p) => p.node_id === dev.device_id);
    assert.deepStrictEqual(entry.exit, {
      via: 'self',
      node_id: 'node-exit-gw',
      internet_rules: [{ cidr: '198.51.100.0/24', protocol: 'ALL', port_start: 0, port_end: 65535, action: 'DROP' }]
    });
    assert.ok(!gw.peers.some((p) => p.allowed_ips.includes('0.0.0.0/0')), 'no mesh exit holds the default route');
  });

  it('routes the default route to the mesh exit at the gateway and the device back at the exit', async () => {
    const dev = (await register(adminToken, { exit_node_id: 'node-exit-a' })).body;
    const gw = await NetmapService.buildNetmap('node-exit-gw');
    checkContract(gw);
    assert.deepStrictEqual(gw.peers.find((p) => p.node_id === dev.device_id).exit, {
      via: 'mesh',
      node_id: 'node-exit-a'
    });
    const exitAtGw = gw.peers.find((p) => p.node_id === 'node-exit-a');
    assert.ok(exitAtGw, "the gateway holds the exit although its own policy permits nobody");
    assert.deepStrictEqual(exitAtGw.allowed_ips, ['0.0.0.0/0', '::/0']);

    const exitDoc = await NetmapService.buildNetmap('node-exit-a');
    checkContract(exitDoc);
    assert.deepStrictEqual(exitDoc.exit_clients, [
      { node_id: dev.device_id, allowed_ips: [`${dev.overlay_ipv4}/32`, `${dev.overlay_ipv6}/128`] }
    ]);
    const gwAtExit = exitDoc.peers.find((p) => p.node_id === 'node-exit-gw');
    assert.ok(gwAtExit && gwAtExit.allowed_ips.includes(`${dev.overlay_ipv4}/32`), "the device's replies go to the gateway");
    assert.ok(!JSON.stringify(exitDoc).includes('preshared_key_hex'), 'the exit never learns a device PSK');

    const bystander = await NetmapService.buildNetmap('node-exit-b');
    assert.ok(!bystander.exit_clients, 'an exit nobody chose serves nobody');
  });

  it('gives the default route to one mesh exit only, and none to an exit that is down', async () => {
    const a = (await register(adminToken, { exit_node_id: 'node-exit-a' })).body;
    const b = (await register(adminToken, { exit_node_id: 'node-exit-b' })).body;
    let gw = await NetmapService.buildNetmap('node-exit-gw');
    assert.deepStrictEqual(
      gw.peers.filter((p) => p.allowed_ips.includes('0.0.0.0/0')).map((p) => p.node_id),
      ['node-exit-a']
    );
    assert.ok(!(await NetmapService.buildNetmap('node-exit-b')).exit_clients, 'the second exit is not routed to');
    assert.strictEqual(gw.peers.find((p) => p.node_id === b.device_id).exit.node_id, 'node-exit-b');

    await pool.query("UPDATE nodes SET is_healthy = FALSE WHERE id IN ('node-exit-a', 'node-exit-b')");
    gw = await NetmapService.buildNetmap('node-exit-gw');
    assert.ok(!gw.peers.some((p) => p.allowed_ips.includes('0.0.0.0/0')), 'no route to an exit that is down');
    assert.strictEqual(
      gw.peers.find((p) => p.node_id === a.device_id).exit.via,
      'mesh',
      'the device keeps its exit, which the gateway cannot reach: its traffic is dropped, not sent elsewhere'
    );
  });

  it('never allocates the exit DNS address to a node', () => {
    const offset = 36 * 65536 + 100 * 256 + 100;
    assert.strictEqual(vipFromOffset(offset).overlayIpv4, '100.100.100.100');
    assert.strictEqual(vipFromOffset(offset).usable, false);
    assert.strictEqual(vipFromOffset(offset + 1).usable, true);
  });
});
