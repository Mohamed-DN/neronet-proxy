const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');

const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const AclEngine = require('../services/AclEngine');
const NetmapService = require('../services/NetmapService');
const RevocationEngine = require('../services/RevocationEngine');
const { nodeKey, register } = require('./helpers/nodeEnrolment');

/**
 * The netmap is what decides which node can reach which. Everything here executes the
 * endpoint over a real database: register real nodes, write real rules through the
 * service the API uses, ask for the document over HTTP, and assert on what came back.
 *
 * Two properties are attacked rather than merely checked:
 *
 *   - a node must never learn of a peer its policy denies -- not as an entry, not as a
 *     key, not as an endpoint anywhere in the response body;
 *   - a quarantined or revoked node must be gone from every peer set, and the version
 *     must move so the fleet finds out.
 */

const AUTH = { Authorization: `Bearer ${REGISTRATION_TOKEN}` };

function registerBody(publicKeyHex, overrides = {}) {
  return {
    public_key_hex: publicKeyHex,
    role: 'CLIENT_ORIGIN',
    endpoints: [],
    capability: { country_code: 'IT' },
    ...overrides
  };
}

// Each node asks for its own netmap with the credential registration gave it; the
// fleet token names no node and is refused.
const credentials = new Map();
const nodeAuth = (nodeId) => ({ Authorization: `Bearer ${credentials.get(nodeId)}` });

async function registerNode(app, keyHex) {
  const res = await register(app, registerBody(keyHex), { token: REGISTRATION_TOKEN });
  assert.strictEqual(res.status, 200, `registration failed: ${JSON.stringify(res.body)}`);
  credentials.set(res.body.assigned_node_id, res.body.credential);
  return { id: res.body.assigned_node_id, key: keyHex, vip: res.body.overlay_ipv4, vip6: res.body.overlay_ipv6 };
}

async function fetchNetmap(app, nodeId, version = 0) {
  const res = await request(app).post('/v4/control/netmap').set(nodeAuth(nodeId)).send({ node_id: nodeId, version });
  return res;
}

function peerIds(body) {
  return body.peers.map((p) => p.node_id).sort();
}

/** Every rule row the database currently holds, removed. */
async function clearRules() {
  for (const rule of await AclEngine.listRules()) {
    await AclEngine.deleteRule(rule.id);
  }
}

