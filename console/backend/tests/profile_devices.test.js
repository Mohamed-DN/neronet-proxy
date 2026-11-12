// ADR 0029, phase A1: profile devices join through a gateway with a standard WireGuard
// profile. The device's private key never reaches the server: the caller sends the public
// key (and the PSK the gateway must know), and gets back what the profile needs.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { settleAuditWrites } = require('../utils/audit');
const { createApp } = require('../server');

const key = () => crypto.randomBytes(32).toString('base64');

describe('ADR 0029 A1: profile devices through a gateway', () => {
  let dbHelper;
  let pool;
  let app;
  let adminToken;
  let memberToken;
  let otherAdminToken;
  const orgA = 'org-prof-a';
  const orgB = 'org-prof-b';
  const gatewayKey = key();

  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const register = (token, body) => request(app).post('/api/devices/profile').set(auth(token)).send(body);
  const setGateway = (token, body) => request(app).put('/api/devices/gateway').set(auth(token)).send(body);

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ($1, 'Prof A', 'prof-a', 'deny'), ($2, 'Prof B', 'prof-b', 'deny') ON CONFLICT (id) DO NOTHING`,
      [orgA, orgB]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-prof-admin', 'profadmin', 'pa@prof.local', 'x', 'admin', $1),
         ('usr-prof-member', 'profmember', 'pm@prof.local', 'x', 'user', $1),
         ('usr-prof-badmin', 'profbadmin', 'pb@prof.local', 'x', 'admin', $2)
       ON CONFLICT (id) DO NOTHING`,
      [orgA, orgB]
    );
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
       VALUES ('node-prof-gw', $1, 'usr-prof-admin', 'gw', '100.64.30.1', 'fd00:30::1', $2, 'RELAY', TRUE, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [orgA, gatewayKey]
    );
    const token = (id, username, role, org) =>
      issueConsoleTestToken({ sub: id, id, username, role, organization_id: org });
    adminToken = await token('usr-prof-admin', 'profadmin', 'admin', orgA);
    memberToken = await token('usr-prof-member', 'profmember', 'user', orgA);
    otherAdminToken = await token('usr-prof-badmin', 'profbadmin', 'admin', orgB);
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM nodes WHERE device_kind = 'profile'");
    await pool.query('UPDATE nodes SET profile_gateway_endpoint = NULL');
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('refuses a device while the organisation has no gateway', async () => {
    const res = await register(memberToken, { name: 'phone', public_key: key(), preshared_key: key() });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'no_profile_gateway');
    // The console tells the person what to do from `code`; without it the page showed
    // "the key was already in use" to an owner who had not chosen a gateway yet.
    assert.strictEqual(res.body.code, 'no_profile_gateway');
  });

  it('marks a key that is already registered with its own code', async () => {
    await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' });
    const pk = key();
    assert.strictEqual((await register(memberToken, { name: 'a', public_key: pk, preshared_key: key() })).status, 201);
    const again = await register(memberToken, { name: 'b', public_key: pk, preshared_key: key() });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, 'public_key_in_use');
  });

  it('lets only an administrator name the gateway, and only a node of their organisation', async () => {
    assert.strictEqual(
      (await setGateway(memberToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      403
    );
    assert.strictEqual(
      (await setGateway(otherAdminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      404
    );
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'not an endpoint' })).status,
      400
    );
    const ok = await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.gateway.endpoint, 'gw.example:51820');
  });

  it('registers a device from its public key and answers with what the profile needs, never a private key', async () => {
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      200
    );
    const pub = key();
    const psk = key();
    const res = await register(memberToken, { name: 'phone', public_key: pub, preshared_key: psk });
    assert.strictEqual(res.status, 201);
    assert.match(res.body.device_id, /^dev-[0-9a-f]{12}$/);
    assert.match(res.body.overlay_ipv4, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/);
    assert.deepStrictEqual(res.body.gateway, { public_key: gatewayKey, endpoint: 'gw.example:51820' });
    assert.deepStrictEqual(res.body.allowed_ips, ['100.64.0.0/10']);
    assert.ok(res.body.console_url.startsWith('https://'));
    assert.ok(!/private/i.test(JSON.stringify(res.body)), 'no private key field in the answer');
    assert.ok(!JSON.stringify(res.body).includes(psk), 'the PSK is not echoed back');

    const row = (
      await pool.query(
        'SELECT device_kind, public_key, preshared_key, organization_id, user_id FROM nodes WHERE id = $1',
        [res.body.device_id]
      )
    ).rows[0];
    assert.deepStrictEqual(row, {
      device_kind: 'profile',
      public_key: pub,
      preshared_key: psk,
      organization_id: orgA,
      user_id: 'usr-prof-member'
    });
  });

  it('refuses keys that are not 32 bytes and a public key already in use', async () => {
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      200
    );
    const short = crypto.randomBytes(16).toString('base64');
    assert.strictEqual(
      (await register(memberToken, { name: 'p', public_key: short, preshared_key: key() })).status,
      400
    );
    assert.strictEqual(
      (await register(memberToken, { name: 'p', public_key: key(), preshared_key: 'nope' })).status,
      400
    );
    assert.strictEqual(
      (await register(memberToken, { name: '', public_key: key(), preshared_key: key() })).status,
      400
    );
    assert.strictEqual(
      (await register(memberToken, { name: 'p', public_key: gatewayKey, preshared_key: key() })).status,
      409
    );
  });

  it('audits the new device without its PSK', async () => {
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      200
    );
    const psk = key();
    const res = await register(memberToken, { name: 'laptop', public_key: key(), preshared_key: psk });
    assert.strictEqual(res.status, 201);
    await settleAuditWrites();
    const rows = (
      await pool.query(
        "SELECT message, metadata_json FROM audit_events WHERE event_type = 'PROFILE_DEVICE_CREATED' AND target_id = $1",
        [res.body.device_id]
      )
    ).rows;
    assert.strictEqual(rows.length, 1);
    assert.ok(!JSON.stringify(rows[0]).includes(psk));
  });

  it('lets a person remove their own phone from the web, revoking its key, but not a device of someone else', async () => {
    // iOS joins with the official WireGuard app (ADR 0029); the owner controls it from /me.
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      200
    );
    const pub = key();
    const mine = await register(memberToken, { name: 'iPhone', public_key: pub, preshared_key: key() });
    assert.strictEqual(mine.status, 201);
    const theirs = await register(adminToken, { name: 'admin laptop', public_key: key(), preshared_key: key() });
    assert.strictEqual(theirs.status, 201);

    const denied = await request(app).delete(`/api/nodes/${theirs.body.device_id}`).set(auth(memberToken));
    assert.strictEqual(denied.status, 404, 'a device of someone else must look like it does not exist');

    const removed = await request(app).delete(`/api/nodes/${mine.body.device_id}`).set(auth(memberToken));
    assert.strictEqual(removed.status, 200);
    const row = await pool.query('SELECT 1 FROM nodes WHERE id = $1', [mine.body.device_id]);
    assert.strictEqual(row.rows.length, 0);
    const hex = Buffer.from(pub, 'base64').toString('hex');
    const revoked = await pool.query('SELECT 1 FROM revoked_keys WHERE lower(public_key_hex) = $1', [hex]);
    assert.strictEqual(revoked.rows.length, 1, 'the key must be revoked so the gateway drops it');
  });

  it('moves the netmap version so the gateway learns the device', async () => {
    assert.strictEqual(
      (await setGateway(adminToken, { node_id: 'node-prof-gw', endpoint: 'gw.example:51820' })).status,
      200
    );
    const before = Number((await pool.query("SELECT epoch FROM mesh_epochs WHERE name='netmap'")).rows[0].epoch);
    assert.strictEqual(
      (await register(memberToken, { name: 'p', public_key: key(), preshared_key: key() })).status,
      201
    );
    const after = Number((await pool.query("SELECT epoch FROM mesh_epochs WHERE name='netmap'")).rows[0].epoch);
    assert.ok(after > before);
  });
});

