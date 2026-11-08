const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const request = require('supertest');

const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;
process.env.SOVEREIGN_VALIDATE_RESPONSES = 'true';

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const AclEngine = require('../services/AclEngine');
const NetmapService = require('../services/NetmapService');
const RevocationEngine = require('../services/RevocationEngine');
const TransportPolicyService = require('../services/TransportPolicyService');
const { nodeKey, register } = require('./helpers/nodeEnrolment');
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { settleAuditWrites } = require('../utils/audit');

/**
 * The transport policy decides which paths a node may use to reach a peer. It is
 * the installation's ceiling intersected with the organisation's choice, the binary
 * each node actually carries, and -- for DERP -- the relays the installation runs.
 * Everything here goes through the real routes over a real database and asserts on
 * the documents and snapshots the nodes and relays would receive.
 */

const DERP_V2 = { transports: ['udp', 'derp'], capabilities: ['derp-v2'] };
const UDP_ONLY_V2 = { transports: ['udp'], capabilities: ['derp-v2'] };
const LEGACY = {};

const credentials = new Map();
const nodeAuth = (nodeId) => ({ Authorization: `Bearer ${credentials.get(nodeId)}` });

async function registerNode(
  app,
  capability,
  keyHex = nodeKey(),
  endpoints = [{ ip_address: '203.0.113.7', port: 51820, protocol: 'udp' }]
) {
  const res = await register(
    app,
    {
      public_key_hex: keyHex,
      role: 'CLIENT_ORIGIN',
      endpoints,
      capability: { country_code: 'IT', ...capability }
    },
    { token: REGISTRATION_TOKEN }
  );
  assert.strictEqual(res.status, 200, `registration failed: ${JSON.stringify(res.body)}`);
  credentials.set(res.body.assigned_node_id, res.body.credential);
  return { id: res.body.assigned_node_id, key: keyHex.toLowerCase() };
}