describe('Netmap delivery', () => {
  let app;
  let dbHelper;
  let alpha;
  let beta;
  let gamma;

  before(async () => {
    dbHelper = await setupTestDatabase();
    await dbHelper.pool.query("DELETE FROM nodes WHERE id LIKE 'svrn-node-seed%'");
    app = createApp();

    alpha = await registerNode(app, nodeKey());
    beta = await registerNode(app, nodeKey());
    gamma = await registerNode(app, nodeKey());
  });

  after(async () => {
    if (dbHelper) {
      await dbHelper.cleanup();
    }
  });

  beforeEach(async () => {
    await clearRules();
    await dbHelper.pool.query(
      'UPDATE nodes SET is_quarantined = false, is_healthy = true, endpoints = $1, endpoints_bumped_at = NULL',
      ['[]']
    );
    await dbHelper.pool.query('DELETE FROM revoked_keys');
    await AclEngine.bumpNetmap();
  });

  it('refuses a caller with no credential', async () => {
    const res = await request(app).post('/v4/control/netmap').send({ node_id: alpha.id, version: 0 });
    assert.strictEqual(res.status, 401);
    assert.ok(!('peers' in res.body), 'an unauthenticated caller must not receive a peer set');
  });

  it('refuses the fleet token, which names no node', async () => {
    const res = await request(app).post('/v4/control/netmap').set(AUTH).send({ node_id: alpha.id, version: 0 });
    assert.strictEqual(res.status, 401);
    assert.ok(!('peers' in res.body));
  });

  it("refuses one node's credential for another node's netmap", async () => {
    const res = await request(app)
      .post('/v4/control/netmap')
      .set(nodeAuth(beta.id))
      .send({ node_id: alpha.id, version: 0 });
    assert.strictEqual(res.status, 403);
    assert.ok(!('peers' in res.body));
  });

  it('carries this node addresses, its MTU and its listen port', async () => {
    const res = await fetchNetmap(app, alpha.id);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.unchanged, false);
    assert.strictEqual(res.body.self.overlay_ipv4, alpha.vip);
    assert.strictEqual(res.body.self.overlay_ipv6, alpha.vip6);
    assert.strictEqual(res.body.self.mtu, NetmapService.OVERLAY_MTU);
    assert.strictEqual(res.body.self.listen_port, NetmapService.LISTEN_PORT);
    assert.strictEqual(res.body.max_staleness_seconds, NetmapService.MAX_STALENESS_SECONDS);
    assert.ok(Number.isInteger(res.body.generated_at_unix));
  });

  it('lists every other node when no rule is written, with its key and overlay prefixes', async () => {
    const res = await fetchNetmap(app, alpha.id);
    assert.deepStrictEqual(peerIds(res.body), [beta.id, gamma.id].sort());

    const peerBeta = res.body.peers.find((p) => p.node_id === beta.id);
    assert.strictEqual(peerBeta.public_key_hex, beta.key);
    assert.deepStrictEqual(peerBeta.allowed_ips, [`${beta.vip}/32`, `${beta.vip6}/128`]);
    assert.strictEqual(peerBeta.keepalive_seconds, NetmapService.KEEPALIVE_SECONDS);
    // Nothing records a DERP region for a node. Null says so.
    assert.strictEqual(peerBeta.derp_region, null);
  });

  it('never names a node in its own peer set', async () => {
    for (const node of [alpha, beta, gamma]) {
      const res = await fetchNetmap(app, node.id);
      assert.ok(!peerIds(res.body).includes(node.id), `${node.id} appears in its own netmap`);
    }
  });

  it('answers unchanged, and nothing else, when the node already holds the version', async () => {
    const version = await NetmapService.getVersion();
    const res = await fetchNetmap(app, alpha.id, version);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.unchanged, true);
    assert.strictEqual(res.body.version, version);
    for (const field of ['peers', 'self', 'acl', 'routes', 'revoked_keys']) {
      assert.ok(!(field in res.body), `an unchanged answer must not carry ${field}`);
    }
  });

  it('returns identical bytes for two identical requests', async () => {
    const first = await fetchNetmap(app, alpha.id);
    const second = await fetchNetmap(app, alpha.id);

    // generated_at_unix is the wall clock and is expected to move; everything else
    // is compared as the serialised bytes, so a re-ordered array fails here.
    const strip = (body) => {
      const copy = { ...body };
      delete copy.generated_at_unix;
      return JSON.stringify(copy);
    };

    assert.strictEqual(strip(first.body), strip(second.body));
  });

  describe('a denied pair', () => {
    beforeEach(async () => {
      // The pair denied on top of an explicit allow-all: once an ACCEPT rule exists the
      // rules alone decide, so this is the allow-list form of the same cut. The form
      // without the allow-all is covered by "an open organisation whose rules only drop".
      await AclEngine.createRule({
        priority: 10,
        source_cidr: alpha.vip,
        destination_cidr: beta.vip,
        action: 'DROP',
        description: 'alpha may not reach beta'
      });
      await AclEngine.createRule({
        priority: 20,
        source_cidr: beta.vip,
        destination_cidr: alpha.vip,
        action: 'DROP',
        description: 'beta may not reach alpha'
      });
      await AclEngine.createRule({
        priority: 100,
        source_cidr: '0.0.0.0/0',
        destination_cidr: '0.0.0.0/0',
        action: 'ACCEPT',
        description: 'mesh default'
      });
    });

    it('removes the peer from both netmaps and leaves every other pair alone', async () => {
      const a = await fetchNetmap(app, alpha.id);
      const b = await fetchNetmap(app, beta.id);
      const c = await fetchNetmap(app, gamma.id);

      assert.deepStrictEqual(peerIds(a.body), [gamma.id]);
      assert.deepStrictEqual(peerIds(b.body), [gamma.id]);
      assert.deepStrictEqual(peerIds(c.body), [alpha.id, beta.id].sort());
    });

    it('leaks nothing about the denied peer anywhere in the response', async () => {
      const a = await fetchNetmap(app, alpha.id);
      const raw = JSON.stringify(a.body);

      // The peer's key and its overlay addresses are what would let alpha dial beta
      // regardless of the peer list. The compiled ACL legitimately names beta's VIP
      // in a DROP rule, so the search is over the peer set and the raw key material.
      assert.ok(!raw.includes(beta.key), "beta's public key must not appear in alpha's netmap");
      assert.ok(!raw.includes(beta.vip6), "beta's overlay IPv6 must not appear in alpha's netmap");
      assert.ok(!JSON.stringify(a.body.peers).includes(beta.vip), "beta's VIP must not appear in alpha's peer set");
    });

    it('recovers the pair when the rules are deleted', async () => {
      await clearRules();

      const a = await fetchNetmap(app, alpha.id);
      assert.deepStrictEqual(peerIds(a.body), [beta.id, gamma.id].sort());
    });
  });

  describe('an open organisation whose rules only drop', () => {
    async function setDefaultPolicy(policy) {
      await dbHelper.pool.query("UPDATE organizations SET default_policy = $1 WHERE id = 'org-default'", [policy]);
      await AclEngine.bumpEpoch('acl');
    }

    beforeEach(async () => {
      await setDefaultPolicy('open');
      // What the console's "cut connection" writes: a DROP each way and nothing else.
      // This used to compile to an empty allow-list, and pkg/acl then denied every
      // peer of every node: cutting one link took the whole mesh down.
      await AclEngine.createRule({
        priority: 50,
        source_cidr: `${alpha.vip}/32`,
        destination_cidr: `${beta.vip}/32`,
        action: 'DROP'
      });
      await AclEngine.createRule({
        priority: 50,
        source_cidr: `${beta.vip}/32`,
        destination_cidr: `${alpha.vip}/32`,
        action: 'DROP'
      });
    });

    it('cuts that pair and keeps every other pair', async () => {
      assert.deepStrictEqual(peerIds((await fetchNetmap(app, alpha.id)).body), [gamma.id]);
      assert.deepStrictEqual(peerIds((await fetchNetmap(app, beta.id)).body), [gamma.id]);
      assert.deepStrictEqual(peerIds((await fetchNetmap(app, gamma.id)).body), [alpha.id, beta.id].sort());
    });

    it('puts the DROP ahead of the open default, because pkg/acl takes the first match', async () => {
      const compiled = await AclEngine.compilePolicyFor(alpha.id);
      const forBeta = compiled.outbound_rules.filter((r) => r.allowed_peer_vip === beta.vip);
      assert.deepStrictEqual(
        forBeta.map((r) => r.action),
        ['DROP', 'ACCEPT'],
        'the open default must come after the DROP it is carved by'
      );
      const forGamma = compiled.outbound_rules.filter((r) => r.allowed_peer_vip === gamma.vip);
      assert.deepStrictEqual(
        forGamma.map((r) => r.action),
        ['ACCEPT']
      );
    });

    it('gives the simulator the same answer the nodes enforce', async () => {
      const toGamma = await AclEngine.simulatePacket({
        source_ip: alpha.vip,
        destination_ip: gamma.vip,
        defaultPolicy: 'open'
      });
      const toBeta = await AclEngine.simulatePacket({
        source_ip: alpha.vip,
        destination_ip: beta.vip,
        defaultPolicy: 'open'
      });
      assert.strictEqual(toGamma.verdict, 'ACCEPT');
      assert.strictEqual(toBeta.verdict, 'DROP');
    });

    it('stops falling through to the default once an ACCEPT rule exists', async () => {
      await AclEngine.createRule({
        priority: 100,
        source_cidr: `${alpha.vip}/32`,
        destination_cidr: `${gamma.vip}/32`,
        action: 'ACCEPT'
      });
      // An allow-list now: beta was only ever reachable through the open default.
      assert.deepStrictEqual(peerIds((await fetchNetmap(app, beta.id)).body), []);
      assert.deepStrictEqual(peerIds((await fetchNetmap(app, alpha.id)).body), [gamma.id]);
    });

    it('keeps a deny organisation closed', async () => {
      await setDefaultPolicy('deny');
      try {
        assert.deepStrictEqual(peerIds((await fetchNetmap(app, gamma.id)).body), []);
      } finally {
        await setDefaultPolicy('open');
      }
    });
  });

  it('keeps a peer that is denied on one port and allowed on the rest', async () => {
    // pkg/acl takes the first matching entry, so a DROP on 80/TCP followed by an
    // allow-all leaves every other port open. Treating "an ACCEPT exists" or "a DROP
    // exists" as the whole answer would get this backwards in one direction or the
    // other; the netmap has to read the list the way the filter does.
    await AclEngine.createRule({
      priority: 10,
      source_cidr: alpha.vip,
      destination_cidr: beta.vip,
      protocol: 'TCP',
      port_start: 80,
      port_end: 80,
      action: 'DROP'
    });
    await AclEngine.createRule({
      priority: 100,
      source_cidr: '0.0.0.0/0',
      destination_cidr: '0.0.0.0/0',
      action: 'ACCEPT'
    });

    assert.ok(peerIds((await fetchNetmap(app, alpha.id)).body).includes(beta.id));
  });

  it('drops a peer whose every entry is a DROP, even behind a narrower allow', async () => {
    await AclEngine.createRule({
      priority: 10,
      source_cidr: alpha.vip,
      destination_cidr: beta.vip,
      action: 'DROP'
    });
    await AclEngine.createRule({
      priority: 20,
      source_cidr: beta.vip,
      destination_cidr: alpha.vip,
      action: 'DROP'
    });
    // An allow-all written after a full-range DROP changes nothing for that pair.
    await AclEngine.createRule({
      priority: 100,
      source_cidr: '0.0.0.0/0',
      destination_cidr: '0.0.0.0/0',
      action: 'ACCEPT'
    });

    assert.ok(!peerIds((await fetchNetmap(app, alpha.id)).body).includes(beta.id));
    assert.ok(!peerIds((await fetchNetmap(app, beta.id)).body).includes(alpha.id));
  });

  it('keeps a one-directional permission: the peer appears in both netmaps', async () => {
    // "A peer appears only if the compiled policy permits traffic in at least one
    // direction." A rule that lets alpha reach beta and nothing else still makes them
    // peers, because the tunnel carries the answers to what alpha sends.
    await AclEngine.createRule({
      priority: 10,
      source_cidr: alpha.vip,
      destination_cidr: beta.vip,
      action: 'ACCEPT',
      description: 'alpha to beta only'
    });

    const a = await fetchNetmap(app, alpha.id);
    const b = await fetchNetmap(app, beta.id);

    assert.deepStrictEqual(peerIds(a.body), [beta.id]);
    assert.deepStrictEqual(peerIds(b.body), [alpha.id]);
    // gamma is named by no rule at all: it is denied by default and must be absent.
    assert.ok(!peerIds(a.body).includes(gamma.id));
  });

  describe('quarantine', () => {
    it('removes the node from every peer set and advances the version', async () => {
      const before = await NetmapService.getVersion();

      await dbHelper.pool.query('UPDATE nodes SET is_quarantined = true, is_healthy = false WHERE id = $1', [gamma.id]);
      await AclEngine.bumpNetmap();

      const after = await NetmapService.getVersion();
      assert.ok(after > before, 'quarantining a node must advance the netmap version');

      const a = await fetchNetmap(app, alpha.id);
      const b = await fetchNetmap(app, beta.id);
      assert.deepStrictEqual(peerIds(a.body), [beta.id]);
      assert.deepStrictEqual(peerIds(b.body), [alpha.id]);
    });

    it('gives the quarantined node itself no peers at all', async () => {
      await dbHelper.pool.query('UPDATE nodes SET is_quarantined = true, is_healthy = false WHERE id = $1', [gamma.id]);

      // Its credential stops working while it is quarantined (ADR 0017).
      const c = await fetchNetmap(app, gamma.id);
      assert.strictEqual(c.status, 403);
      assert.ok(!('peers' in c.body));
    });

    it('restores the node when the quarantine is lifted', async () => {
      await dbHelper.pool.query('UPDATE nodes SET is_quarantined = true, is_healthy = false WHERE id = $1', [gamma.id]);
      assert.deepStrictEqual(peerIds((await fetchNetmap(app, alpha.id)).body), [beta.id]);

      await dbHelper.pool.query('UPDATE nodes SET is_quarantined = false, is_healthy = true WHERE id = $1', [gamma.id]);
      assert.deepStrictEqual(peerIds((await fetchNetmap(app, alpha.id)).body), [beta.id, gamma.id].sort());
    });
  });

  describe('revocation', () => {
    it('drops the revoked peer and lists its key under revoked_keys', async () => {
      await RevocationEngine.revokeNodeKeys([gamma.id], { reason: 'test' });

      const a = await fetchNetmap(app, alpha.id);
      assert.deepStrictEqual(peerIds(a.body), [beta.id]);
      assert.ok(a.body.revoked_keys.includes(gamma.key), 'the revoked key must be delivered');
      assert.ok(!JSON.stringify(a.body.peers).includes(gamma.key));
    });
  });

  describe('a seventh node', () => {
    it('appears in the other netmaps and advances the version', async () => {
      const before = await NetmapService.getVersion();
      const delta = await registerNode(app, nodeKey());
      const after = await NetmapService.getVersion();

      assert.ok(after > before, 'registering a node must advance the netmap version');
      assert.ok(peerIds((await fetchNetmap(app, alpha.id)).body).includes(delta.id));

      // Leave the fleet as the other tests expect it.
      await dbHelper.pool.query('DELETE FROM nodes WHERE id = $1', [delta.id]);
      await AclEngine.bumpNetmap();
    });
  });

  describe('endpoints reported on the heartbeat', () => {
    async function beat(nodeId, endpoints) {
      return request(app).post('/v4/control/heartbeat').set(nodeAuth(nodeId)).send({ node_id: nodeId, endpoints });
    }

    it('reports the netmap version on every heartbeat', async () => {
      const res = await beat(alpha.id, []);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.netmap_version, await NetmapService.getVersion());
    });

    it('advances the version the node sees when a rule changes', async () => {
      const before = (await beat(alpha.id, [])).body.netmap_version;
      await AclEngine.createRule({ source_cidr: '0.0.0.0/0', destination_cidr: '0.0.0.0/0', action: 'ACCEPT' });
      const after = (await beat(alpha.id, [])).body.netmap_version;
      assert.ok(after > before, `netmap version did not advance: ${before} -> ${after}`);
    });

    it('delivers a stored endpoint to the peers as ip:port', async () => {
      await beat(beta.id, [{ ip_address: '10.89.0.12', port: 51820, protocol: 'udp' }]);

      const a = await fetchNetmap(app, alpha.id);
      const peerBeta = a.body.peers.find((p) => p.node_id === beta.id);
      assert.deepStrictEqual(peerBeta.endpoints, ['10.89.0.12:51820']);
    });

    it('refuses loopback, link-local, malformed and out-of-range entries', async () => {
      const rejected = NetmapService.validateEndpoints([
        { ip_address: '127.0.0.1', port: 51820 },
        { ip_address: '::1', port: 51820 },
        { ip_address: '169.254.10.1', port: 51820 },
        { ip_address: 'fe80::1', port: 51820 },
        { ip_address: '0.0.0.0', port: 51820 },
        { ip_address: 'not-an-address', port: 51820 },
        { ip_address: '10.0.0.1', port: 0 },
        { ip_address: '10.0.0.1', port: 70000 },
        { ip_address: '10.0.0.1', port: 51820 }
      ]);

      assert.deepStrictEqual(
        rejected.endpoints.map((e) => e._rendered),
        ['10.0.0.1:51820']
      );
      assert.deepStrictEqual(
        rejected.rejected.map((r) => r.reason),
        ['loopback', 'loopback', 'link-local', 'link-local', 'unspecified', 'malformed', 'port', 'port']
      );
    });

    it('refuses an entry longer than the wire limit', async () => {
      const long = `${'a'.repeat(70)}:51820`;
      const result = NetmapService.validateEndpoints([long]);
      assert.deepStrictEqual(result.endpoints, []);
      assert.strictEqual(result.rejected.length, 1);
    });

    it('keeps at most eight endpoints and reports the truncation', async () => {
      const many = Array.from({ length: 12 }, (_, i) => ({ ip_address: `10.0.0.${i + 1}`, port: 51820 }));
      const result = NetmapService.validateEndpoints(many);
      assert.strictEqual(result.endpoints.length, NetmapService.MAX_ENDPOINTS);
      assert.strictEqual(result.truncated, true);
    });

    it('stores a bad entry nowhere: the peers see only the good ones', async () => {
      await beat(beta.id, [
        { ip_address: '127.0.0.1', port: 51820 },
        { ip_address: '10.89.0.12', port: 51820 }
      ]);

      const a = await fetchNetmap(app, alpha.id);
      const peerBeta = a.body.peers.find((p) => p.node_id === beta.id);
      assert.deepStrictEqual(peerBeta.endpoints, ['10.89.0.12:51820']);
    });

    it('bumps the version once per debounce window however often the endpoint flaps', async () => {
      const start = new Date('2026-09-19T10:00:00Z');

      const first = await NetmapService.recordEndpoints(beta.id, [{ ip_address: '10.89.0.20', port: 51820 }], start);
      assert.strictEqual(first.bumped, true, 'the first change must be delivered');
      const afterFirst = await NetmapService.getVersion();

      // Same window, different value: stored, not announced.
      const flap = new Date(start.getTime() + 5_000);
      const second = await NetmapService.recordEndpoints(beta.id, [{ ip_address: '10.89.0.21', port: 51820 }], flap);
      assert.strictEqual(second.changed, true);
      assert.strictEqual(second.bumped, false);
      assert.strictEqual(await NetmapService.getVersion(), afterFirst);

      // The value is nonetheless what the peers are told, as soon as they ask.
      const a = await fetchNetmap(app, alpha.id);
      assert.deepStrictEqual(a.body.peers.find((p) => p.node_id === beta.id).endpoints, ['10.89.0.21:51820']);

      // Past the window the next change is announced again.
      const later = new Date(start.getTime() + (NetmapService.ENDPOINT_DEBOUNCE_SECONDS + 1) * 1000);
      const third = await NetmapService.recordEndpoints(beta.id, [{ ip_address: '10.89.0.22', port: 51820 }], later);
      assert.strictEqual(third.bumped, true);
      assert.ok((await NetmapService.getVersion()) > afterFirst);
    });

    it('does not bump when the stored value comes back with its keys in another order', async () => {
      // PostgreSQL stores this column as jsonb and hands the value back with its keys
      // normalised. Comparing the serialised forms therefore reported a change on
      // every heartbeat, which moved the netmap version twice every fifteen seconds
      // on the six-node fleet and made every node re-fetch a document it already had.
      const at = new Date('2026-09-19T12:00:00Z');
      await NetmapService.recordEndpoints(beta.id, [{ ip_address: '10.89.0.40', port: 51820 }], at);
      const version = await NetmapService.getVersion();

      await dbHelper.pool.query('UPDATE nodes SET endpoints = $1 WHERE id = $2', [
        JSON.stringify([{ protocol: 'udp', port: 51820, is_stun_discovered: false, ip_address: '10.89.0.40' }]),
        beta.id
      ]);

      const later = new Date(at.getTime() + 600_000);
      const result = await NetmapService.recordEndpoints(beta.id, [{ ip_address: '10.89.0.40', port: 51820 }], later);

      assert.strictEqual(result.changed, false, 'a re-ordered stored value was read as a change');
      assert.strictEqual(await NetmapService.getVersion(), version);
    });

    it('does not bump when the reported endpoints are unchanged', async () => {
      const at = new Date('2026-09-19T11:00:00Z');
      await NetmapService.recordEndpoints(beta.id, [{ ip_address: '10.89.0.30', port: 51820 }], at);
      const version = await NetmapService.getVersion();

      const again = new Date(at.getTime() + 120_000);
      const result = await NetmapService.recordEndpoints(beta.id, [{ ip_address: '10.89.0.30', port: 51820 }], again);

      assert.strictEqual(result.changed, false);
      assert.strictEqual(result.bumped, false);
      assert.strictEqual(await NetmapService.getVersion(), version);
    });
  });
});
