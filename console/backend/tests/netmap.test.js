const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');

const testDbPath = path.resolve(__dirname, '../../data/test_netmap.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;

const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const { seedDatabase } = require('../db/seed');
const { createApp } = require('../server');
const AclEngine = require('../services/AclEngine');
const NetmapService = require('../services/NetmapService');
const RevocationEngine = require('../services/RevocationEngine');

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

async function registerNode(app, keyHex) {
  const res = await request(app).post('/v4/control/register').set(AUTH).send(registerBody(keyHex));
  assert.strictEqual(res.status, 200, `registration failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.assigned_node_id, key: keyHex, vip: res.body.overlay_ipv4, vip6: res.body.overlay_ipv6 };
}

async function fetchNetmap(app, nodeId, version = 0) {
  const res = await request(app).post('/v4/control/netmap').set(AUTH).send({ node_id: nodeId, version });
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
  let alpha;
  let beta;
  let gamma;

  before(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    const db = getDatabase(testDbPath);
    runMigrations(db);
    seedDatabase(db);
    // The seed writes two demo node rows. They are real rows and would be real peers,
    // which is correct behaviour and noise here: this suite asserts on exact peer
    // sets, so the fleet has to be exactly the nodes it registers.
    db.prepare("DELETE FROM nodes WHERE id LIKE 'svrn-node-seed%'").run();
    app = createApp();

    alpha = await registerNode(app, 'a'.repeat(64));
    beta = await registerNode(app, 'b'.repeat(64));
    gamma = await registerNode(app, 'c'.repeat(64));
  });

  after(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  beforeEach(async () => {
    await clearRules();
    const db = getDatabase();
    db.prepare('UPDATE nodes SET is_quarantined = 0, is_healthy = 1, endpoints = ?, endpoints_bumped_at = NULL').run(
      '[]'
    );
    db.prepare('DELETE FROM revoked_keys').run();
    await AclEngine.bumpNetmap();
  });

  it('refuses a caller with no credential', async () => {
    const res = await request(app).post('/v4/control/netmap').send({ node_id: alpha.id, version: 0 });
    assert.strictEqual(res.status, 401);
    assert.ok(!('peers' in res.body), 'an unauthenticated caller must not receive a peer set');
  });

  it('answers 404 for a node it has never seen', async () => {
    const res = await fetchNetmap(app, 'pk_0000000000000000');
    assert.strictEqual(res.status, 404);
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
      // A single DROP rule would take the whole fleet dark: with no rules at all the
      // compiled policy is allow-all, and the first rule written replaces that with
      // exactly the rules present. An operator denying one pair therefore writes the
      // deny and the allow-all it is carving out of, which is what this does.
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

      getDatabase().prepare('UPDATE nodes SET is_quarantined = 1, is_healthy = 0 WHERE id = ?').run(gamma.id);
      await AclEngine.bumpNetmap();

      const after = await NetmapService.getVersion();
      assert.ok(after > before, 'quarantining a node must advance the netmap version');

      const a = await fetchNetmap(app, alpha.id);
      const b = await fetchNetmap(app, beta.id);
      assert.deepStrictEqual(peerIds(a.body), [beta.id]);
      assert.deepStrictEqual(peerIds(b.body), [alpha.id]);
    });

    it('gives the quarantined node itself no peers at all', async () => {
      getDatabase().prepare('UPDATE nodes SET is_quarantined = 1, is_healthy = 0 WHERE id = ?').run(gamma.id);

      const c = await fetchNetmap(app, gamma.id);
      assert.strictEqual(c.status, 200);
      assert.deepStrictEqual(c.body.peers, []);
    });

    it('restores the node when the quarantine is lifted', async () => {
      getDatabase().prepare('UPDATE nodes SET is_quarantined = 1, is_healthy = 0 WHERE id = ?').run(gamma.id);
      assert.deepStrictEqual(peerIds((await fetchNetmap(app, alpha.id)).body), [beta.id]);

      getDatabase().prepare('UPDATE nodes SET is_quarantined = 0, is_healthy = 1 WHERE id = ?').run(gamma.id);
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
      const delta = await registerNode(app, 'd'.repeat(64));
      const after = await NetmapService.getVersion();

      assert.ok(after > before, 'registering a node must advance the netmap version');
      assert.ok(peerIds((await fetchNetmap(app, alpha.id)).body).includes(delta.id));

      // Leave the fleet as the other tests expect it.
      getDatabase().prepare('DELETE FROM nodes WHERE id = ?').run(delta.id);
      await AclEngine.bumpNetmap();
    });
  });

  describe('endpoints reported on the heartbeat', () => {
    async function beat(nodeId, endpoints) {
      return request(app).post('/v4/control/heartbeat').set(AUTH).send({ node_id: nodeId, endpoints });
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