async function netmap(app, nodeId, version = 0) {
  const res = await request(app).post('/v4/control/netmap').set(nodeAuth(nodeId)).send({ node_id: nodeId, version });
  assert.strictEqual(res.status, 200, `netmap failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

function heartbeat(app, nodeId, body, as = nodeId) {
  return request(app)
    .post('/v4/control/heartbeat')
    .set(nodeAuth(as))
    .send({ node_id: nodeId, ...body });
}

function homes(...ids) {
  const now = Math.floor(Date.now() / 1000);
  return {
    transport_report_version: 'derp-v2',
    relay_homes: ids.map((id) => ({ relay_id: id, observed_at_unix: now }))
  };
}

const peer = (doc, id) => doc.peers.find((p) => p.node_id === id);

function admission(app, credential) {
  const r = request(app).post('/v4/control/relay/admission');
  return credential ? r.set('Authorization', `Bearer ${credential}`) : r;
}

describe('Transport policy authority', () => {
  let app;
  let db;
  let superToken;
  let adminToken;
  let otherAdminToken;
  let auditorToken;
  const relayCredentials = {};
  let a;
  let b;
  let udpOnly;
  let legacy;
  let foreign;

  async function setOrgPolicy(orgId, allowed, token = superToken) {
    const res = await request(app)
      .put(`/api/organizations/${orgId}/transports`)
      .set('Authorization', `Bearer ${token}`)
      .send({ allowed_transports: allowed });
    return res;
  }

  before(async () => {
    db = await setupTestDatabase();
    await db.pool.query("DELETE FROM nodes WHERE id LIKE 'svrn-node-seed%'");
    app = createApp();

    await db.pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES
         ('org-transport-b', 'Transport B', 'transport-b', 'open')
       ON CONFLICT (id) DO NOTHING`
    );
    await db.pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id) VALUES
         ('usr-tp-super', 'tpsuper', 'tpsuper@example.test', 'x', 'super-admin', 'org-default'),
         ('usr-tp-admin', 'tpadmin', 'tpadmin@example.test', 'x', 'user', 'org-default'),
         ('usr-tp-other', 'tpother', 'tpother@example.test', 'x', 'user', 'org-transport-b'),
         ('usr-tp-auditor', 'tpauditor', 'tpauditor@example.test', 'x', 'user', 'org-default')
       ON CONFLICT (id) DO NOTHING`
    );
    // Organisation roles live in memberships; users.role is only the platform role.
    await db.pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES
         ('mem-tp-admin', 'usr-tp-admin', 'org-default', 'admin'),
         ('mem-tp-other', 'usr-tp-other', 'org-transport-b', 'admin'),
         ('mem-tp-auditor', 'usr-tp-auditor', 'org-default', 'auditor')
       ON CONFLICT DO NOTHING`
    );
    const token = (id, username, role, org) =>
      issueConsoleTestToken({ sub: id, id, username, role, organization_id: org });
    superToken = await token('usr-tp-super', 'tpsuper', 'super-admin', 'org-default');
    adminToken = await token('usr-tp-admin', 'tpadmin', 'user', 'org-default');
    otherAdminToken = await token('usr-tp-other', 'tpother', 'user', 'org-transport-b');
    auditorToken = await token('usr-tp-auditor', 'tpauditor', 'user', 'org-default');

    a = await registerNode(app, DERP_V2);
    b = await registerNode(app, DERP_V2);
    udpOnly = await registerNode(app, UDP_ONLY_V2);
    legacy = await registerNode(app, LEGACY);
    foreign = await registerNode(app, DERP_V2);
    await db.pool.query("UPDATE nodes SET organization_id = 'org-transport-b' WHERE id = $1", [foreign.id]);
  });

  after(async () => {
    delete process.env.SOVEREIGN_TRANSPORT_CEILING;
    if (db) await db.cleanup();
  });

  beforeEach(async () => {
    process.env.SOVEREIGN_TRANSPORT_CEILING = 'udp,derp';
    await db.pool.query('DELETE FROM revoked_keys');
    await db.pool.query('UPDATE nodes SET is_quarantined = false, is_healthy = true');
    await db.pool.query('UPDATE organizations SET allowed_transports = NULL');
    await db.pool.query("UPDATE nodes SET relay_homes = '[]'::jsonb, relay_homes_reported_at = NULL");
    await AclEngine.bumpNetmap();
  });

  describe('relay administration', () => {
    it('lets only the platform super-admin create a relay, and shows the credential once', async () => {
      for (const t of [adminToken, otherAdminToken, auditorToken]) {
        const denied = await request(app)
          .post('/api/transports/relays')
          .set('Authorization', `Bearer ${t}`)
          .send({ relay_id: 'relay-x', url: 'https://relay-x.example.test/derp' });
        assert.strictEqual(denied.status, 403, `role was not refused: ${JSON.stringify(denied.body)}`);
      }
      for (const id of ['relay-a', 'relay-b']) {
        const res = await request(app)
          .post('/api/transports/relays')
          .set('Authorization', `Bearer ${superToken}`)
          .send({ relay_id: id, url: `https://${id}.example.test:8443/derp` });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.match(res.body.credential, /^nrr1_[0-9a-f]{64}$/);
        relayCredentials[id] = res.body.credential;
      }
      const list = await request(app).get('/api/transports/relays').set('Authorization', `Bearer ${superToken}`);
      assert.strictEqual(list.status, 200);
      assert.deepStrictEqual(
        list.body.relays.map((r) => r.relay_id),
        ['relay-a', 'relay-b']
      );
      const body = JSON.stringify(list.body);
      assert.ok(
        !body.includes(relayCredentials['relay-a']) && !/credential_hash/.test(body),
        'listing leaks a credential'
      );
      const stored = await db.pool.query('SELECT credential_hash FROM transport_relays');
      for (const row of stored.rows) {
        assert.ok(!Object.values(relayCredentials).includes(row.credential_hash), 'credential stored in clear');
      }
    });

    it('refuses relay definitions a node would refuse or that would leak credentials', async () => {
      const bad = [
        { relay_id: 'relay-c', url: 'http://relay-c.example.test/derp' },
        { relay_id: 'relay-c', url: 'https://user:pw@relay-c.example.test/derp' },
        { relay_id: 'relay-c', url: 'https:///derp' },
        { relay_id: 'relay-c', url: 'https://relay-c.example.test/derp?x=1' },
        { relay_id: 'Relay C', url: 'https://relay-c.example.test/derp' },
        { relay_id: 'relay/c', url: 'https://relay-c.example.test/derp' },
        { relay_id: '', url: 'https://relay-c.example.test/derp' }
      ];
      for (const body of bad) {
        const res = await request(app)
          .post('/api/transports/relays')
          .set('Authorization', `Bearer ${superToken}`)
          .send(body);
        assert.strictEqual(res.status, 400, `accepted ${JSON.stringify(body)}`);
      }
      const dup = await request(app)
        .post('/api/transports/relays')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ relay_id: 'relay-a', url: 'https://other.example.test/derp' });
      assert.strictEqual(dup.status, 409);
    });

    it('records relay changes in the audit log', async () => {
      await settleAuditWrites();
      const rows = await db.pool.query(
        "SELECT event_type, target_id FROM audit_events WHERE event_type LIKE 'TRANSPORT_RELAY_%' ORDER BY sequence_num"
      );
      assert.deepStrictEqual(
        rows.rows.map((r) => `${r.event_type}:${r.target_id}`),
        ['TRANSPORT_RELAY_CREATED:relay-a', 'TRANSPORT_RELAY_CREATED:relay-b']
      );
    });
  });

  describe('organisation policy', () => {
    it('is changed by an owner/admin of that organisation or the super-admin only', async () => {
      assert.strictEqual((await setOrgPolicy('org-default', ['udp', 'derp'], adminToken)).status, 200);
      assert.strictEqual((await setOrgPolicy('org-default', ['derp'], otherAdminToken)).status, 404);
      assert.strictEqual((await setOrgPolicy('org-default', ['derp'], auditorToken)).status, 403);
      assert.strictEqual((await setOrgPolicy('org-transport-b', ['derp'], adminToken)).status, 404);
      const read = await request(app)
        .get('/api/organizations/org-default/transports')
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(read.status, 200);
      assert.deepStrictEqual(read.body.allowed_transports, ['udp', 'derp']);
      assert.deepStrictEqual(read.body.ceiling, ['udp', 'derp']);
      assert.deepStrictEqual(read.body.effective_transports, ['udp', 'derp']);
    });

    it('refuses unknown transports and duplicates', async () => {
      for (const list of [['udp', 'quic'], ['derp', 'derp'], 'udp', [1]]) {
        const res = await setOrgPolicy('org-default', list);
        assert.strictEqual(res.status, 400, `accepted ${JSON.stringify(list)}`);
      }
    });

    it('reports the ceiling as the effective bound', async () => {
      process.env.SOVEREIGN_TRANSPORT_CEILING = 'udp';
      await setOrgPolicy('org-default', ['udp', 'derp']);
      const read = await request(app)
        .get('/api/organizations/org-default/transports')
        .set('Authorization', `Bearer ${superToken}`);
      assert.deepStrictEqual(read.body.effective_transports, ['udp']);
    });

    it('writes an audit event and moves the netmap version', async () => {
      const before = await NetmapService.getVersion();
      await setOrgPolicy('org-default', ['derp']);
      assert.ok((await NetmapService.getVersion()) > before, 'version did not move');
      await settleAuditWrites();
      const rows = await db.pool.query(
        "SELECT organization_id FROM audit_events WHERE event_type = 'TRANSPORT_ORG_POLICY_UPDATED' ORDER BY sequence_num DESC LIMIT 1"
      );
      assert.strictEqual(rows.rows[0].organization_id, 'org-default');
    });
  });

  describe('netmap', () => {
    it('keeps today behaviour by default: UDP only, under the versioned policy for derp-v2 nodes', async () => {
      process.env.SOVEREIGN_TRANSPORT_CEILING = 'udp';
      const doc = await netmap(app, a.id);
      assert.strictEqual(doc.transport_policy_version, 'derp-v2');
      assert.deepStrictEqual(doc.allowed_transports, ['udp']);
      assert.strictEqual(doc.relay_candidates, undefined);
      assert.deepStrictEqual(peer(doc, b.id).allowed_transports, ['udp']);
      assert.deepStrictEqual(peer(doc, b.id).endpoints, ['203.0.113.7:51820']);
      assert.ok(peer(doc, legacy.id), 'legacy peer must stay reachable over UDP');
    });

    it('gives a legacy node a legacy document', async () => {
      const doc = await netmap(app, legacy.id);
      assert.strictEqual(doc.transport_policy_version, undefined);
      assert.strictEqual(doc.allowed_transports, undefined);
      assert.strictEqual(doc.relay_candidates, undefined);
      assert.strictEqual(peer(doc, a.id).allowed_transports, undefined);
      assert.deepStrictEqual(peer(doc, a.id).endpoints, ['203.0.113.7:51820']);
    });

    it('reads an unknown capability as legacy, never as derp-v2', async () => {
      const odd = await registerNode(app, { transports: ['udp', 'derp'], capabilities: ['derp-v9'] });
      const doc = await netmap(app, odd.id);
      assert.strictEqual(doc.transport_policy_version, undefined);
      const fromA = await netmap(app, a.id);
      assert.deepStrictEqual(peer(fromA, odd.id).allowed_transports, ['udp']);
    });

    it('offers DERP with the relays and the peer homes when installation and organisation allow it', async () => {
      await setOrgPolicy('org-default', ['udp', 'derp']);
      assert.strictEqual((await heartbeat(app, b.id, homes('relay-b'))).status, 200);
      const doc = await netmap(app, a.id);
      assert.deepStrictEqual(doc.allowed_transports, ['udp', 'derp']);
      assert.deepStrictEqual(doc.relay_candidates, [
        { relay_id: 'relay-a', url: 'https://relay-a.example.test:8443/derp', capability: 'derp-v2' },
        { relay_id: 'relay-b', url: 'https://relay-b.example.test:8443/derp', capability: 'derp-v2' }
      ]);
      const pb = peer(doc, b.id);
      assert.deepStrictEqual(pb.allowed_transports, ['udp', 'derp']);
      assert.deepStrictEqual(
        pb.relay_homes.map((h) => h.relay_id),
        ['relay-b']
      );
      // Per pair: a peer whose binary has no DERP stays on UDP, and a legacy peer too.
      assert.deepStrictEqual(peer(doc, udpOnly.id).allowed_transports, ['udp']);
      assert.strictEqual(peer(doc, udpOnly.id).relay_homes, undefined);
      assert.deepStrictEqual(peer(doc, legacy.id).allowed_transports, ['udp']);
      // The same peer seen from a node without DERP: UDP only, and no relay homes.
      const fromUdpOnly = peer(await netmap(app, udpOnly.id), b.id);
      assert.deepStrictEqual(fromUdpOnly.allowed_transports, ['udp']);
      assert.strictEqual(fromUdpOnly.relay_homes, undefined, 'relay homes sent to a pair without DERP');
      // And a peer without DERP that reports homes anyway: its pair with a is UDP only.
      assert.strictEqual((await heartbeat(app, udpOnly.id, homes('relay-a'))).status, 200);
      const pu = peer(await netmap(app, a.id), udpOnly.id);
      assert.deepStrictEqual(pu.allowed_transports, ['udp']);
      assert.strictEqual(pu.relay_homes, undefined, 'homes of a peer without DERP were offered');
    });

    it('denies UDP everywhere it is withdrawn: no endpoint, no legacy peer, no peer without DERP', async () => {
      await setOrgPolicy('org-default', ['derp']);
      await heartbeat(app, b.id, homes('relay-a'));
      // The beat reports no endpoint; give b one, so an empty list below is the policy.
      await db.pool.query('UPDATE nodes SET endpoints = $2::jsonb WHERE id = $1', [
        b.id,
        JSON.stringify([{ ip_address: '203.0.113.9', port: 51820, protocol: 'udp', is_stun_discovered: false }])
      ]);
      assert.deepStrictEqual(peer(await netmap(app, legacy.id), b.id), undefined);
      const doc = await netmap(app, a.id);
      assert.deepStrictEqual(doc.allowed_transports, ['derp']);
      const pb = peer(doc, b.id);
      assert.deepStrictEqual(pb.allowed_transports, ['derp']);
      assert.deepStrictEqual(pb.endpoints, [], 'a UDP endpoint was sent under a policy that denies UDP');
      assert.strictEqual(peer(doc, legacy.id), undefined, 'a legacy peer can only speak UDP');
      assert.strictEqual(peer(doc, udpOnly.id), undefined, 'a peer without DERP has no allowed path');
      // A legacy node cannot enforce a UDP ban, so it gets no peer at all.
      const legacyDoc = await netmap(app, legacy.id);
      assert.deepStrictEqual(legacyDoc.peers, []);
      // The other organisation is untouched.
      const foreignDoc = await netmap(app, foreign.id);
      assert.deepStrictEqual(foreignDoc.allowed_transports, ['udp']);
      assert.ok(!JSON.stringify(foreignDoc).includes(b.key), 'another tenant leaked into the document');
    });

    it('lets the ceiling win over the organisation', async () => {
      process.env.SOVEREIGN_TRANSPORT_CEILING = 'udp';
      await setOrgPolicy('org-default', ['derp']);
      const doc = await netmap(app, a.id);
      assert.strictEqual(doc.transport_policy_version, 'derp-v2');
      assert.ok(!doc.allowed_transports || doc.allowed_transports.length === 0, 'derp above the ceiling');
      assert.deepStrictEqual(doc.peers, []);
      assert.strictEqual(doc.relay_candidates, undefined);
    });

    it('accepts only relay homes the installation runs, and at most two', async () => {
      await setOrgPolicy('org-default', ['udp', 'derp']);
      assert.strictEqual((await heartbeat(app, b.id, homes('relay-nowhere', 'relay-a'))).status, 200);
      let pb = peer(await netmap(app, a.id), b.id);
      assert.deepStrictEqual(
        pb.relay_homes.map((h) => h.relay_id),
        ['relay-a'],
        'a home on a relay the installation does not run was kept'
      );
      assert.strictEqual((await heartbeat(app, b.id, homes('relay-b', 'relay-b'))).status, 200);
      pb = peer(await netmap(app, a.id), b.id);
      assert.deepStrictEqual(
        pb.relay_homes.map((h) => h.relay_id),
        ['relay-b']
      );
      assert.strictEqual((await heartbeat(app, b.id, homes('relay-a'))).status, 200);
      // More than a node can send: the report is ignored, not the beat.
      assert.strictEqual((await heartbeat(app, b.id, homes('relay-a', 'relay-b', 'relay-c'))).status, 200);
      pb = peer(await netmap(app, a.id), b.id);
      assert.deepStrictEqual(
        pb.relay_homes.map((h) => h.relay_id),
        ['relay-a'],
        'an ignored report changed the stored homes'
      );
    });

    it('treats an omitted homes list under the report version as a withdrawal, and a legacy beat as no news', async () => {
      await setOrgPolicy('org-default', ['udp', 'derp']);
      await heartbeat(app, b.id, homes('relay-a'));
      const before = await NetmapService.getVersion();
      assert.strictEqual((await heartbeat(app, b.id, { cpu_usage_pct: 1 })).status, 200);
      assert.strictEqual(await NetmapService.getVersion(), before, 'a legacy beat moved the version');
      assert.ok(peer(await netmap(app, a.id), b.id).relay_homes);
      assert.strictEqual((await heartbeat(app, b.id, { transport_report_version: 'derp-v2' })).status, 200);
      assert.ok((await NetmapService.getVersion()) > before, 'withdrawal did not move the version');
      assert.strictEqual(peer(await netmap(app, a.id), b.id).relay_homes, undefined);
    });

    it('does not move the version for a beat that repeats the same homes', async () => {
      await heartbeat(app, b.id, homes('relay-a'));
      const before = await NetmapService.getVersion();
      await heartbeat(app, b.id, homes('relay-a'));
      assert.strictEqual(await NetmapService.getVersion(), before);
    });

    it('refuses a node publishing homes for another node', async () => {
      await heartbeat(app, b.id, homes('relay-a'));
      const res = await heartbeat(app, b.id, homes('relay-b'), a.id);
      assert.strictEqual(res.status, 403);
      const row = await db.pool.query('SELECT relay_homes FROM nodes WHERE id = $1', [b.id]);
      assert.deepStrictEqual(
        row.rows[0].relay_homes.map((h) => h.relay_id),
        ['relay-a']
      );
    });

    it('expires homes that are no longer reported and moves the version', async () => {
      await setOrgPolicy('org-default', ['udp', 'derp']);
      await heartbeat(app, b.id, homes('relay-a'));
      await db.pool.query("UPDATE nodes SET relay_homes_reported_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [b.id]);
      // Read time already refuses them, before any sweep.
      assert.strictEqual(peer(await netmap(app, a.id), b.id).relay_homes, undefined);
      const before = await NetmapService.getVersion();
      assert.strictEqual(await TransportPolicyService.expireRelayHomes(), 1);
      assert.ok((await NetmapService.getVersion()) > before);
      assert.strictEqual(await TransportPolicyService.expireRelayHomes(), 0);
    });

    it('moves the version when a node re-registers with a different binary, and only then', async () => {
      const node = await registerNode(app, LEGACY);
      assert.strictEqual((await netmap(app, node.id)).transport_policy_version, undefined);
      let before = await NetmapService.getVersion();
      await registerNode(app, LEGACY, node.key);
      assert.strictEqual(await NetmapService.getVersion(), before, 'an unchanged re-registration moved the version');
      await registerNode(app, DERP_V2, node.key);
      assert.ok((await NetmapService.getVersion()) > before, 'a new binary did not move the version');
      assert.strictEqual((await netmap(app, node.id)).transport_policy_version, 'derp-v2');
      before = await NetmapService.getVersion();
      await registerNode(app, { transports: ['udp', 'derp', 'quic', 'udp'], capabilities: ['derp-v2', 'x'] }, node.key);
      assert.strictEqual(await NetmapService.getVersion(), before, 'unknown values were recorded');
      const row = await db.pool.query('SELECT transports_built, node_capabilities FROM nodes WHERE id = $1', [node.id]);
      assert.deepStrictEqual(row.rows[0].transports_built, ['udp', 'derp']);
      assert.deepStrictEqual(row.rows[0].node_capabilities, ['derp-v2']);
      // Back to a legacy binary: the downgrade is a change too, and the node leaves the
      // versioned policy.
      before = await NetmapService.getVersion();
      await registerNode(app, LEGACY, node.key);
      assert.ok((await NetmapService.getVersion()) > before, 'a downgrade did not move the version');
      assert.strictEqual((await netmap(app, node.id)).transport_policy_version, undefined);
    });

    it('moves the version when the applied ceiling changes across a restart', async () => {
      process.env.SOVEREIGN_TRANSPORT_CEILING = 'udp';
      await TransportPolicyService.reconcileCeiling();
      const before = await NetmapService.getVersion();
      assert.strictEqual(await TransportPolicyService.reconcileCeiling(), false);
      process.env.SOVEREIGN_TRANSPORT_CEILING = 'udp,derp';
      assert.strictEqual(await TransportPolicyService.reconcileCeiling(), true);
      assert.ok((await NetmapService.getVersion()) > before);
    });

    it('refuses to start on a ceiling naming an unknown transport', () => {
      process.env.SOVEREIGN_TRANSPORT_CEILING = 'udp,quic';
      assert.throws(() => TransportPolicyService.ceiling(), /SOVEREIGN_TRANSPORT_CEILING/);
    });
  });

  describe('relay admission snapshot', () => {
    it('refuses every credential that is not an enabled relay', async () => {
      const userJwt = superToken;
      const nodeCredential = credentials.get(a.id);
      for (const credential of [null, REGISTRATION_TOKEN, nodeCredential, userJwt, `nrr1_${'0'.repeat(64)}`]) {
        const res = await admission(app, credential);
        assert.strictEqual(res.status, 401, `admitted with ${String(credential).slice(0, 5)}`);
        assert.strictEqual(res.body.keys, undefined);
      }
    });

    it('lists exactly the node keys allowed to use DERP', async () => {
      await setOrgPolicy('org-default', ['derp']);
      const res = await admission(app, relayCredentials['relay-a']);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.keys.slice().sort(), [a.key, b.key].sort());
      const now = Math.floor(Date.now() / 1000);
      assert.ok(Math.abs(res.body.generated_at_unix - now) <= 5);
      assert.ok(res.body.max_staleness_seconds > 0 && res.body.max_staleness_seconds <= 86400);
    });

    it('drops quarantined and revoked nodes, the other tenant and everybody above the ceiling', async () => {
      // Revocation also revokes the node's credential, so it gets a node of its own.
      const victim = await registerNode(app, DERP_V2);
      await setOrgPolicy('org-default', ['udp', 'derp']);
      const sorted = (...nodes) => nodes.map((n) => n.key).sort();
      await db.pool.query('UPDATE nodes SET is_quarantined = TRUE WHERE id = $1', [b.id]);
      let keys = (await admission(app, relayCredentials['relay-b'])).body.keys;
      assert.deepStrictEqual(keys, sorted(a, victim));
      await db.pool.query('UPDATE nodes SET is_quarantined = FALSE');
      await RevocationEngine.revokeNodeKeys([victim.id], { reason: 'test' });
      keys = (await admission(app, relayCredentials['relay-b'])).body.keys;
      assert.deepStrictEqual(keys, sorted(a, b));
      await setOrgPolicy('org-transport-b', ['derp']);
      keys = (await admission(app, relayCredentials['relay-b'])).body.keys;
      assert.deepStrictEqual(keys, sorted(a, b, foreign));
      await db.pool.query('UPDATE nodes SET is_quarantined = TRUE WHERE id = $1', [victim.id]);
      process.env.SOVEREIGN_TRANSPORT_CEILING = 'udp';
      keys = (await admission(app, relayCredentials['relay-b'])).body.keys;
      assert.deepStrictEqual(keys, []);
    });

    it('stops a disabled relay, withdraws it from the netmap and moves the version', async () => {
      await setOrgPolicy('org-default', ['udp', 'derp']);
      await heartbeat(app, b.id, homes('relay-b'));
      const before = await NetmapService.getVersion();
      const res = await request(app)
        .patch('/api/transports/relays/relay-b')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ enabled: false });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok((await NetmapService.getVersion()) > before);
      assert.strictEqual((await admission(app, relayCredentials['relay-b'])).status, 401);
      const doc = await netmap(app, a.id);
      assert.deepStrictEqual(
        doc.relay_candidates.map((r) => r.relay_id),
        ['relay-a']
      );
      assert.strictEqual(peer(doc, b.id).relay_homes, undefined);
    });

    it('invalidates the old credential on rotation', async () => {
      const res = await request(app)
        .post('/api/transports/relays/relay-a/rotate-credential')
        .set('Authorization', `Bearer ${superToken}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual((await admission(app, relayCredentials['relay-a'])).status, 401);
      assert.strictEqual((await admission(app, res.body.credential)).status, 200);
      relayCredentials['relay-a'] = res.body.credential;
    });
  });

  describe('review findings and guards', () => {
    // The admission suite disabled relay-b; these cases want both relays running.
    before(async () => {
      const res = await request(app)
        .patch('/api/transports/relays/relay-b')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ enabled: true });
      assert.strictEqual(res.status, 200);
    });

    function discover(as) {
      const r = request(app).post('/v4/control/discover');
      return (as ? r.set(nodeAuth(as)) : r.set('Authorization', `Bearer ${REGISTRATION_TOKEN}`)).send({ limit: 100 });
    }

    it('never hands out UDP endpoints through discover to a pair that may not use UDP', async () => {
      await db.pool.query("UPDATE nodes SET role = 'RELAY', endpoints = $2::jsonb WHERE id = $1", [
        b.id,
        JSON.stringify([{ ip_address: '203.0.113.9', port: 51820, protocol: 'udp', is_stun_discovered: false }])
      ]);
      try {
        await setOrgPolicy('org-default', ['udp', 'derp']);
        let found = (await discover(a.id)).body.bridges.find((x) => x.node_id === b.id);
        assert.ok(
          found && found.endpoints.length > 0,
          'baseline: UDP allowed, endpoints expected: ' + JSON.stringify(found)
        );
        await setOrgPolicy('org-default', ['derp']);
        const res = await discover(a.id);
        assert.strictEqual(res.status, 200);
        found = res.body.bridges.find((x) => x.node_id === b.id);
        assert.ok(found, 'the DERP pair is still a peer');
        assert.deepStrictEqual(found.endpoints, [], 'discover leaked UDP endpoints the pair may not use');
        // The fleet token names no node: no UDP endpoint of a node whose organisation
        // forbids UDP.
        found = (await discover(null)).body.bridges.find((x) => x.node_id === b.id);
        assert.ok(!found || found.endpoints.length === 0, 'fleet-token discover leaked UDP endpoints');
      } finally {
        await db.pool.query("UPDATE nodes SET role = 'CLIENT_ORIGIN' WHERE id = $1", [b.id]);
      }
    });

    it('refuses relay URLs the Go node would refuse, on create and on update', async () => {
      for (const url of [
        'https://relay-z.example.test/%zz',
        'https://relay-z.example.test:99999/derp',
        'https://relay-z.example.test:0/derp'
      ]) {
        const res = await request(app)
          .post('/api/transports/relays')
          .set('Authorization', `Bearer ${superToken}`)
          .send({ relay_id: 'relay-z', url });
        assert.strictEqual(res.status, 400, `accepted ${url}`);
      }
      const bad = await request(app)
        .patch('/api/transports/relays/relay-a')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ url: 'http://relay-a.example.test/derp' });
      assert.strictEqual(bad.status, 400);
      const before = await NetmapService.getVersion();
      const good = await request(app)
        .patch('/api/transports/relays/relay-a')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ url: 'https://relay-a.example.test:8443/derp%2Fv2' });
      assert.strictEqual(good.status, 200, JSON.stringify(good.body));
      assert.ok((await NetmapService.getVersion()) > before, 'a URL change did not move the version');
      await request(app)
        .patch('/api/transports/relays/relay-a')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ url: 'https://relay-a.example.test:8443/derp' });
    });

    it('does not lose a heartbeat over a transport report it cannot use', async () => {
      await heartbeat(app, b.id, homes('relay-a'));
      const stored = async () =>
        (await db.pool.query('SELECT relay_homes FROM nodes WHERE id = $1', [b.id])).rows[0].relay_homes.map(
          (h) => h.relay_id
        );
      // More homes than a node sends, or a version this control plane does not know:
      // the report is ignored, the beat (quarantine, revocation, credential) is not.
      let res = await heartbeat(app, b.id, homes('relay-b', 'relay-a', 'relay-c'));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.acknowledged, true);
      assert.deepStrictEqual(await stored(), ['relay-a']);
      res = await heartbeat(app, b.id, { transport_report_version: 'derp-v9', relay_homes: [] });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await stored(), ['relay-a']);
      // A fast clock is not a reason to withdraw a home: freshness is the server's clock.
      const fast = homes('relay-b');
      fast.relay_homes[0].observed_at_unix += 3600;
      res = await heartbeat(app, b.id, fast);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await stored(), ['relay-b']);
      const row = (await db.pool.query('SELECT relay_homes FROM nodes WHERE id = $1', [b.id])).rows[0];
      assert.ok(row.relay_homes[0].observed_at_unix <= Math.floor(Date.now() / 1000) + 1, 'a future time was stored');
    });

    it('gives a quarantined node no transport, relay or peer', async () => {
      await setOrgPolicy('org-default', ['udp', 'derp']);
      await db.pool.query('UPDATE nodes SET is_quarantined = TRUE WHERE id = $1', [a.id]);
      // Its credential is refused while quarantined, so the route never serves it; the
      // document itself must still carry nothing, in case anything else ever builds it.
      assert.strictEqual(
        (await request(app).post('/v4/control/netmap').set(nodeAuth(a.id)).send({ node_id: a.id, version: 0 })).status,
        403
      );
      const doc = await NetmapService.buildNetmap(a.id);
      assert.strictEqual(doc.transport_policy_version, 'derp-v2');
      assert.strictEqual(doc.allowed_transports, undefined);
      assert.strictEqual(doc.relay_candidates, undefined);
      assert.deepStrictEqual(doc.peers, []);
      // And it is gone from its peers' documents.
      assert.strictEqual(peer(await netmap(app, b.id), a.id), undefined);
    });

    it('drops unhealthy nodes and destroyed organisations from admission, and ignores expired revocations', async () => {
      await setOrgPolicy('org-default', ['derp']);
      await db.pool.query('UPDATE nodes SET is_healthy = FALSE WHERE id = $1', [b.id]);
      let keys = (await admission(app, relayCredentials['relay-a'])).body.keys;
      assert.ok(!keys.includes(b.key), 'an unhealthy node was admitted');
      assert.ok(keys.includes(a.key));
      await db.pool.query('UPDATE nodes SET is_healthy = TRUE');
      await db.pool.query(
        "INSERT INTO revoked_keys (public_key_hex, node_id, reason, revoked_at, expires_at) VALUES ($1, $2, 'old', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')",
        [b.key, b.id]
      );
      keys = (await admission(app, relayCredentials['relay-a'])).body.keys;
      assert.ok(keys.includes(b.key), 'an expired revocation still excluded the key');
      await setOrgPolicy('org-transport-b', ['derp']);
      assert.ok((await admission(app, relayCredentials['relay-a'])).body.keys.includes(foreign.key));
      await db.pool.query("UPDATE organizations SET destroyed_at = NOW() WHERE id = 'org-transport-b'");
      try {
        keys = (await admission(app, relayCredentials['relay-a'])).body.keys;
        assert.ok(!keys.includes(foreign.key), 'a destroyed organisation was admitted');
      } finally {
        await db.pool.query("UPDATE organizations SET destroyed_at = NULL WHERE id = 'org-transport-b'");
      }
    });

    it('marks credential responses as not cacheable and audits relay changes as platform events', async () => {
      const res = await request(app)
        .post('/api/transports/relays/relay-b/rotate-credential')
        .set('Authorization', `Bearer ${superToken}`);
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['cache-control'] || '', /no-store/);
      relayCredentials['relay-b'] = res.body.credential;
      await request(app)
        .patch('/api/transports/relays/relay-b')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ enabled: true });
      const rows = await db.pool.query(
        "SELECT event_type, organization_id FROM audit_events WHERE event_type IN ('TRANSPORT_RELAY_CREDENTIAL_ROTATED', 'TRANSPORT_RELAY_UPDATED') ORDER BY sequence_num"
      );
      assert.ok(
        rows.rows.some((r) => r.event_type === 'TRANSPORT_RELAY_CREDENTIAL_ROTATED'),
        'the rotation was not in the ledger when the response was sent'
      );
      assert.ok(rows.rows.some((r) => r.event_type === 'TRANSPORT_RELAY_UPDATED'));
      assert.ok(
        rows.rows.every((r) => r.organization_id === null),
        'relay events are platform events'
      );
    });

    it('reads a binary that carries DERP without the capability as UDP only', async () => {
      await setOrgPolicy('org-default', ['udp', 'derp']);
      const odd = await registerNode(app, { transports: ['udp', 'derp'], capabilities: [] });
      const doc = await netmap(app, a.id);
      assert.deepStrictEqual(peer(doc, odd.id).allowed_transports, ['udp']);
      assert.ok(!(await admission(app, relayCredentials['relay-a'])).body.keys.includes(odd.key));
      await db.pool.query("UPDATE nodes SET organization_id = 'org-transport-b' WHERE id = $1", [odd.id]);
    });

    it('stores an empty list as deny-all, distinct from the legacy UDP default', async () => {
      const res = await setOrgPolicy('org-default', []);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.allowed_transports, []);
      assert.deepStrictEqual(res.body.effective_transports, []);
      const doc = await netmap(app, a.id);
      assert.strictEqual(doc.transport_policy_version, 'derp-v2');
      assert.strictEqual(doc.allowed_transports, undefined, 'deny-all must be the absent list under the version');
      assert.deepStrictEqual(doc.peers, []);
      assert.deepStrictEqual((await netmap(app, legacy.id)).peers, []);
    });

    it('keeps another tenant out even when both allow the same transports', async () => {
      await setOrgPolicy('org-default', ['udp', 'derp']);
      await setOrgPolicy('org-transport-b', ['udp', 'derp']);
      const doc = await netmap(app, a.id);
      assert.strictEqual(peer(doc, foreign.id), undefined);
      assert.ok(!JSON.stringify(doc).includes(foreign.key));
    });

    it('drops quarantined and unhealthy peers from the document', async () => {
      await setOrgPolicy('org-default', ['udp', 'derp']);
      await heartbeat(app, b.id, homes('relay-a'));
      await db.pool.query('UPDATE nodes SET is_quarantined = TRUE WHERE id = $1', [b.id]);
      assert.strictEqual(peer(await netmap(app, a.id), b.id), undefined);
      await db.pool.query('UPDATE nodes SET is_quarantined = FALSE, is_healthy = FALSE WHERE id = $1', [b.id]);
      assert.strictEqual(peer(await netmap(app, a.id), b.id), undefined);
    });

    it('hides another organisation transport policy from its admins', async () => {
      const res = await request(app)
        .get('/api/organizations/org-transport-b/transports')
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(res.status, 404);
    });

    it('keeps homes alive while they are reported and brings expired ones back on the next report', async () => {
      await setOrgPolicy('org-default', ['udp', 'derp']);
      await heartbeat(app, b.id, homes('relay-a'));
      await db.pool.query(
        'UPDATE nodes SET relay_homes_reported_at = NOW() - make_interval(secs => $2) WHERE id = $1',
        [b.id, 90]
      );
      await heartbeat(app, b.id, homes('relay-a'));
      const row = (await db.pool.query('SELECT relay_homes_reported_at FROM nodes WHERE id = $1', [b.id])).rows[0];
      assert.ok(
        Date.now() - new Date(row.relay_homes_reported_at).getTime() < 10000,
        'a home still being reported was not refreshed'
      );
      await db.pool.query("UPDATE nodes SET relay_homes_reported_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [b.id]);
      const before = await NetmapService.getVersion();
      await heartbeat(app, b.id, homes('relay-a'));
      assert.ok((await NetmapService.getVersion()) > before, 'a home back from expiry did not move the version');
      assert.deepStrictEqual(
        peer(await netmap(app, a.id), b.id).relay_homes.map((h) => h.relay_id),
        ['relay-a']
      );
    });
  });
});
