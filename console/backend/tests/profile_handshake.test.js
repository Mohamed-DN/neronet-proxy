// A phone or laptop on the stock WireGuard app (ADR 0029) never heartbeats. The only
// evidence that it is connected is its last handshake with the organisation's profile
// gateway, which the gateway reports in peer_paths on its own authenticated heartbeat.
// The control plane stores it only when that device's own gateway says so.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { nodeKey, register } = require('./helpers/nodeEnrolment');
const { createApp } = require('../server');
const ProfileHandshake = require('../services/ProfileHandshake');

const ORG_A = 'org-hs-a';
const ORG_B = 'org-hs-b';
const key = () => crypto.randomBytes(32).toString('base64');

describe('profile device handshakes reported by the gateway', () => {
  let db;
  let pool;
  let app;
  let admin;
  let gatewayA;
  let otherA;
  let gatewayB;
  let seq = 0;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  async function enrol(org, endpoint = null) {
    const res = await register(app, { public_key_hex: nodeKey(), role: 'CLIENT_ORIGIN', endpoints: [] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const id = res.body.assigned_node_id;
    await pool.query('UPDATE nodes SET organization_id = $1, profile_gateway_endpoint = $2 WHERE id = $3', [
      org,
      endpoint,
      id
    ]);
    return { id, credential: res.body.credential };
  }

  async function profileDevice(org, name) {
    const id = `hs-dev-${++seq}`;
    const { rows } = await pool.query("SELECT id FROM users WHERE role = 'super-admin' LIMIT 1");
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, preshared_key,
                          role, is_healthy, is_quarantined, device_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CLIENT_ORIGIN',TRUE,FALSE,'profile')`,
      [id, org, rows[0].id, name, `100.64.77.${seq}`, `fd00:77::${seq}`, key(), key()]
    );
    return id;
  }

  const observation = (peerId, handshakeUnix, state = 'profile') => ({
    peer_id: peerId,
    last_handshake_unix: handshakeUnix,
    wg_rx_bytes: '4096',
    wg_tx_bytes: '8192',
    observed_at_unix: 0,
    state,
    rtt_ms: null
  });

  const beat = (node, paths) =>
    request(app).post('/v4/control/heartbeat').set(auth(node.credential)).send({ node_id: node.id, peer_paths: paths });

  async function stored(id) {
    const { rows } = await pool.query('SELECT last_handshake_at FROM nodes WHERE id = $1', [id]);
    return rows[0].last_handshake_at;
  }

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    for (const [o, slug] of [
      [ORG_A, 'hs-a'],
      [ORG_B, 'hs-b']
    ]) {
      await pool.query(
        `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, $2, $2, 'deny') ON CONFLICT (id) DO NOTHING`,
        [o, slug]
      );
    }
    const { rows } = await pool.query("SELECT id FROM users WHERE role='super-admin' LIMIT 1");
    admin = await issueConsoleTestToken({ id: rows[0].id, sub: rows[0].id, role: 'super-admin' });
    gatewayA = await enrol(ORG_A, '203.0.113.10:51820');
    otherA = await enrol(ORG_A);
    gatewayB = await enrol(ORG_B, '203.0.113.20:51820');
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it("stores a profile device's handshake reported by its own organisation's gateway", async () => {
    const phone = await profileDevice(ORG_A, 'phone');
    const at = Math.floor(Date.now() / 1000) - 30;
    assert.equal((await beat(gatewayA, [observation(phone, at)])).status, 200);
    assert.equal(new Date(await stored(phone)).getTime(), at * 1000);

    const res = await request(app).get(`/api/nodes/${phone}`).set(auth(admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.node.last_handshake_at, new Date(at * 1000).toISOString());
    assert.equal(res.body.node.handshake_status, 'connected');
  });

  it('accepts the report whatever state an older gateway labels it with', async () => {
    const phone = await profileDevice(ORG_A, 'older-gateway-phone');
    const at = Math.floor(Date.now() / 1000) - 5;
    assert.equal((await beat(gatewayA, [observation(phone, at, 'no_path')])).status, 200);
    assert.equal(new Date(await stored(phone)).getTime(), at * 1000);
  });

  it("refuses another organisation's gateway: the claim is never stored", async () => {
    const phone = await profileDevice(ORG_A, 'cross-org-phone');
    const res = await beat(gatewayB, [observation(phone, Math.floor(Date.now() / 1000))]);
    assert.equal(res.status, 200, 'the beat itself is never refused for a report');
    assert.equal(await stored(phone), null);
  });

  it('refuses a node of the same organisation that is not its profile gateway', async () => {
    const phone = await profileDevice(ORG_A, 'not-the-gateway-phone');
    assert.equal((await beat(otherA, [observation(phone, Math.floor(Date.now() / 1000))])).status, 200);
    assert.equal(await stored(phone), null);
  });

  it('never stores a handshake on a mesh node, which reports for itself', async () => {
    assert.equal((await beat(gatewayA, [observation(otherA.id, Math.floor(Date.now() / 1000))])).status, 200);
    assert.equal(await stored(otherA.id), null);
  });

  it('refuses a beat whose credential belongs to another node', async () => {
    const phone = await profileDevice(ORG_A, 'spoofed-phone');
    const res = await request(app)
      .post('/v4/control/heartbeat')
      .set(auth(otherA.credential))
      .send({ node_id: gatewayA.id, peer_paths: [observation(phone, Math.floor(Date.now() / 1000))] });
    assert.equal(res.status, 403);
    assert.equal(await stored(phone), null);
  });

  it('never moves a handshake backwards and never into the future', async () => {
    const phone = await profileDevice(ORG_A, 'clock-phone');
    const now = Math.floor(Date.now() / 1000);
    await beat(gatewayA, [observation(phone, now - 10)]);
    await beat(gatewayA, [observation(phone, now - 300)]);
    assert.equal(new Date(await stored(phone)).getTime(), (now - 10) * 1000);
    await beat(gatewayA, [observation(phone, now + 3600)]);
    assert.ok(new Date(await stored(phone)).getTime() <= Date.now() + 1000, 'a future handshake was stored');
  });

  it('a gateway that is quarantined is not believed', async () => {
    const phone = await profileDevice(ORG_A, 'quarantined-gw-phone');
    await pool.query('UPDATE nodes SET is_quarantined = TRUE WHERE id = $1', [gatewayA.id]);
    try {
      await beat(gatewayA, [observation(phone, Math.floor(Date.now() / 1000))]);
      assert.equal(await stored(phone), null);
    } finally {
      await pool.query('UPDATE nodes SET is_quarantined = FALSE WHERE id = $1', [gatewayA.id]);
    }
  });

  it('reports not connected after the window and not measured when never heard', async () => {
    const stale = await profileDevice(ORG_A, 'stale-phone');
    const never = await profileDevice(ORG_A, 'never-phone');
    const at = Math.floor(Date.now() / 1000) - 240;
    await beat(gatewayA, [observation(stale, at)]);
    const s = await request(app).get(`/api/nodes/${stale}`).set(auth(admin));
    assert.equal(s.body.node.handshake_status, 'not_connected');
    assert.equal(s.body.node.last_handshake_at, new Date(at * 1000).toISOString());
    const n = await request(app).get(`/api/nodes/${never}`).set(auth(admin));
    assert.equal(n.body.node.handshake_status, 'not_measured');
    assert.equal(n.body.node.last_handshake_at, null);
    const mesh = await request(app).get(`/api/nodes/${gatewayA.id}`).set(auth(admin));
    assert.equal(mesh.body.node.handshake_status, null, 'a mesh node is judged by its own heartbeat');
    assert.equal(mesh.body.node.is_profile_gateway, true);
  });

  it('the topology reports a profile device as last seen at its handshake', async () => {
    const phone = await profileDevice(ORG_A, 'map-phone');
    const at = Math.floor(Date.now() / 1000) - 20;
    await beat(gatewayA, [observation(phone, at)]);
    const res = await request(app).get(`/api/stats/topology?org_id=${ORG_A}`).set(auth(admin));
    assert.equal(res.status, 200);
    const node = res.body.nodes.find((n) => n.id === phone);
    assert.equal(node.last_seen_at, new Date(at * 1000).toISOString());
    assert.equal(node.handshake_status, 'connected');
  });
});

describe('the profile device reachability rule', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  it('is connected within three minutes of the last handshake', () => {
    assert.equal(ProfileHandshake.status(new Date(now - 179_000), now), 'connected');
  });
  it('is not connected past three minutes', () => {
    assert.equal(ProfileHandshake.status(new Date(now - 181_000), now), 'not_connected');
  });
  it('is not measured when the gateway never reported one', () => {
    assert.equal(ProfileHandshake.status(null, now), 'not_measured');
  });
  it('takes a test-only window from the environment', () => {
    process.env.SOVEREIGN_PROFILE_HANDSHAKE_WINDOW_SECONDS = '30';
    try {
      assert.equal(ProfileHandshake.status(new Date(now - 31_000), now), 'not_connected');
    } finally {
      delete process.env.SOVEREIGN_PROFILE_HANDSHAKE_WINDOW_SECONDS;
    }
  });
});

describe('removing the profile gateway', () => {
  let db;
  let pool;
  let app;
  let admin;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'gw-del', 'gw-del', 'deny') ON CONFLICT (id) DO NOTHING`,
      ['org-gw-del']
    );
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-gw-del', 'gwdel', 'gwdel@x.local', 'x', 'admin', 'org-gw-del') ON CONFLICT (id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES ('mem-gw-del', 'usr-gw-del', 'org-gw-del', 'admin')
       ON CONFLICT (id) DO NOTHING`
    );
    let n = 0;
    for (const [id, endpoint] of [
      ['gw-del-gateway', '203.0.113.30:51820'],
      ['gw-del-laptop', null]
    ]) {
      n += 1;
      await pool.query(
        `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role,
                            is_healthy, is_quarantined, device_kind, profile_gateway_endpoint)
         VALUES ($1,'org-gw-del','usr-gw-del',$1,$2,$3,$4,'CLIENT_ORIGIN',TRUE,FALSE,'mesh',$5)`,
        [id, `100.64.78.${n}`, `fd00:78::${n}`, key(), endpoint]
      );
    }
    admin = await issueConsoleTestToken({
      id: 'usr-gw-del',
      sub: 'usr-gw-del',
      username: 'gwdel',
      role: 'admin',
      organization_id: 'org-gw-del'
    });
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('refuses to delete the node that serves the profile devices, and says why', async () => {
    const res = await request(app).delete('/api/nodes/gw-del-gateway').set(auth(admin));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'profile_gateway_in_use');
    assert.match(res.body.error, /profile/i);
    const { rows } = await pool.query("SELECT id FROM nodes WHERE id = 'gw-del-gateway'");
    assert.equal(rows.length, 1);
  });

  it('refuses to revoke it too', async () => {
    const res = await request(app).post('/api/nodes/gw-del-gateway/revoke').set(auth(admin)).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'profile_gateway_in_use');
  });

  it('still deletes an ordinary node', async () => {
    const res = await request(app).delete('/api/nodes/gw-del-laptop').set(auth(admin));
    assert.equal(res.status, 200);
  });
});
