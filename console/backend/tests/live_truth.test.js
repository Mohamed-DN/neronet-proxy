// Location, round trip and the connection test tell the truth (ADR 0042, ADR 0042).
//
// Unknown is NULL and nothing invents a place; the only sources are an administrator
// ('declared') and the node operator's explicit setting ('agent'); a ping is a ping from
// the serving gateway with its time, and a timeout is "no reply", never a number.
process.env.SOVEREIGN_NODE_UPDATED_DEBOUNCE_MS = '40';
process.env.SOVEREIGN_PROBE_POLL_HOLD_MS = '1500';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createOrgFixture } = require('./helpers/orgFixture');
const { nodeKey, register } = require('./helpers/nodeEnrolment');
const { createApp } = require('../server');
const NodeLive = require('../services/NodeLive');
const { isVisibleTo } = require('../ws/topologyServer');

const ORG_A = 'org-sec-a';
const ORG_B = 'org-sec-b';
const MIGRATION = path.resolve(__dirname, '../db/migrations/060_live_truth.sql');
const key = () => crypto.randomBytes(32).toString('base64');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Live truth: location, round trip, connection test', () => {
  let db;
  let pool;
  let app;
  let fx;
  let seq = 0;
  const bearer = (t) => ({ Authorization: `Bearer ${t}` });

  async function enrol(org, endpoint = null, capability = {}) {
    const res = await register(app, {
      public_key_hex: nodeKey(),
      role: 'CLIENT_ORIGIN',
      endpoints: [],
      capability: { enabled: false, ...capability }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const id = res.body.assigned_node_id;
    await pool.query(
      `UPDATE nodes SET organization_id = $1, profile_gateway_endpoint = $2::text,
              is_default_profile_gateway = ($2::text IS NOT NULL), last_heartbeat = now() WHERE id = $3`,
      [org, endpoint, id]
    );
    return { id, credential: res.body.credential };
  }

  async function profileDevice(org, owner, { handshakeAgoSeconds = 20, country } = {}) {
    const id = `lt-dev-${++seq}`;
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, preshared_key,
                          role, is_healthy, is_quarantined, device_kind, last_handshake_at, country_code)
       VALUES ($1,$2,$3,$1,$4,$5,$6,$7,'CLIENT_ORIGIN',TRUE,FALSE,'profile',
               CASE WHEN $8::int IS NULL THEN NULL ELSE now() - make_interval(secs => $8::int) END, $9)`,
      [id, org, owner, `100.64.88.${seq}`, `fd00:88::${seq}`, key(), key(), handshakeAgoSeconds, country || null]
    );
    return id;
  }

  const observation = (peerId, over = {}) => ({
    peer_id: peerId,
    last_handshake_unix: Math.floor(Date.now() / 1000) - 5,
    wg_rx_bytes: '1',
    wg_tx_bytes: '1',
    observed_at_unix: 0,
    state: 'profile',
    rtt_ms: null,
    ...over
  });
  const beat = (node, paths) =>
    request(app)
      .post('/v4/control/heartbeat')
      .set(bearer(node.credential))
      .send({ node_id: node.id, peer_paths: paths });
  const apiNode = async (id, token = fx.tokens.ownerA) =>
    (await request(app).get(`/api/nodes/${id}`).set(bearer(token))).body.node;
  const row = async (id) => (await pool.query('SELECT * FROM nodes WHERE id = $1', [id])).rows[0];

  let gwA;
  let gwB;

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    fx = await createOrgFixture(pool);
    gwA = await enrol(ORG_A, '203.0.113.10:51820');
    gwB = await enrol(ORG_B, '203.0.113.20:51820');
  });

  after(async () => {
    NodeLive.reset();
    if (db) await db.cleanup();
    // The topology subscriber opened a Valkey connection; unclosed, the process never exits.
    try {
      await require('../db/valkey').closeValkey();
    } catch {
      // already closed
    }
  });

  describe('A. location: unknown is NULL', () => {
    it('a node that states no country is enrolled with none and no source', async () => {
      const n = await enrol(ORG_A);
      const node = await apiNode(n.id);
      assert.equal(node.country_code, null);
      assert.equal(node.location_source, null);
      assert.equal(node.latitude, null);
    });

    it('the column has no default: a row written without a country has none', async () => {
      const id = await profileDevice(ORG_A, fx.ids.memberA);
      assert.equal((await row(id)).country_code, null);
      assert.equal((await apiNode(id)).country_code, null);
    });

    it('a node created through the API without a country has no country, coordinates or latency', async () => {
      const res = await request(app).post('/api/nodes').set(bearer(fx.tokens.ownerA)).send({ name: 'plain' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.node.country_code, null);
      assert.equal(res.body.node.latitude, null);
      assert.equal(res.body.node.longitude, null);
      assert.equal(res.body.node.latency_ms, null);
    });

    it('a member cannot state a location when creating a device; an administrator can, as declared', async () => {
      const refused = await request(app)
        .post('/api/nodes')
        .set(bearer(fx.tokens.memberA))
        .send({ name: 'm', country_code: 'DE' });
      assert.equal(refused.status, 403);
      const ok = await request(app)
        .post('/api/nodes')
        .set(bearer(fx.tokens.adminA))
        .send({ name: 'a', country_code: 'de' });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.node.country_code, 'DE');
      assert.equal(ok.body.node.location_source, 'declared');
      const bad = await request(app)
        .post('/api/nodes')
        .set(bearer(fx.tokens.adminA))
        .send({ name: 'b', country_code: 'ZZ' });
      assert.equal(bad.status, 400);
    });

    it('an operator who sets a country is recorded as the agent; one who sets none stays unknown', async () => {
      const n = await enrol(ORG_A, null, { country_code: 'it' });
      const node = await apiNode(n.id);
      assert.equal(node.country_code, 'IT');
      assert.equal(node.location_source, 'agent');
    });

    it('a re-registration fills an unknown country but never replaces a stated one, and says so in the audit', async () => {
      const k = nodeKey();
      const first = await register(app, { public_key_hex: k, role: 'CLIENT_ORIGIN', endpoints: [], capability: { enabled: false } });
      const id = first.body.assigned_node_id;
      assert.equal((await row(id)).country_code, null);
      const again = await register(app, {
        public_key_hex: k,
        role: 'CLIENT_ORIGIN',
        endpoints: [],
        capability: { enabled: false, country_code: 'FR' }
      });
      assert.equal(again.status, 200);
      assert.equal((await row(id)).country_code, 'FR');
      assert.equal((await row(id)).location_source, 'agent');
      const audit = async () =>
        (
          await pool.query(
            "SELECT 1 FROM audit_events WHERE event_type = 'node.reregister_mismatch' AND target_id = $1",
            [id]
          )
        ).rowCount;
      assert.equal(await audit(), 0, 'filling an unknown value is not a mismatch');
      await register(app, {
        public_key_hex: k,
        role: 'CLIENT_ORIGIN',
        endpoints: [],
        capability: { enabled: false, country_code: 'JP' }
      });
      assert.equal((await row(id)).country_code, 'FR');
      assert.equal(await audit(), 1);
    });

    it('PUT /location: administrators declare, validate and audit; members and auditors cannot; another organisation sees 404', async () => {
      const id = await profileDevice(ORG_A, fx.ids.memberA);
      const put = (token, body) =>
        request(app).put(`/api/nodes/${id}/location`).set(bearer(token)).send(body);
      assert.equal((await put(fx.tokens.memberA, { country_code: 'IT' })).status, 403);
      assert.equal((await put(fx.tokens.auditorA, { country_code: 'IT' })).status, 403);
      assert.equal((await put(fx.tokens.adminB, { country_code: 'IT' })).status, 404);
      assert.equal((await put(fx.tokens.adminA, { country_code: 'ZZ' })).status, 400);
      assert.equal((await put(fx.tokens.adminA, { country_code: 'Italy' })).status, 400);
      assert.equal((await put(fx.tokens.adminA, {})).status, 400);
      const ok = await put(fx.tokens.adminA, { country_code: 'it' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.node.country_code, 'IT');
      assert.equal(ok.body.node.location_source, 'declared');
      const audit = await pool.query(
        "SELECT metadata FROM audit_events WHERE event_type = 'NODE_LOCATION_SET' AND target_id = $1",
        [id]
      );
      assert.equal(audit.rowCount, 1);
      const cleared = await put(fx.tokens.ownerA, { country_code: null });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.node.country_code, null);
      assert.equal(cleared.body.node.location_source, null);
    });

    it('location is visible to the device owner and the organisation readers, never to others or the unauthenticated', async () => {
      const id = await profileDevice(ORG_A, fx.ids.memberA, { country: 'IT' });
      await pool.query("UPDATE nodes SET location_source = 'declared', city = 'Roma' WHERE id = $1", [id]);
      for (const who of ['memberA', 'ownerA', 'adminA', 'netAdminA', 'auditorA']) {
        assert.equal((await apiNode(id, fx.tokens[who])).country_code, 'IT', who);
      }
      for (const who of ['member2A', 'adminB', 'memberB']) {
        const res = await request(app).get(`/api/nodes/${id}`).set(bearer(fx.tokens[who]));
        assert.equal(res.status, 404, who);
      }
      const list = await request(app).get('/api/nodes').set(bearer(fx.tokens.member2A));
      assert.ok(!JSON.stringify(list.body).includes(id), 'a colleague member must not list it');
      assert.equal((await request(app).get(`/api/nodes/${id}`)).status, 401);
      assert.equal((await request(app).get('/api/nodes')).status, 401);
      const metrics = await request(app).get('/metrics');
      assert.ok(!/country|city|Roma|203\.0\.113/i.test(metrics.text), 'metrics carry no location');
    });

    it('the geography views put every unknown device in one "unknown" group and never an empty one', async () => {
      await pool.query("UPDATE nodes SET country_code = NULL WHERE organization_id = $1", [ORG_A]);
      await pool.query("UPDATE nodes SET country_code = 'IT' WHERE id = $1", [gwA.id]);
      const geo = await request(app).get('/api/stats/geo').set(bearer(fx.tokens.ownerA));
      assert.equal(geo.status, 200);
      const unknown = geo.body.filter((g) => g.unknown);
      assert.equal(unknown.length, 1);
      assert.equal(unknown[0].code, null);
      assert.equal(unknown[0].country, null);
      assert.ok(geo.body.every((g) => g.unknown || /^[A-Z]{2}$/.test(g.code)));
      const overview = await request(app).get('/api/stats/overview').set(bearer(fx.tokens.ownerA));
      assert.ok(overview.body.country_distribution.unknown > 0);
      assert.ok(!('null' in overview.body.country_distribution) && !('' in overview.body.country_distribution));
      const topo = await request(app).get('/api/stats/topology').set(bearer(fx.tokens.ownerA));
      assert.ok(topo.body.nodes.every((n) => n.country === null || /^[A-Z]{2}$/.test(n.country)));
    });

    it('migration 060 clears only what a default wrote, keeps what was stated, and is idempotent', async () => {
      const sql = fs.readFileSync(MIGRATION, 'utf8');
      const put = async (id, { kind = 'mesh', country, lat = null, lon = null, source = null, meta = '{}' }) =>
        pool.query(
          `INSERT INTO nodes (id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6, device_kind,
                              country_code, latitude, longitude, location_source, metadata)
           VALUES ($1, $2, $3, $1, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
          [id, fx.ids.memberA, ORG_A, key(), `100.64.99.${++seq % 250}`, `fd00:99::${seq}`, kind, country, lat, lon, source, meta]
        );
      await put('mig-profile-default', { kind: 'profile', country: 'US' });
      await put('mig-profile-declared', { kind: 'profile', country: 'US', source: 'declared' });
      await put('pk_mig0000000000a1', { country: 'US' });
      await put('pk_mig0000000000a2', { country: 'IT' });
      await put('pk_mig0000000000a3', { country: 'US', meta: '{"location_source":"declared"}', lat: 40.7, lon: -74.0 });
      await put('mig-wash', { country: 'US', lat: 38.9072, lon: -77.0369 });
      await put('mig-frank', { country: 'IT', lat: 50.1109, lon: 8.6821 });
      await put('mig-real-coords', { country: 'IT', lat: 41.9, lon: 12.5, source: 'declared' });
      await pool.query(sql);
      const get = async (id) => row(id);
      assert.equal((await get('mig-profile-default')).country_code, null);
      assert.equal((await get('mig-profile-declared')).country_code, 'US');
      assert.equal((await get('pk_mig0000000000a1')).country_code, null);
      assert.equal((await get('pk_mig0000000000a2')).country_code, 'IT');
      assert.equal((await get('pk_mig0000000000a2')).location_source, 'agent');
      const declaredAgent = await get('pk_mig0000000000a3');
      assert.equal(declaredAgent.country_code, 'US');
      assert.equal(declaredAgent.location_source, 'agent');
      const wash = await get('mig-wash');
      assert.deepEqual([wash.country_code, wash.latitude, wash.longitude], [null, null, null]);
      const frank = await get('mig-frank');
      assert.deepEqual([frank.country_code, frank.latitude, frank.longitude], ['IT', null, null]);
      const real = await get('mig-real-coords');
      assert.equal(real.country_code, 'IT');
      assert.ok(Math.abs(real.latitude - 41.9) < 0.001);
      const before = (await pool.query('SELECT id, country_code, latitude, location_source FROM nodes ORDER BY id')).rows;
      await pool.query(sql);
      const after = (await pool.query('SELECT id, country_code, latitude, location_source FROM nodes ORDER BY id')).rows;
      assert.deepEqual(after, before);
      await assert.rejects(pool.query("UPDATE nodes SET country_code = 'it' WHERE id = 'mig-frank'"), /nodes_country_code_iso/);
    });
  });

  describe('A. scope: discover and circuit', () => {
    it('the fleet token does not enumerate other organisations: country, city and endpoints stay home', async () => {
      const previous = process.env.SOVEREIGN_REGISTRATION_TOKEN;
      process.env.SOVEREIGN_REGISTRATION_TOKEN = 'live-truth-fleet-token';
      try {
        const rel = await enrol(ORG_B);
        await pool.query(
          `UPDATE nodes SET role = 'RELAY', country_code = 'SE', city = 'Malmo', last_heartbeat = now(),
                  endpoints = '["198.51.100.9:51820"]'::jsonb WHERE id = $1`,
          [rel.id]
        );
        const res = await request(app)
          .post('/v4/control/discover')
          .set('Authorization', 'Bearer live-truth-fleet-token')
          .send({ limit: 100 });
        assert.equal(res.status, 200);
        assert.ok(!res.body.bridges.some((b) => b.node_id === rel.id), 'another organisation was enumerated');
        assert.ok(!JSON.stringify(res.body).includes('Malmo'));
        const filtered = await request(app)
          .post('/v4/control/discover')
          .set('Authorization', 'Bearer live-truth-fleet-token')
          .send({ target_country: 'SE', explicit_host_id: rel.id });
        assert.deepEqual(filtered.body.bridges, []);
      } finally {
        if (previous === undefined) delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
        else process.env.SOVEREIGN_REGISTRATION_TOKEN = previous;
      }
    });

    it('a relay with an unknown country is offered with an empty country and never matches a country filter', async () => {
      const rel = await enrol(ORG_A);
      await pool.query("UPDATE nodes SET role = 'RELAY', country_code = NULL, last_heartbeat = now() WHERE id = $1", [
        rel.id
      ]);
      const asker = await enrol(ORG_A);
      await pool.query("UPDATE organizations SET default_policy = 'open' WHERE id = $1", [ORG_A]);
      const all = await request(app)
        .post('/v4/control/discover')
        .set(bearer(asker.credential))
        .send({ limit: 100 });
      const found = all.body.bridges.find((b) => b.node_id === rel.id);
      assert.ok(found, JSON.stringify(all.body));
      assert.equal(found.capability.country_code, '');
      const us = await request(app)
        .post('/v4/control/discover')
        .set(bearer(asker.credential))
        .send({ target_country: 'US' });
      assert.ok(!us.body.bridges.some((b) => b.node_id === rel.id));
    });

    it('a circuit that requires a country never takes an exit whose country is unknown', async () => {
      const { buildCircuit } = require('../modules/onion/CircuitEngine');
      const org = 'org-circuit-unknown';
      await pool.query("INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1,$1,$1,'open')", [org]);
      for (let i = 0; i < 3; i += 1) {
        await pool.query(
          `INSERT INTO nodes (id, user_id, organization_id, name, public_key, overlay_ipv4, overlay_ipv6, role, is_healthy, country_code)
           VALUES ($1,$2,$3,$1,$4,$5,$6,'EXIT_BRIDGE',TRUE,NULL)`,
          [`circ-${i}`, fx.ids.ownerA, org, nodeKey(), `100.64.66.${i + 1}`, `fd00:66::${i + 1}`]
        );
      }
      await assert.rejects(buildCircuit({ organizationId: org, targetCountry: 'US' }), /no healthy exit bridge available in US/);
      const free = await buildCircuit({ organizationId: org });
      assert.equal(free.hops.length, 3, 'with no country required, the circuit is still built');
    });
  });

  describe('B. round trip: a ping from the serving gateway', () => {
    it('stores the value, the time of the sample and the method', async () => {
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      const at = Math.floor(Date.now() / 1000) - 2;
      const res = await beat(gwA, [observation(dev, { rtt_ms: 12.5, rtt_observed_at_unix: at })]);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const node = await apiNode(dev);
      assert.equal(node.rtt_ms, 12.5);
      assert.equal(node.rtt_measured_at, new Date(at * 1000).toISOString());
      assert.equal(node.rtt_method, 'icmp');
      assert.equal(node.latency_ms, null, 'the console link figure is not the device response time');
    });

    it('a timeout is "no reply" with its time: the value is null, the device is not turned offline', async () => {
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      const t1 = Math.floor(Date.now() / 1000) - 20;
      await beat(gwA, [observation(dev, { rtt_ms: 9, rtt_observed_at_unix: t1 })]);
      const t2 = t1 + 15;
      await beat(gwA, [observation(dev, { rtt_ms: null, rtt_observed_at_unix: t2 })]);
      const node = await apiNode(dev);
      assert.equal(node.rtt_ms, null);
      assert.equal(node.rtt_measured_at, new Date(t2 * 1000).toISOString());
      assert.equal(node.handshake_status, 'connected');
    });

    it('an older sample never replaces a newer one, and a sample from the future or from long ago is ignored', async () => {
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      const now = Math.floor(Date.now() / 1000);
      await beat(gwA, [observation(dev, { rtt_ms: 5, rtt_observed_at_unix: now - 1 })]);
      await beat(gwA, [observation(dev, { rtt_ms: 99, rtt_observed_at_unix: now - 10 })]);
      assert.equal((await apiNode(dev)).rtt_ms, 5);
      await beat(gwA, [observation(dev, { rtt_ms: 1, rtt_observed_at_unix: now + 3600 })]);
      await beat(gwA, [observation(dev, { rtt_ms: 2, rtt_observed_at_unix: now - 7200 })]);
      assert.equal((await apiNode(dev)).rtt_ms, 5);
    });

    it("only the device's own gateway is believed, and a mesh node's row never takes a gateway's sample", async () => {
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      const at = Math.floor(Date.now() / 1000) - 1;
      await beat(gwB, [observation(dev, { rtt_ms: 3, rtt_observed_at_unix: at })]);
      assert.equal((await row(dev)).rtt_ms, null);
      await beat(gwA, [observation(gwB.id, { rtt_ms: 3, rtt_observed_at_unix: at })]);
      assert.equal((await row(gwB.id)).rtt_ms, null);
    });

    it('the heartbeat value keeps its own name: console_link_ms equals latency_ms for a node that beats', async () => {
      const n = await enrol(ORG_A);
      await request(app)
        .post('/v4/control/heartbeat')
        .set(bearer(n.credential))
        .send({ node_id: n.id, rtt_ms: 31 });
      await sleep(50);
      await pool.query('UPDATE nodes SET latency_ms = 31 WHERE id = $1', [n.id]);
      const node = await apiNode(n.id);
      assert.equal(node.console_link_ms, 31);
      assert.equal(node.rtt_ms, null);
    });
  });

  describe('C. connection test', () => {
    const ask = (token, id) => request(app).post(`/api/nodes/${id}/probe`).set(bearer(token));
    const read = (token, id, rid) => request(app).get(`/api/nodes/${id}/probe/${rid}`).set(bearer(token));
    const poll = (gw) => request(app).post('/v4/control/probe/poll').set(bearer(gw.credential)).send({});
    const answer = (gw, body) =>
      request(app).post('/v4/control/probe/result').set(bearer(gw.credential)).send(body);
    const settle = () => pool.query("UPDATE probe_requests SET created_at = created_at - interval '10 seconds'");

    it('request, delivery to the serving gateway, ping, answer: replied in X ms, within a poll step', async () => {
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      const waiting = poll(gwA).then((r) => r);
      await sleep(300);
      const t0 = Date.now();
      const created = await ask(fx.tokens.memberA, dev);
      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.equal(created.body.state, 'pending');
      const again = await ask(fx.tokens.memberA, dev);
      assert.equal(again.body.request_id, created.body.request_id, 'one live probe per device');
      const delivered = await waiting;
      assert.equal(delivered.status, 200);
      assert.deepEqual(delivered.body.requests, [{ request_id: created.body.request_id, peer_id: dev }]);
      assert.ok(Date.now() - t0 < 1500, 'delivered in well under the five seconds the button promises');
      assert.equal((await read(fx.tokens.memberA, dev, created.body.request_id)).body.state, 'measuring');
      assert.equal((await answer(gwA, { request_id: created.body.request_id, replied: true, rtt_ms: 4.25 })).status, 200);
      const done = await read(fx.tokens.memberA, dev, created.body.request_id);
      assert.equal(done.body.state, 'replied');
      assert.equal(done.body.rtt_ms, 4.25);
      assert.equal(done.body.method, 'icmp');
      assert.ok(done.body.answered_at);
      assert.equal((await apiNode(dev)).rtt_ms, 4.25);
      assert.equal((await ask(fx.tokens.memberA, dev)).status, 429, 'rate limited right after');
    });

    it('no reply is "no_reply" with the device still connected, and no number', async () => {
      await settle();
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      const created = await ask(fx.tokens.ownerA, dev);
      assert.equal(created.status, 202);
      await poll(gwA);
      await answer(gwA, { request_id: created.body.request_id, replied: false });
      const done = await read(fx.tokens.ownerA, dev, created.body.request_id);
      assert.equal(done.body.state, 'no_reply');
      assert.equal(done.body.rtt_ms, null);
      assert.ok(done.body.last_contact_at);
      assert.equal((await row(dev)).rtt_ms, null);
      assert.ok((await row(dev)).rtt_measured_at);
    });

    it('a device with no recent handshake is not_connected at once; a silent gateway is gateway_unreachable', async () => {
      await settle();
      const stale = await profileDevice(ORG_A, fx.ids.memberA, { handshakeAgoSeconds: 900 });
      const res = await ask(fx.tokens.ownerA, stale);
      assert.equal(res.status, 200);
      assert.equal(res.body.state, 'not_connected');
      assert.equal((await pool.query('SELECT 1 FROM probe_requests WHERE device_id = $1', [stale])).rowCount, 0);

      await settle();
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      await pool.query("UPDATE nodes SET last_heartbeat = now() - interval '10 minutes' WHERE id = $1", [gwA.id]);
      const unreachable = await ask(fx.tokens.ownerA, dev);
      assert.equal(unreachable.body.state, 'gateway_unreachable');
      await pool.query('UPDATE nodes SET last_heartbeat = now() WHERE id = $1', [gwA.id]);
    });

    it('a request expires after 30 seconds, is then gateway_unreachable, and a late answer is refused', async () => {
      await settle();
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      const created = await ask(fx.tokens.ownerA, dev);
      await pool.query("UPDATE probe_requests SET expires_at = now() - interval '1 second' WHERE id = $1", [
        created.body.request_id
      ]);
      assert.equal((await read(fx.tokens.ownerA, dev, created.body.request_id)).body.state, 'gateway_unreachable');
      const late = await answer(gwA, { request_id: created.body.request_id, replied: true, rtt_ms: 1 });
      assert.equal(late.status, 409);
      assert.equal((await row(dev)).rtt_ms, null, 'a late answer stores nothing');
    });

    it('only the serving gateway collects or answers a request', async () => {
      await settle();
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      const created = await ask(fx.tokens.ownerA, dev);
      const other = await poll(gwB);
      assert.deepEqual(other.body.requests, []);
      const forged = await answer(gwB, { request_id: created.body.request_id, replied: true, rtt_ms: 1 });
      assert.equal(forged.status, 409);
      assert.equal((await answer(gwA, { request_id: created.body.request_id, replied: true, rtt_ms: -4 })).status, 400);
      assert.equal((await answer(gwA, { request_id: created.body.request_id, replied: true, rtt_ms: 99999 })).status, 400);
    });

    it('roles: the device owner or an administrator; not a colleague, an auditor, another organisation or nobody', async () => {
      await settle();
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      assert.equal((await ask(fx.tokens.member2A, dev)).status, 404);
      assert.equal((await ask(fx.tokens.auditorA, dev)).status, 403);
      assert.equal((await ask(fx.tokens.adminB, dev)).status, 404);
      assert.equal((await request(app).post(`/api/nodes/${dev}/probe`)).status, 401);
      const ok = await ask(fx.tokens.netAdminA, dev);
      assert.equal(ok.status, 202);
      assert.equal((await read(fx.tokens.member2A, dev, ok.body.request_id)).status, 404);
      assert.equal((await request(app).post('/v4/control/probe/poll').send({})).status, 401);
    });

    it('the old ping action no longer answers with a stored number: it starts a real probe', async () => {
      await settle();
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      await pool.query('UPDATE nodes SET rtt_ms = 7, rtt_measured_at = now() - interval \'1 hour\' WHERE id = $1', [dev]);
      const res = await request(app)
        .post(`/api/nodes/${dev}/action`)
        .set(bearer(fx.tokens.ownerA))
        .send({ action: 'ping' });
      assert.equal(res.body.result.state, 'pending');
      assert.equal(res.body.result.rtt_ms, undefined);
    });
  });

  describe('D. live: node:updated', () => {
    it('is debounced per device, names the device and nothing else about it', async () => {
      const seen = [];
      NodeLive.setPublisher(async (id) => seen.push(id));
      try {
        const dev = await profileDevice(ORG_A, fx.ids.memberA, { handshakeAgoSeconds: 600 });
        const base = Math.floor(Date.now() / 1000) - 10;
        for (let i = 0; i < 5; i += 1) await beat(gwA, [observation(dev, { last_handshake_unix: base + i })]);
        await sleep(150);
        assert.deepEqual(seen, [dev], 'five reports, one event');
        await beat(gwA, [observation(dev, { last_handshake_unix: base + 9 })]);
        await sleep(150);
        assert.deepEqual(seen, [dev, dev]);
        await beat(gwA, [observation(dev, { last_handshake_unix: base + 2 })]);
        await sleep(150);
        assert.equal(seen.length, 2, 'a report that changes nothing announces nothing');
      } finally {
        NodeLive.setPublisher(null);
      }
    });

    it('the published event carries the id, organisation and owner, and reaches only that organisation', async () => {
      const { subscribeTopologyEvents } = require('../db/valkey');
      const events = [];
      subscribeTopologyEvents((e) => events.push(e));
      const dev = await profileDevice(ORG_A, fx.ids.memberA);
      NodeLive.notifyNodeUpdated(dev, { immediate: true });
      await sleep(200);
      const event = events.find((e) => e.event === 'node:updated' && e.node_id === dev);
      assert.ok(event, 'no node:updated published');
      assert.deepEqual(Object.keys(event.node).sort(), ['id', 'organization_id', 'user_id']);
      const as = (id, org, orgRole) => ({ id, role: 'user', organization_id: org, org_role: orgRole });
      assert.equal(isVisibleTo(as(fx.ids.memberA, ORG_A, 'member'), event), true);
      assert.equal(isVisibleTo(as(fx.ids.adminA, ORG_A, 'admin'), event), true);
      assert.equal(isVisibleTo(as(fx.ids.member2A, ORG_A, 'member'), event), false);
      assert.equal(isVisibleTo(as(fx.ids.adminB, ORG_B, 'admin'), event), false);
    });
  });
});
