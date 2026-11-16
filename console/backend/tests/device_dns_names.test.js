// ADR 0034, phase 2: a profile device's mesh name is stored, unique in its organisation, and
// the backfill of migration 053 gives existing rows the same names registration would.
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { nodeKey, register: enrolNode } = require('./helpers/nodeEnrolment');
const { createApp } = require('../server');
const NetmapService = require('../services/NetmapService');
const DeviceNameService = require('../services/DeviceNameService');

const ORG = 'org-ddn';
const OTHER = 'org-ddn-other';
const SD = 'ddn.example.com';
const key = () => crypto.randomBytes(32).toString('base64');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '053_device_dns_names.sql'), 'utf8');

describe('unique device names (ADR 0034 phase 2)', () => {
  let db;
  let pool;
  let app;
  let admin;
  let gateway;

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    for (const [id, slug, sd] of [
      [ORG, 'ddn', SD],
      [OTHER, 'ddno', 'other.example.com']
    ]) {
      await pool.query(
        `INSERT INTO organizations (id, name, slug, search_domain, default_policy) VALUES ($1, $2, $2, $3, 'deny')`,
        [id, slug, sd]
      );
    }
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ('usr-ddn-admin', 'ddnadmin', 'a@ddn.local', 'x', 'admin', $1)`,
      [ORG]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES ('mem-ddn-admin', 'usr-ddn-admin', $1, 'admin')`,
      [ORG]
    );
    admin = await issueConsoleTestToken({
      sub: 'usr-ddn-admin',
      id: 'usr-ddn-admin',
      username: 'ddnadmin',
      role: 'admin',
      organization_id: ORG
    });
    const res = await enrolNode(app, { public_key_hex: nodeKey(), role: 'CLIENT_ORIGIN', endpoints: [] });
    gateway = res.body.assigned_node_id;
    await pool.query('UPDATE nodes SET organization_id = $1, name = $2 WHERE id = $3', [ORG, 'office', gateway]);
    const gw = await request(app)
      .put('/api/devices/gateway')
      .set(auth(admin))
      .send({ node_id: gateway, endpoint: 'office.example.com:51820' });
    assert.equal(gw.status, 200, JSON.stringify(gw.body));
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  const register = (name) =>
    request(app).post('/api/devices/profile').set(auth(admin)).send({ name, public_key: key(), preshared_key: key() });
  const stored = async (id) => (await pool.query('SELECT dns_name FROM nodes WHERE id = $1', [id])).rows[0].dns_name;

  it('two devices named Phone get phone.<sd> and phone-2.<sd>, and the netmap lists exactly those', async () => {
    const a = await register('Phone');
    const b = await register('Phone');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(await stored(a.body.device_id), `phone.${SD}`);
    assert.equal(await stored(b.body.device_id), `phone-2.${SD}`);
    const netmap = await NetmapService.buildNetmap(gateway);
    const nameOf = (id) => netmap.peers.find((p) => p.node_id === id).dns_name;
    assert.equal(nameOf(a.body.device_id), `phone.${SD}`);
    assert.equal(nameOf(b.body.device_id), `phone-2.${SD}`);
  });

  it('skips a suffix that is already taken by a device literally named so', async () => {
    const two = await register('laptop-2');
    const first = await register('laptop');
    const second = await register('laptop');
    assert.equal(await stored(two.body.device_id), `laptop-2.${SD}`);
    assert.equal(await stored(first.body.device_id), `laptop.${SD}`);
    assert.equal(await stored(second.body.device_id), `laptop-3.${SD}`);
  });

  it('slugs spaces, accents and symbols; a name of only symbols gets none', async () => {
    const cafe = await register("  Café Léa's   Phone!! ");
    assert.equal(await stored(cafe.body.device_id), `cafe-lea-s-phone.${SD}`);
    const accents = await register('Àèì òù');
    assert.equal(await stored(accents.body.device_id), `aei-ou.${SD}`);
    const symbols = await register('!!!');
    assert.equal(symbols.status, 201, JSON.stringify(symbols.body));
    assert.equal(await stored(symbols.body.device_id), null);
  });

  it('keeps a label within 63 characters, also with a suffix', async () => {
    const long = 'x'.repeat(64);
    const a = await register(long);
    const b = await register(long);
    const label = (n) => n.split('.')[0];
    assert.equal(label(await stored(a.body.device_id)).length, 63);
    const second = label(await stored(b.body.device_id));
    assert.equal(second.length, 63);
    assert.ok(second.endsWith('-2'));
  });

  it('is unique per organisation only: the same name elsewhere is fine', async () => {
    await register('shared-name');
    const insert = (id, ip) =>
      pool.query(
        `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6, role, ip_class, is_healthy, is_quarantined, organization_id, dns_name)
         VALUES ($1, 'usr-ddn-admin', 'x', $2, $3, 'fd7a:115c:a1e0:9::' || $6::text, 'CLIENT_ORIGIN', 'UNKNOWN', TRUE, FALSE, $4, $5)`,
        [id, crypto.randomBytes(32).toString('hex'), ip, OTHER, `shared-name.${SD}`, ip.split('.').pop()]
      );
    await insert('n-ddn-o1', '100.64.9.1');
    await assert.rejects(
      insert('n-ddn-o2', '100.64.9.2'),
      (err) => err.code === '23505' && err.constraint === DeviceNameService.DNS_NAME_INDEX
    );
  });

  it('retries with the next suffix when the unique index refuses the insert, never failing', async () => {
    const statements = [];
    const clash = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint: DeviceNameService.DNS_NAME_INDEX
    });
    const client = {
      query: async (sql) => {
        statements.push(String(sql).split(' ')[0]);
        return { rows: [] };
      }
    };
    const inserted = [];
    const name = await DeviceNameService.insertWithDnsName(
      client,
      { organizationId: ORG, name: 'Phone', searchDomain: SD },
      async (dnsName) => {
        inserted.push(dnsName);
        if (inserted.length === 1) throw clash;
      }
    );
    assert.deepEqual(inserted, [`phone.${SD}`, `phone-2.${SD}`]);
    assert.equal(name, `phone-2.${SD}`);
    assert.ok(statements.includes('ROLLBACK'), 'only the failed statement is undone');

    // Another unique violation (the key) is not ours to retry.
    await assert.rejects(
      DeviceNameService.insertWithDnsName(client, { organizationId: ORG, name: 'Phone', searchDomain: SD }, async () => {
        throw Object.assign(new Error('key clash'), { code: '23505', constraint: 'nodes_public_key_key' });
      }),
      /key clash/
    );
  });

  describe('migration 053 backfill', () => {
    const insertRow = (id, name, createdAt, dnsName = null, kind = 'profile') =>
      pool.query(
        `INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6, role, ip_class, is_healthy,
                            is_quarantined, organization_id, device_kind, dns_name, created_at)
         VALUES ($1, 'usr-ddn-admin', $2, $3, $4, 'fd7a:115c:a1e0:8::' || $9::text, 'CLIENT_ORIGIN', 'UNKNOWN', TRUE, FALSE, $5, $6, $7, $8)`,
        [id, name, crypto.randomBytes(32).toString('hex'), `100.66.0.${nextIp}`, OTHER, kind, dnsName, createdAt, `66${nextIp++}`]
      );
    let nextIp = 1;
    const names = async (ids) =>
      Object.fromEntries(
        (await pool.query('SELECT id, dns_name FROM nodes WHERE id = ANY($1)', [ids])).rows.map((r) => [r.id, r.dns_name])
      );

    it('names old rows with the registration rule, resolves collisions by age then id, then enforces uniqueness', async () => {
      await pool.query('DROP INDEX IF EXISTS idx_nodes_org_dns_name_unique');
      await pool.query('DELETE FROM nodes WHERE organization_id = $1', [OTHER]);
      // bf-2a and bf-2b share a created_at: the id breaks the tie.
      await insertRow('bf-3', 'Phone', '2026-01-03T00:00:00Z');
      await insertRow('bf-2b', 'Phone', '2026-01-02T00:00:00Z');
      await insertRow('bf-2a', 'Phone', '2026-01-02T00:00:00Z');
      await insertRow('bf-1', 'PHONE', '2026-01-01T00:00:00Z');
      await insertRow('bf-acc', 'Café du Matin', '2026-01-04T00:00:00Z');
      await insertRow('bf-sym', '???', '2026-01-05T00:00:00Z');
      await insertRow('bf-dup1', 'x', '2026-01-01T00:00:00Z', 'srv.other.example.com', 'mesh');
      await insertRow('bf-dup2', 'y', '2026-01-02T00:00:00Z', 'srv.other.example.com', 'mesh');
      await insertRow('bf-kept', 'Kept', '2026-01-06T00:00:00Z', 'custom.other.example.com');
      await pool.query('UPDATE organizations SET search_domain = NULL WHERE id = $1', [OTHER]);

      await pool.query(MIGRATION);

      const ids = ['bf-1', 'bf-2a', 'bf-2b', 'bf-3', 'bf-acc', 'bf-sym', 'bf-dup1', 'bf-dup2', 'bf-kept'];
      const got = await names(ids);
      assert.deepEqual(got, {
        'bf-1': 'phone.ddno.neronet',
        'bf-2a': 'phone-2.ddno.neronet',
        'bf-2b': 'phone-3.ddno.neronet',
        'bf-3': 'phone-4.ddno.neronet',
        'bf-acc': 'cafe-du-matin.ddno.neronet',
        'bf-sym': null,
        'bf-dup1': 'srv.other.example.com',
        'bf-dup2': 'srv-2.other.example.com',
        'bf-kept': 'custom.other.example.com'
      });
      const index = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_nodes_org_dns_name_unique'");
      assert.equal(index.rows.length, 1);

      // Running it again changes nothing.
      await pool.query(MIGRATION);
      assert.deepEqual(await names(ids), got);
    });
  });
});
