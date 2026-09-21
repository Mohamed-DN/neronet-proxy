const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const RouteEngine = require('../services/RouteEngine');
const AclEngine = require('../services/AclEngine');

function registerBody(publicKeyHex, overrides = {}) {
  return {
    public_key_hex: publicKeyHex,
    role: 'CLIENT_ORIGIN',
    endpoints: [],
    capability: { country_code: 'IT' },
    ...overrides
  };
}

describe('CIDR encoding for the Go wire format', () => {
  // routes.NetworkRoute carries a *net.IPNet, which has no custom JSON marshalling,
  // so Go serialises it as {"IP": "...", "Mask": "<base64>"}. Emitting a CIDR string
  // there decodes to a nil network on the node and silently installs nothing.
  it('produces the object shape Go emits, not a string', () => {
    assert.deepStrictEqual(RouteEngine.cidrToGoIPNet('10.100.0.0/24'), {
      IP: '10.100.0.0',
      Mask: '////AA=='
    });
  });

  it('masks the address to its network', () => {
    // net.ParseCIDR returns the masked network, so a route stored against a host
    // address must be delivered as the network or the node cannot match it.
    assert.strictEqual(RouteEngine.cidrToGoIPNet('10.100.0.5/24').IP, '10.100.0.0');
    assert.strictEqual(RouteEngine.cidrToGoIPNet('192.168.1.0/16').IP, '192.168.0.0');
  });

  it('handles the boundary prefixes', () => {
    assert.deepStrictEqual(RouteEngine.cidrToGoIPNet('0.0.0.0/0'), { IP: '0.0.0.0', Mask: 'AAAAAA==' });
    assert.deepStrictEqual(RouteEngine.cidrToGoIPNet('10.0.0.1/32'), { IP: '10.0.0.1', Mask: '/////w==' });
  });

  it('rejects malformed input', () => {
    for (const bad of ['not-a-cidr', '10.0.0.0/33', '300.1.1.1/24', '']) {
      assert.strictEqual(RouteEngine.cidrToGoIPNet(bad), null, `${bad} should not encode`);
    }
  });
});