describe('ADR 0029 A2: the gateway netmap carries profile devices', () => {
  const NetmapService = require('../services/NetmapService');
  let dbHelper;
  let pool;
  let app;
  let adminToken;
  const org = 'org-prof-nm';
  const gwKey = key();
  const peerKey = key();
  const hexOf = (b64) => Buffer.from(b64, 'base64').toString('hex');

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'NM', 'prof-nm', 'deny')`,
      [org]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-nm-admin', 'nmadmin', 'nm@prof.local', 'x', 'admin', $1)`,
      [org]
    );
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
       VALUES ('node-nm-gw', $1, 'usr-nm-admin', 'gw', '100.64.40.1', 'fd00:40::1', $2, 'RELAY', TRUE, FALSE),
              ('node-nm-peer', $1, 'usr-nm-admin', 'peer', '100.64.40.2', 'fd00:40::2', $3, 'CLIENT_ORIGIN', TRUE, FALSE)`,
      [org, gwKey, peerKey]
    );
    await pool.query(
      `INSERT INTO acl_rules (id, priority, source_cidr, destination_cidr, protocol, port_start, port_end, action, organization_id)
       VALUES ('acl-nm-all', 10, '100.64.0.0/10', '100.64.0.0/10', 'ALL', 0, 65535, 'ACCEPT', $1)`,
      [org]
    );
    adminToken = await issueConsoleTestToken({
      sub: 'usr-nm-admin',
      id: 'usr-nm-admin',
      username: 'nmadmin',
      role: 'admin',
      organization_id: org
    });
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('lists the device with its static PSK on the gateway only, and routes it through the gateway elsewhere', async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };
    assert.strictEqual(
      (
        await request(app)
          .put('/api/devices/gateway')
          .set(auth)
          .send({ node_id: 'node-nm-gw', endpoint: 'gw.example:51820' })
      ).status,
      200
    );
    const psk = key();
    const dev = await request(app)
      .post('/api/devices/profile')
      .set(auth)
      .send({ name: 'phone', public_key: key(), preshared_key: psk });
    assert.strictEqual(dev.status, 201);
    const vip = dev.body.overlay_ipv4;

    const gw = await NetmapService.buildNetmap('node-nm-gw');
    const entry = gw.peers.find((p) => p.node_id === dev.body.device_id);
    assert.ok(entry, 'the gateway lists the device');
    assert.strictEqual(entry.profile, true);
    assert.strictEqual(entry.preshared_key_hex, hexOf(psk));
    assert.deepStrictEqual(entry.endpoints, []);
    assert.ok(entry.allowed_ips.includes(`${vip}/32`));
    assert.ok(!gw.peers.find((p) => p.node_id === 'node-nm-peer').preshared_key_hex, 'mesh peers carry no static PSK');

    const other = await NetmapService.buildNetmap('node-nm-peer');
    assert.ok(
      !other.peers.some((p) => p.node_id === dev.body.device_id),
      'a non-gateway node never peers with a device'
    );
    const viaGateway = other.peers.find((p) => p.node_id === 'node-nm-gw');
    assert.ok(viaGateway.allowed_ips.includes(`${vip}/32`), "the device's address is routed to the gateway");
    assert.ok(!JSON.stringify(other).includes(hexOf(psk)), 'the PSK reaches the gateway only');
  });

  it('drops a quarantined device from the gateway and from the route through it', async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };
    const dev = await request(app)
      .post('/api/devices/profile')
      .set(auth)
      .send({ name: 'lost', public_key: key(), preshared_key: key() });
    assert.strictEqual(dev.status, 201);
    await pool.query('UPDATE nodes SET is_quarantined = TRUE WHERE id = $1', [dev.body.device_id]);
    const gw = await NetmapService.buildNetmap('node-nm-gw');
    assert.ok(!gw.peers.some((p) => p.node_id === dev.body.device_id));
    const other = await NetmapService.buildNetmap('node-nm-peer');
    assert.ok(!other.peers.find((p) => p.node_id === 'node-nm-gw').allowed_ips.includes(`${dev.body.overlay_ipv4}/32`));
  });
});

describe('ADR 0029 A5: the gateway relays under each device own policy', () => {
  const NetmapService = require('../services/NetmapService');
  let dbHelper;
  let pool;
  let app;
  let adminToken;
  const org = 'org-prof-a5';
  // A node enrolled over the control plane stores its key in hex (goBridge), which is
  // not what a WireGuard configuration takes.
  const gwKey = crypto.randomBytes(32).toString('hex');
  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    // Deny by default: what is permitted is exactly what a rule names.
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'A5', 'prof-a5', 'deny')`,
      [org]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-a5-admin', 'a5admin', 'a5@prof.local', 'x', 'admin', $1)`,
      [org]
    );
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
       VALUES ('node-a5-gw', $1, 'usr-a5-admin', 'gw', '100.64.50.1', 'fd00:50::1', $2, 'RELAY', TRUE, FALSE),
              ('node-a5-srv', $1, 'usr-a5-admin', 'srv', '100.64.50.2', 'fd00:50::2', $3, 'CLIENT_ORIGIN', TRUE, FALSE),
              ('node-a5-other', $1, 'usr-a5-admin', 'other', '100.64.50.3', 'fd00:50::3', $4, 'CLIENT_ORIGIN', TRUE, FALSE)`,
      [org, gwKey, key(), key()]
    );
    adminToken = await issueConsoleTestToken({
      sub: 'usr-a5-admin',
      id: 'usr-a5-admin',
      username: 'a5admin',
      role: 'admin',
      organization_id: org
    });
    const gw = await request(app)
      .put('/api/devices/gateway')
      .set(auth())
      .send({ node_id: 'node-a5-gw', endpoint: 'gw.example:51820' });
    assert.strictEqual(gw.status, 200);
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM nodes WHERE device_kind = 'profile'");
    await pool.query('DELETE FROM acl_rules WHERE organization_id = $1', [org]);
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  const registerDevice = async () => {
    const res = await request(app)
      .post('/api/devices/profile')
      .set(auth())
      .send({ name: 'phone', public_key: key(), preshared_key: key() });
    assert.strictEqual(res.status, 201);
    return res.body;
  };
  const allow = (id, src, dst, port) =>
    pool.query(
      `INSERT INTO acl_rules (id, priority, source_cidr, destination_cidr, protocol, port_start, port_end, action, organization_id)
       VALUES ($1, 10, $2, $3, 'TCP', $4, $4, 'ACCEPT', $5)`,
      [id, src, dst, port, org]
    );

  it('answers the gateway key in the base64 form every WireGuard app reads', async () => {
    const dev = await registerDevice();
    assert.strictEqual(dev.gateway.public_key, Buffer.from(gwKey, 'hex').toString('base64'));
    const named = await request(app)
      .put('/api/devices/gateway')
      .set(auth())
      .send({ node_id: 'node-a5-gw', endpoint: 'gw.example:51820' });
    assert.strictEqual(named.body.gateway.public_key, Buffer.from(gwKey, 'hex').toString('base64'));
  });

  it("sends the gateway the device's own compiled policy", async () => {
    const dev = await registerDevice();
    await allow('acl-a5-dev-srv', `${dev.overlay_ipv4}/32`, '100.64.50.2/32', 9999);
    const gw = await NetmapService.buildNetmap('node-a5-gw');
    const entry = gw.peers.find((p) => p.node_id === dev.device_id);
    assert.ok(entry && entry.acl, 'the device entry carries its policy');
    assert.strictEqual(entry.acl.overlay_ipv4, dev.overlay_ipv4);
    assert.deepStrictEqual(
      entry.acl.outbound_rules.map((r) => [r.allowed_peer_vip, r.protocol, r.port_ranges[0].start, r.action]),
      [['100.64.50.2', 'TCP', 9999, 'ACCEPT']]
    );
    const mesh = gw.peers.find((p) => p.node_id === 'node-a5-srv');
    assert.ok(mesh && !mesh.acl, 'a mesh peer carries no policy of its own');
  });

  it('connects device and server through the gateway when a rule names only the two of them', async () => {
    const dev = await registerDevice();
    await allow('acl-a5-dev-srv', `${dev.overlay_ipv4}/32`, '100.64.50.2/32', 9999);

    // The gateway's own policy permits nobody, yet it must serve the device and reach
    // the server the device may reach, or the rule connects nothing.
    const gw = await NetmapService.buildNetmap('node-a5-gw');
    assert.ok(
      gw.peers.some((p) => p.node_id === dev.device_id),
      'the gateway serves the device whatever its own policy says'
    );
    const srvAtGw = gw.peers.find((p) => p.node_id === 'node-a5-srv');
    assert.ok(srvAtGw, 'the gateway holds the server the device may reach');
    assert.deepStrictEqual(srvAtGw.allowed_ips, ['100.64.50.2/32', 'fd00:50::2/128']);
    assert.ok(
      !gw.peers.some((p) => p.node_id === 'node-a5-other'),
      'a node neither the gateway nor any device may reach is not listed'
    );

    // The server's policy permits the device and not the gateway: it holds the gateway
    // for the device's address only.
    const srv = await NetmapService.buildNetmap('node-a5-srv');
    const gwAtSrv = srv.peers.find((p) => p.node_id === 'node-a5-gw');
    assert.ok(gwAtSrv, 'the server holds the gateway, the only way to the device');
    assert.deepStrictEqual(
      gwAtSrv.allowed_ips.filter((a) => !a.includes(':')),
      [`${dev.overlay_ipv4}/32`],
      "only the device's address, not the gateway's own"
    );

    const other = await NetmapService.buildNetmap('node-a5-other');
    assert.ok(!other.peers.some((p) => p.node_id === 'node-a5-gw'), 'a node the device may not reach gets no route');
  });

  it('keeps the gateway own address when its own policy permits it', async () => {
    const dev = await registerDevice();
    await allow('acl-a5-dev-srv', `${dev.overlay_ipv4}/32`, '100.64.50.2/32', 9999);
    await allow('acl-a5-gw-srv', '100.64.50.1/32', '100.64.50.2/32', 22);
    const srv = await NetmapService.buildNetmap('node-a5-srv');
    const gwAtSrv = srv.peers.find((p) => p.node_id === 'node-a5-gw');
    assert.deepStrictEqual(
      new Set(gwAtSrv.allowed_ips.filter((a) => !a.includes(':'))),
      new Set(['100.64.50.1/32', `${dev.overlay_ipv4}/32`])
    );
  });
});
