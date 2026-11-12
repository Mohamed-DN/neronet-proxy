// Several profile gateways per organisation (study GATEWAY-PER-UTENTE-NOV12, option B).
//
// An organisation may name more than one mesh node as a gateway for WireGuard-app devices,
// exactly one of them the default. Each profile device is served by one gateway: the one an
// administrator assigned, otherwise the default. Only that gateway holds the device as a
// peer, every other node routes the device's address to it, its profile names it, and only
// its handshake reports are believed.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { nodeKey, register: enrolNode } = require('./helpers/nodeEnrolment');
const { runPostgresMigrations } = require('../db/migrator');
const { createApp } = require('../server');

const MIGRATION = '051_multiple_profile_gateways.sql';
const key = () => crypto.randomBytes(32).toString('base64');
const hexOf = (b64) => Buffer.from(b64, 'base64').toString('hex');
const b64OfHex = (hex) => Buffer.from(hex, 'hex').toString('base64');
const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('several profile gateways per organisation', () => {
  const NetmapService = require('../services/NetmapService');
  const ORG = 'org-mgw-a';
  const OTHER = 'org-mgw-b';
  let db;
  let pool;
  let app;
  let admin;
  let member;
  let otherAdmin;
  const nodes = {};

  async function enrol(name, org) {
    const publicKeyHex = nodeKey();
    const res = await enrolNode(app, { public_key_hex: publicKeyHex, role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const id = res.body.assigned_node_id;
    await pool.query('UPDATE nodes SET organization_id = $1, name = $2 WHERE id = $3', [org, name, id]);
    return { id, credential: res.body.credential, publicKey: b64OfHex(publicKeyHex) };
  }

  const setGateway = (token, body) => request(app).put('/api/devices/gateway').set(auth(token)).send(body);
  const listGateways = (token) => request(app).get('/api/devices/gateways').set(auth(token));
  const makeDefault = (token, id) => request(app).put(`/api/devices/gateways/${id}/default`).set(auth(token)).send({});
  const unsetGateway = (token, id) => request(app).delete(`/api/devices/gateways/${id}`).set(auth(token));
  const assign = (token, deviceId, gatewayId) =>
    request(app).put(`/api/devices/${deviceId}/gateway`).set(auth(token)).send({ gateway_node_id: gatewayId });
  const registerDevice = (token, body = {}) =>
    request(app)
      .post('/api/devices/profile')
      .set(auth(token))
      .send({ name: 'phone', public_key: key(), preshared_key: key(), ...body });
  const gatewayOfRow = async (id) =>
    (await pool.query('SELECT gateway_node_id FROM nodes WHERE id = $1', [id])).rows[0].gateway_node_id;
  const beat = (node, deviceId, unix) =>
    request(app)
      .post('/v4/control/heartbeat')
      .set(auth(node.credential))
      .send({
        node_id: node.id,
        peer_paths: [
          {
            peer_id: deviceId,
            last_handshake_unix: unix,
            wg_rx_bytes: '1',
            wg_tx_bytes: '1',
            observed_at_unix: 0,
            state: 'profile',
            rtt_ms: null
          }
        ]
      });
  const handshakeOf = async (id) =>
    (await pool.query('SELECT last_handshake_at FROM nodes WHERE id = $1', [id])).rows[0].last_handshake_at;

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ($1, 'MGW A', 'mgw-a', 'deny'), ($2, 'MGW B', 'mgw-b', 'deny')`,
      [ORG, OTHER]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-mgw-admin', 'mgwadmin', 'a@mgw.local', 'x', 'admin', $1),
         ('usr-mgw-member', 'mgwmember', 'm@mgw.local', 'x', 'user', $1),
         ('usr-mgw-badmin', 'mgwbadmin', 'b@mgw.local', 'x', 'admin', $2)`,
      [ORG, OTHER]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-mgw-admin', 'usr-mgw-admin', $1, 'admin'),
         ('mem-mgw-member', 'usr-mgw-member', $1, 'member'),
         ('mem-mgw-badmin', 'usr-mgw-badmin', $2, 'admin')`,
      [ORG, OTHER]
    );
    const token = (id, username, role, org) =>
      issueConsoleTestToken({ sub: id, id, username, role, organization_id: org });
    admin = await token('usr-mgw-admin', 'mgwadmin', 'admin', ORG);
    member = await token('usr-mgw-member', 'mgwmember', 'user', ORG);
    otherAdmin = await token('usr-mgw-badmin', 'mgwbadmin', 'admin', OTHER);
    nodes.g1 = await enrol('office', ORG);
    nodes.g2 = await enrol('branch', ORG);
    nodes.server = await enrol('server', ORG);
    nodes.foreign = await enrol('foreign-gw', OTHER);
    await pool.query(
      `INSERT INTO acl_rules (id, priority, source_cidr, destination_cidr, protocol, port_start, port_end, action, organization_id)
       VALUES ('acl-mgw-all', 10, '100.64.0.0/10', '100.64.0.0/10', 'ALL', 0, 65535, 'ACCEPT', $1)`,
      [ORG]
    );
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('names two gateways in one organisation; the first becomes the default', async () => {
    const one = await setGateway(admin, { node_id: nodes.g1.id, endpoint: 'office.example.com:51820' });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.gateway.is_default, true);
    const two = await setGateway(admin, { node_id: nodes.g2.id, endpoint: 'branch.example.com:51820' });
    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.equal(two.body.gateway.is_default, false, 'a second gateway does not take the default');
    const other = await setGateway(otherAdmin, { node_id: nodes.foreign.id, endpoint: '192.0.2.40:51820' });
    assert.equal(other.status, 200);

    const list = await listGateways(admin);
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.gateways.map((g) => [g.node_id, g.name, g.endpoint, g.is_default, g.devices]),
      [
        [nodes.g1.id, 'office', 'office.example.com:51820', true, 0],
        [nodes.g2.id, 'branch', 'branch.example.com:51820', false, 0]
      ]
    );
    assert.ok('last_seen_at' in list.body.gateways[0]);
    assert.ok(!JSON.stringify(list.body).includes(nodes.foreign.id), "another organisation's gateway is not listed");
  });

  it('the database refuses a second default in one organisation', async () => {
    await assert.rejects(
      pool.query('UPDATE nodes SET is_default_profile_gateway = TRUE WHERE id = $1', [nodes.g2.id]),
      (err) => err.code === '23505'
    );
  });

  it('only an administrator of the organisation changes the default', async () => {
    assert.equal((await makeDefault(member, nodes.g2.id)).status, 403);
    assert.equal((await makeDefault(otherAdmin, nodes.g2.id)).status, 404);
    assert.equal((await makeDefault(admin, nodes.server.id)).status, 404, 'a node that is not a gateway');
    const ok = await makeDefault(admin, nodes.g2.id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const list = await listGateways(admin);
    assert.deepEqual(
      list.body.gateways.map((g) => [g.node_id, g.is_default]),
      [
        [nodes.g2.id, true],
        [nodes.g1.id, false]
      ],
      'the default is listed first'
    );
    assert.equal((await makeDefault(admin, nodes.g1.id)).status, 200);
  });

  it('registers a device on the default gateway, and its profile names that gateway', async () => {
    const res = await registerDevice(member);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.gateway, { public_key: nodes.g1.publicKey, endpoint: 'office.example.com:51820' });
    assert.equal(await gatewayOfRow(res.body.device_id), nodes.g1.id);
    nodes.d1 = res.body;
  });

  it('lets an administrator register a device on another gateway, and nobody else', async () => {
    const refused = await registerDevice(member, { gateway_node_id: nodes.g2.id });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'gateway_not_permitted');
    const foreign = await registerDevice(admin, { gateway_node_id: nodes.foreign.id });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.code, 'no_such_gateway');
    const notGateway = await registerDevice(admin, { gateway_node_id: nodes.server.id });
    assert.equal(notGateway.status, 404);

    const res = await registerDevice(admin, { gateway_node_id: nodes.g2.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.gateway, { public_key: nodes.g2.publicKey, endpoint: 'branch.example.com:51820' });
    assert.equal(await gatewayOfRow(res.body.device_id), nodes.g2.id);
    nodes.d2 = res.body;
  });

  it('each gateway holds only its own devices, and other nodes route each device to its gateway', async () => {
    const g1 = await NetmapService.buildNetmap(nodes.g1.id);
    const g2 = await NetmapService.buildNetmap(nodes.g2.id);
    assert.ok(g1.peers.some((p) => p.node_id === nodes.d1.device_id && p.profile));
    assert.ok(!g1.peers.some((p) => p.node_id === nodes.d2.device_id), 'G1 does not hold D2');
    assert.ok(g2.peers.some((p) => p.node_id === nodes.d2.device_id && p.profile));
    assert.ok(!g2.peers.some((p) => p.node_id === nodes.d1.device_id), 'G2 does not hold D1');

    const srv = await NetmapService.buildNetmap(nodes.server.id);
    const toG1 = srv.peers.find((p) => p.node_id === nodes.g1.id);
    const toG2 = srv.peers.find((p) => p.node_id === nodes.g2.id);
    assert.ok(toG1.allowed_ips.includes(`${nodes.d1.overlay_ipv4}/32`));
    assert.ok(!toG1.allowed_ips.includes(`${nodes.d2.overlay_ipv4}/32`));
    assert.ok(toG2.allowed_ips.includes(`${nodes.d2.overlay_ipv4}/32`));
    assert.ok(!toG2.allowed_ips.includes(`${nodes.d1.overlay_ipv4}/32`));
  });

  it("believes a handshake only from the device's own gateway", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await beat(nodes.g2, nodes.d1.device_id, now - 5)).status, 200);
    assert.equal(await handshakeOf(nodes.d1.device_id), null, 'G2 does not serve D1');
    assert.equal((await beat(nodes.g1, nodes.d1.device_id, now - 5)).status, 200);
    assert.equal(new Date(await handshakeOf(nodes.d1.device_id)).getTime(), (now - 5) * 1000);
  });

  it('counts the devices each gateway serves, and the nodes list names the gateway of a device', async () => {
    const list = await listGateways(admin);
    assert.deepEqual(
      list.body.gateways.map((g) => [g.node_id, g.devices]),
      [
        [nodes.g1.id, 1],
        [nodes.g2.id, 1]
      ]
    );
    const node = await request(app).get(`/api/nodes/${nodes.d1.device_id}`).set(auth(admin));
    assert.equal(node.body.node.gateway_node_id, nodes.g1.id);
  });

  it('the topology names the gateway each profile device goes through', async () => {
    const res = await request(app).get('/api/stats/topology').set(auth(admin));
    assert.equal(res.status, 200);
    const by = Object.fromEntries(res.body.nodes.map((n) => [n.id, n]));
    assert.equal(by[nodes.d1.device_id].gateway_node_id, nodes.g1.id);
    assert.equal(by[nodes.d2.device_id].gateway_node_id, nodes.g2.id);
    assert.equal(by[nodes.g1.id].gateway_node_id, null, 'a mesh node goes through no gateway');
  });

  it('refuses to move a device for a member, to a gateway of another organisation, or for another admin', async () => {
    const byMember = await assign(member, nodes.d1.device_id, nodes.g2.id);
    assert.equal(byMember.status, 403);
    assert.equal(byMember.body.code, 'gateway_not_permitted');
    const foreign = await assign(admin, nodes.d1.device_id, nodes.foreign.id);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.code, 'no_such_gateway');
    const byOther = await assign(otherAdmin, nodes.d1.device_id, nodes.foreign.id);
    assert.equal(byOther.status, 404);
    const notDevice = await assign(admin, nodes.server.id, nodes.g2.id);
    assert.equal(notDevice.status, 404);
    assert.equal(await gatewayOfRow(nodes.d1.device_id), nodes.g1.id, 'nothing changed');
  });

  it('moves a device to another gateway and says its profile must be imported again', async () => {
    const res = await assign(admin, nodes.d1.device_id, nodes.g2.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.reimport_required, true);
    assert.deepEqual(res.body.gateway, {
      node_id: nodes.g2.id,
      name: 'branch',
      public_key: nodes.g2.publicKey,
      endpoint: 'branch.example.com:51820'
    });
    assert.equal(await gatewayOfRow(nodes.d1.device_id), nodes.g2.id);

    const g1 = await NetmapService.buildNetmap(nodes.g1.id);
    const g2 = await NetmapService.buildNetmap(nodes.g2.id);
    assert.ok(!g1.peers.some((p) => p.node_id === nodes.d1.device_id), 'the old gateway lets the device go');
    assert.ok(
      g2.peers.some((p) => p.node_id === nodes.d1.device_id),
      'the new gateway holds it'
    );

    const again = await assign(admin, nodes.d1.device_id, nodes.g2.id);
    assert.equal(again.status, 200);
    assert.equal(again.body.reimport_required, false, 'no change, nothing to import');

    const stamp = await handshakeOf(nodes.d1.device_id);
    await beat(nodes.g1, nodes.d1.device_id, Math.floor(Date.now() / 1000));
    assert.deepEqual(await handshakeOf(nodes.d1.device_id), stamp, 'the old gateway is no longer believed');
  });

  it('an exit on the device own gateway is "self" in that gateway netmap', async () => {
    await pool.query("UPDATE nodes SET role = 'EXIT_BRIDGE' WHERE id = $1", [nodes.g2.id]);
    try {
      const res = await registerDevice(admin, { gateway_node_id: nodes.g2.id, exit_node_id: nodes.g2.id });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const g2 = await NetmapService.buildNetmap(nodes.g2.id);
      const entry = g2.peers.find((p) => p.node_id === res.body.device_id);
      assert.equal(entry.exit.via, 'self');
      await pool.query('DELETE FROM nodes WHERE id = $1', [res.body.device_id]);
    } finally {
      await pool.query("UPDATE nodes SET role = 'CLIENT_ORIGIN' WHERE id = $1", [nodes.g2.id]);
    }
  });

  it('a device on one gateway can leave through another gateway that is an exit', async () => {
    await pool.query("UPDATE nodes SET role = 'EXIT_BRIDGE' WHERE id = $1", [nodes.g2.id]);
    try {
      const res = await registerDevice(admin, { gateway_node_id: nodes.g1.id, exit_node_id: nodes.g2.id });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const ip = `${res.body.overlay_ipv4}/32`;
      const g1 = await NetmapService.buildNetmap(nodes.g1.id);
      const entry = g1.peers.find((p) => p.node_id === res.body.device_id);
      assert.deepEqual([entry.exit.via, entry.exit.node_id], ['mesh', nodes.g2.id]);
      assert.ok(g1.peers.find((p) => p.node_id === nodes.g2.id).allowed_ips.includes('0.0.0.0/0'));
      const g2 = await NetmapService.buildNetmap(nodes.g2.id);
      assert.ok(!g2.peers.some((p) => p.node_id === res.body.device_id), 'G2 does not serve the device');
      assert.ok(
        (g2.exit_clients || []).some((c) => c.node_id === res.body.device_id),
        'G2 lets it out'
      );
      assert.ok(g2.peers.find((p) => p.node_id === nodes.g1.id).allowed_ips.includes(ip), 'and routes replies to G1');
      await pool.query('DELETE FROM nodes WHERE id = $1', [res.body.device_id]);
    } finally {
      await pool.query("UPDATE nodes SET role = 'CLIENT_ORIGIN' WHERE id = $1", [nodes.g2.id]);
    }
  });

  it('refuses to remove a gateway that still serves devices, and says how many', async () => {
    const res = await unsetGateway(admin, nodes.g2.id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'profile_gateway_serves_devices');
    assert.equal(res.body.devices, 2);
    assert.equal((await unsetGateway(member, nodes.g1.id)).status, 403);
    assert.equal((await unsetGateway(otherAdmin, nodes.g1.id)).status, 404);
  });

  it('refuses to remove the default while another gateway exists', async () => {
    await assign(admin, nodes.d1.device_id, nodes.g2.id);
    const res = await unsetGateway(admin, nodes.g1.id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'profile_gateway_is_default');
  });

  it('removes a gateway that serves nobody and is not the default', async () => {
    assert.equal((await makeDefault(admin, nodes.g2.id)).status, 200);
    const res = await unsetGateway(admin, nodes.g1.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = (await pool.query('SELECT profile_gateway_endpoint FROM nodes WHERE id = $1', [nodes.g1.id])).rows[0];
    assert.equal(row.profile_gateway_endpoint, null);
    const list = await listGateways(admin);
    assert.deepEqual(
      list.body.gateways.map((g) => g.node_id),
      [nodes.g2.id]
    );
  });
});

describe('migration 051 on a production-shaped install', () => {
  const NetmapService = require('../services/NetmapService');
  const ORG = 'org-mgw-prod';
  let db;
  let pool;
  let app;
  let admin;
  let gateway;
  let server;
  const phone = { id: 'dev-0123456789ab', key: key(), psk: key() };
  const HANDSHAKE = new Date('2026-11-12T08:00:00Z');

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();

    // Back to the schema as it was after 050: one gateway per organisation, no default
    // flag, no per-device gateway.
    await pool.query(`
      DROP INDEX IF EXISTS idx_nodes_one_default_profile_gateway_per_org;
      DROP INDEX IF EXISTS idx_nodes_gateway_node_id;
      ALTER TABLE nodes DROP COLUMN IF EXISTS gateway_node_id;
      ALTER TABLE nodes DROP COLUMN IF EXISTS is_default_profile_gateway;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_one_profile_gateway_per_org
          ON nodes (COALESCE(organization_id, 'org-default')) WHERE profile_gateway_endpoint IS NOT NULL;
      DELETE FROM _migrations WHERE name = '${MIGRATION}';
    `);

    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'Prod', 'mgw-prod', 'deny')`,
      [ORG]
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-mgw-prod', 'mgwprod', 'p@mgw.local', 'x', 'admin', $1)`,
      [ORG]
    );
    admin = await issueConsoleTestToken({
      sub: 'usr-mgw-prod',
      id: 'usr-mgw-prod',
      username: 'mgwprod',
      role: 'admin',
      organization_id: ORG
    });
    const enrol = async (name) => {
      const hex = nodeKey();
      const res = await enrolNode(app, { public_key_hex: hex, role: 'CLIENT_ORIGIN', endpoints: [] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await pool.query('UPDATE nodes SET organization_id = $1, name = $2 WHERE id = $3', [
        ORG,
        name,
        res.body.assigned_node_id
      ]);
      return { id: res.body.assigned_node_id, credential: res.body.credential, publicKey: b64OfHex(hex) };
    };
    gateway = await enrol('home-gateway');
    server = await enrol('nas');
    await pool.query('UPDATE nodes SET profile_gateway_endpoint = $1 WHERE id = $2', [
      'gw.example.com:51820',
      gateway.id
    ]);
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, preshared_key,
                          role, ip_class, is_healthy, is_quarantined, device_kind, last_handshake_at)
       VALUES ($1, $2, 'usr-mgw-prod', 'iPhone', '100.64.90.7', 'fd00:90::7', $3, $4,
               'CLIENT_ORIGIN', 'UNKNOWN', TRUE, FALSE, 'profile', $5)`,
      [phone.id, ORG, phone.key, phone.psk, HANDSHAKE]
    );
    await pool.query(
      `INSERT INTO acl_rules (id, priority, source_cidr, destination_cidr, protocol, port_start, port_end, action, organization_id)
       VALUES ('acl-mgw-prod', 10, '100.64.0.0/10', '100.64.0.0/10', 'ALL', 0, 65535, 'ACCEPT', $1)`,
      [ORG]
    );

    await runPostgresMigrations(pool);
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('applies the migration once', async () => {
    const { rows } = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [MIGRATION]);
    assert.equal(rows.length, 1);
  });

  it('keeps the one gateway, its endpoint, and makes it the default', async () => {
    const { rows } = await pool.query(
      'SELECT profile_gateway_endpoint, is_default_profile_gateway FROM nodes WHERE id = $1',
      [gateway.id]
    );
    assert.deepEqual(rows[0], { profile_gateway_endpoint: 'gw.example.com:51820', is_default_profile_gateway: true });
  });

  it('leaves the iPhone as it was and assigned to that gateway', async () => {
    const { rows } = await pool.query(
      `SELECT public_key, preshared_key, overlay_ipv4, device_kind, exit_node_id, last_handshake_at, gateway_node_id
         FROM nodes WHERE id = $1`,
      [phone.id]
    );
    assert.deepEqual(rows[0], {
      public_key: phone.key,
      preshared_key: phone.psk,
      overlay_ipv4: '100.64.90.7',
      device_kind: 'profile',
      exit_node_id: null,
      last_handshake_at: HANDSHAKE,
      gateway_node_id: gateway.id
    });
  });

  it('the gateway still holds the iPhone with its PSK, and the server still routes it through the gateway', async () => {
    const gw = await NetmapService.buildNetmap(gateway.id);
    const entry = gw.peers.find((p) => p.node_id === phone.id);
    assert.ok(entry, 'the gateway lists the iPhone');
    assert.equal(entry.public_key_hex, hexOf(phone.key));
    assert.equal(entry.preshared_key_hex, hexOf(phone.psk));
    assert.deepEqual(entry.allowed_ips, ['100.64.90.7/32', 'fd00:90::7/128']);
    const srv = await NetmapService.buildNetmap(server.id);
    assert.ok(srv.peers.find((p) => p.node_id === gateway.id).allowed_ips.includes('100.64.90.7/32'));
  });

  it("still believes the gateway's handshake reports for the iPhone", async () => {
    const at = Math.floor(Date.now() / 1000) - 10;
    const res = await request(app)
      .post('/v4/control/heartbeat')
      .set(auth(gateway.credential))
      .send({
        node_id: gateway.id,
        peer_paths: [
          {
            peer_id: phone.id,
            last_handshake_unix: at,
            wg_rx_bytes: '1',
            wg_tx_bytes: '1',
            observed_at_unix: 0,
            state: 'profile',
            rtt_ms: null
          }
        ]
      });
    assert.equal(res.status, 200);
    const { rows } = await pool.query('SELECT last_handshake_at FROM nodes WHERE id = $1', [phone.id]);
    assert.equal(new Date(rows[0].last_handshake_at).getTime(), at * 1000);
  });

  it('lists the one gateway as default serving one device, and a new profile names the same gateway', async () => {
    const list = await request(app).get('/api/devices/gateways').set(auth(admin));
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.gateways.map((g) => [g.node_id, g.endpoint, g.is_default, g.devices]),
      [[gateway.id, 'gw.example.com:51820', true, 1]]
    );
    const res = await request(app)
      .post('/api/devices/profile')
      .set(auth(admin))
      .send({ name: 'laptop', public_key: key(), preshared_key: key() });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.gateway, { public_key: gateway.publicKey, endpoint: 'gw.example.com:51820' });
  });

  it('running the migration again changes nothing', async () => {
    const before = (await pool.query('SELECT id, gateway_node_id, is_default_profile_gateway FROM nodes ORDER BY id'))
      .rows;
    const fs = require('fs');
    const path = require('path');
    await pool.query(fs.readFileSync(path.resolve(__dirname, '../db/migrations', MIGRATION), 'utf8'));
    const after = (await pool.query('SELECT id, gateway_node_id, is_default_profile_gateway FROM nodes ORDER BY id'))
      .rows;
    assert.deepEqual(after, before);
  });
});