describe('Route delivery', () => {
  let app;
  let dbHelper;
  let gateway;
  let client;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();

    gateway = (
      await request(app)
        .post('/v4/control/register')
        .send(registerBody('a'.repeat(64), { role: 'EXIT_BRIDGE' }))
    ).body;
    client = (
      await request(app)
        .post('/v4/control/register')
        .send(registerBody('b'.repeat(64)))
    ).body;
  });

  after(async () => {
    if (dbHelper) {
      await dbHelper.cleanup();
    }
  });

  beforeEach(async () => {
    await dbHelper.pool.query('DELETE FROM network_routes');
  });

  async function sync(nodeId, epoch = 0) {
    return request(app).post('/v4/control/sync-routes').send({ node_id: nodeId, route_epoch: epoch });
  }

  it('delivers a route to a node that is not its gateway', async () => {
    await RouteEngine.createRoute({
      network_id: 'corp',
      network_cidr: '10.100.0.0/24',
      routing_peers: [{ node_id: gateway.assigned_node_id, priority: 1 }]
    });

    const res = await sync(client.assigned_node_id);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.routes.length, 1);
    assert.deepStrictEqual(res.body.routes[0].network_cidr, { IP: '10.100.0.0', Mask: '////AA==' });
    assert.strictEqual(res.body.routes[0].routing_peers[0].node_id, gateway.assigned_node_id);
  });

  it('does not give a gateway the route it is the gateway for', async () => {
    await RouteEngine.createRoute({
      network_cidr: '10.100.0.0/24',
      routing_peers: [{ node_id: gateway.assigned_node_id, priority: 1 }]
    });

    const res = await sync(gateway.assigned_node_id);

    // Installing it would send the gateway's own traffic for that subnet back into
    // the overlay instead of out of its local interface.
    assert.strictEqual(res.body.routes.length, 0);
  });

  it('withholds a route whose gateways are all unhealthy', async () => {
    await RouteEngine.createRoute({
      network_cidr: '10.100.0.0/24',
      routing_peers: [{ node_id: gateway.assigned_node_id, priority: 1 }]
    });

    await dbHelper.pool.query('UPDATE nodes SET is_healthy = false WHERE id = $1', [gateway.assigned_node_id]);

    const res = await sync(client.assigned_node_id);

    // A route with no reachable gateway is not a route. Delivering it makes the node
    // blackhole the subnet rather than fall back to its normal path.
    assert.strictEqual(res.body.routes.length, 0);

    await dbHelper.pool.query('UPDATE nodes SET is_healthy = true WHERE id = $1', [gateway.assigned_node_id]);
  });

  it('withholds a route whose gateway is quarantined', async () => {
    await RouteEngine.createRoute({
      network_cidr: '10.100.0.0/24',
      routing_peers: [{ node_id: gateway.assigned_node_id, priority: 1 }]
    });

    await dbHelper.pool.query('UPDATE nodes SET is_quarantined = true WHERE id = $1', [gateway.assigned_node_id]);
    assert.strictEqual((await sync(client.assigned_node_id)).body.routes.length, 0);
    await dbHelper.pool.query('UPDATE nodes SET is_quarantined = false WHERE id = $1', [gateway.assigned_node_id]);
  });

  it('drops gateways that no longer exist', async () => {
    await RouteEngine.createRoute({
      network_cidr: '10.100.0.0/24',
      routing_peers: [
        { node_id: gateway.assigned_node_id, priority: 1 },
        { node_id: 'pk_deadbeefdeadbeef', priority: 2 }
      ]
    });

    const res = await sync(client.assigned_node_id);

    assert.strictEqual(res.body.routes[0].routing_peers.length, 1);
    assert.strictEqual(res.body.routes[0].routing_peers[0].node_id, gateway.assigned_node_id);
  });

  it('orders gateways by priority', async () => {
    const second = (
      await request(app)
        .post('/v4/control/register')
        .send(registerBody('c'.repeat(64), { role: 'RELAY' }))
    ).body;

    await RouteEngine.createRoute({
      network_cidr: '10.100.0.0/24',
      routing_peers: [
        { node_id: second.assigned_node_id, priority: 5 },
        { node_id: gateway.assigned_node_id, priority: 1 }
      ]
    });

    const peers = (await sync(client.assigned_node_id)).body.routes[0].routing_peers;

    assert.strictEqual(peers[0].node_id, gateway.assigned_node_id, 'priority 1 must come first');
    assert.strictEqual(peers[1].node_id, second.assigned_node_id);
  });

  it('resolves peer health at delivery time, not at creation time', async () => {
    await RouteEngine.createRoute({
      network_cidr: '10.100.0.0/24',
      routing_peers: [{ node_id: gateway.assigned_node_id, priority: 1, is_healthy: true }]
    });

    const second = (
      await request(app)
        .post('/v4/control/register')
        .send(registerBody('d'.repeat(64), { role: 'RELAY' }))
    ).body;
    await RouteEngine.deleteRoute('none');

    await RouteEngine.createRoute({
      network_cidr: '10.200.0.0/24',
      routing_peers: [
        { node_id: gateway.assigned_node_id, priority: 1 },
        { node_id: second.assigned_node_id, priority: 2 }
      ]
    });

    await dbHelper.pool.query('UPDATE nodes SET is_healthy = false WHERE id = $1', [second.assigned_node_id]);

    const route = (await sync(client.assigned_node_id)).body.routes.find((r) => r.network_cidr.IP === '10.200.0.0');
    const unhealthy = route.routing_peers.find((p) => p.node_id === second.assigned_node_id);

    // Failover must reflect the fleet as it is now, not as it was when an operator
    // wrote the route.
    assert.strictEqual(unhealthy.is_healthy, false);

    await dbHelper.pool.query('UPDATE nodes SET is_healthy = true WHERE id = $1', [second.assigned_node_id]);
  });

  it('answers an unchanged epoch without building the route set', async () => {
    const epoch = await AclEngine.getEpoch('routes');
    const res = await sync(client.assigned_node_id, epoch);

    assert.strictEqual(res.body.new_route_epoch, epoch);
    assert.deepStrictEqual(res.body.routes, []);
  });

  it('refuses an unknown node', async () => {
    assert.strictEqual((await sync('pk_0000000000000000')).status, 404);
  });

  it('requires the enrolment token when one is configured', async () => {
    process.env.SOVEREIGN_REGISTRATION_TOKEN = 'route-token';
    try {
      assert.strictEqual((await sync(client.assigned_node_id)).status, 401);

      const allowed = await request(app)
        .post('/v4/control/sync-routes')
        .set('Authorization', 'Bearer route-token')
        .send({ node_id: client.assigned_node_id, route_epoch: 0 });
      assert.strictEqual(allowed.status, 200);
    } finally {
      delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
    }
  });
});
