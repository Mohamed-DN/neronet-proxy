const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const config = require('../config/env');
const NetmapService = require('../services/NetmapService');
const { nodeKey, register } = require('./helpers/nodeEnrolment');

/**
 * What a node that registers again leaves its peers to dial.
 *
 * A node registers again whenever its credential stops working: a quarantine was
 * lifted, the credential expired while the node was cut off, the database was
 * restored. The Go node sent that registration with no endpoints, and the upsert wrote
 * the empty list over the ones its heartbeats had reported. Every peer that fetched
 * its netmap before the node's next heartbeat got a WireGuard peer with nowhere to send
 * a handshake ("no known endpoint for peer"), and on the CI stack the overlay scenario
 * measured relay-de -> relay-fr as a timeout after the quarantine was lifted.
 *
 * Everything here goes through the HTTP endpoints a node and the console use, and the
 * assertions are on the netmap a peer is served: that is what decides whether the
 * handshake has an address to go to.
 */

const ENDPOINT_A = { ip_address: '10.89.0.12', port: 51820, protocol: 'udp' };
const ENDPOINT_B = { ip_address: '10.89.0.13', port: 51820, protocol: 'udp' };

describe('Registering again keeps a node reachable', () => {
  let app;
  let dbHelper;
  let observer;
  let adminToken;
  const credentials = new Map();

  async function enrol(key, body = {}) {
    const res = await register(app, { public_key_hex: key, role: 'CLIENT_ORIGIN', ...body }, { token: REGISTRATION_TOKEN });
    assert.strictEqual(res.status, 200, `registration: ${res.status} ${JSON.stringify(res.body)}`);
    credentials.set(res.body.assigned_node_id, res.body.credential);
    return res.body.assigned_node_id;
  }

  function beat(nodeId, endpoints) {
    return request(app)
      .post('/v4/control/heartbeat')
      .set('Authorization', `Bearer ${credentials.get(nodeId)}`)
      .send({ node_id: nodeId, endpoints });
  }

  /** The endpoints the observer's netmap gives for `nodeId`, or null when it is not a peer. */
  async function endpointsSeenFor(nodeId) {
    const res = await request(app)
      .post('/v4/control/netmap')
      .set('Authorization', `Bearer ${credentials.get(observer)}`)
      .send({ node_id: observer, version: 0 });
    assert.strictEqual(res.status, 200, `netmap: ${res.status} ${JSON.stringify(res.body)}`);
    const peer = res.body.peers.find((p) => p.node_id === nodeId);
    return peer ? peer.endpoints : null;
  }

  function admin(method, path, body) {
    return request(app)[method](path).set('Authorization', `Bearer ${adminToken}`).send(body);
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();

    observer = await enrol(nodeKey());
    const owner = (await dbHelper.pool.query('SELECT user_id FROM nodes WHERE id = $1', [observer])).rows[0].user_id;
    adminToken = jwt.sign(
      { sub: owner, id: owner, username: 'testadmin', role: 'super-admin', compartment_access: 'standard' },
      config.JWT_SECRET
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('keeps the endpoint a node reported when it registers again without one', async () => {
    const key = nodeKey();
    const node = await enrol(key);
    assert.strictEqual((await beat(node, [ENDPOINT_A])).status, 200);
    assert.deepStrictEqual(await endpointsSeenFor(node), ['10.89.0.12:51820']);

    // The Go node omits the field when it has nothing to report; another client may
    // send an empty list. Neither is a statement that the node has no address.
    await enrol(key);
    assert.deepStrictEqual(
      await endpointsSeenFor(node),
      ['10.89.0.12:51820'],
      'a registration without endpoints wiped the ones the heartbeat reported'
    );

    await enrol(key, { endpoints: [] });
    assert.deepStrictEqual(await endpointsSeenFor(node), ['10.89.0.12:51820']);
  });

  it('leaves a node reachable at its endpoint once its quarantine is lifted', async () => {
    // The overlay scenario's sequence, through the console API and the node API.
    const key = nodeKey();
    const node = await enrol(key);
    assert.strictEqual((await beat(node, [ENDPOINT_A])).status, 200);

    assert.strictEqual((await admin('post', `/api/nodes/${node}/action`, { action: 'quarantine' })).status, 200);
    assert.strictEqual(await endpointsSeenFor(node), null, 'a quarantined node must not be a peer');

    assert.strictEqual((await admin('post', `/api/nodes/${node}/action`, { action: 'lift_quarantine' })).status, 200);

    // The quarantine revoked the credential, so the node's next heartbeat is refused
    // and it registers again: that is the registration that wiped its endpoints.
    assert.strictEqual((await beat(node, [ENDPOINT_A])).status, 401);
    await enrol(key);

    assert.deepStrictEqual(
      await endpointsSeenFor(node),
      ['10.89.0.12:51820'],
      'after the lift the peers were handed this node without an endpoint'
    );
    assert.strictEqual((await beat(node, [ENDPOINT_A])).status, 200, 'the new credential must work');
  });

  it('validates what a registration reports, as a heartbeat would', async () => {
    // /v4/control/discover hands stored endpoints to other nodes as they are, so an
    // address no peer can dial must never be stored in the first place.
    const key = nodeKey();
    const node = await enrol(key, {
      role: 'RELAY',
      endpoints: [{ ip_address: '127.0.0.1', port: 51820 }, '169.254.1.1:51820', ENDPOINT_B]
    });

    const res = await request(app)
      .post('/v4/control/discover')
      .set('Authorization', `Bearer ${REGISTRATION_TOKEN}`)
      .send({ explicit_host_id: node });
    assert.strictEqual(res.status, 200, `discover: ${res.status} ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.bridges.length, 1);
    assert.deepStrictEqual(res.body.bridges[0].endpoints, [
      { ip_address: '10.89.0.13', port: 51820, protocol: 'udp', is_stun_discovered: false }
    ]);

    // Nothing usable in a later registration is the same as nothing at all.
    await enrol(key, { role: 'RELAY', endpoints: [{ ip_address: '127.0.0.1', port: 51820 }] });
    assert.deepStrictEqual(await endpointsSeenFor(node), ['10.89.0.13:51820']);
  });

  it('tells the peers when a registration moves the node, even right after a heartbeat did', async () => {
    const key = nodeKey();
    const node = await enrol(key);
    // A changed endpoint on the heartbeat moves the version and opens the debounce
    // window that holds back the next heartbeat-reported change.
    assert.strictEqual((await beat(node, [ENDPOINT_A])).status, 200);
    const before = await NetmapService.getVersion();

    await enrol(key, { endpoints: [ENDPOINT_B] });

    assert.ok(
      (await NetmapService.getVersion()) > before,
      'the node moved and the netmap version did not, so no peer re-fetches'
    );
    assert.deepStrictEqual(await endpointsSeenFor(node), ['10.89.0.13:51820']);
  });

  it('does not move the version for a registration that changes nothing', async () => {
    const key = nodeKey();
    const node = await enrol(key);
    assert.strictEqual((await beat(node, [ENDPOINT_A])).status, 200);
    const before = await NetmapService.getVersion();

    await enrol(key, { endpoints: [ENDPOINT_A] });
    await enrol(key);

    assert.strictEqual(await NetmapService.getVersion(), before, 'an unchanged re-registration made the fleet re-fetch');
  });

  it('tells the peers when a node that was marked unhealthy registers again', async () => {
    const key = nodeKey();
    const node = await enrol(key);
    assert.strictEqual((await beat(node, [ENDPOINT_A])).status, 200);

    assert.strictEqual((await admin('put', `/api/nodes/${node}`, { is_healthy: false })).status, 200);
    assert.strictEqual(await endpointsSeenFor(node), null, 'an unhealthy node is not a peer');
    const before = await NetmapService.getVersion();

    // Registration marks the node healthy, which puts it back in every peer set.
    await enrol(key);

    assert.ok((await NetmapService.getVersion()) > before, 'the node is back in the peer sets and nobody was told');
    assert.deepStrictEqual(await endpointsSeenFor(node), ['10.89.0.12:51820']);
  });
});
