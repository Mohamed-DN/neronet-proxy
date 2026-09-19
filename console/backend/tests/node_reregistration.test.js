const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');

const testDbPath = path.resolve(__dirname, '../../data/test_node_reregistration.db');
process.env.SOVEREIGN_DB_PATH = testDbPath;

const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

const { getDatabase, closeDatabase } = require('../db/index');
const { runMigrations } = require('../db/migrator');
const { seedDatabase } = require('../db/seed');
const { createApp } = require('../server');

/**
 * Registration is authenticated by one fleet-wide token and public keys are not
 * secret, so anyone holding the token could re-register somebody else's key and
 * rewrite that node's role -- to EXIT_BRIDGE, for example -- and its country. Until
 * WP-103 makes a node prove possession of its key, re-registration keeps the stored
 * role, ip_class and country_code and records the attempt.
 */

const PUBKEY = 'd'.repeat(64);
const PUBKEY_REENROL = 'e'.repeat(64);

function registerBody(publicKeyHex, { role, country, ipClass, endpoints }) {
  return {
    public_key_hex: publicKeyHex,
    role,
    endpoints: endpoints || [],
    client_version: '4.0.0',
    capability: { enabled: true, country_code: country, ip_class: ipClass }
  };
}

function register(app, body) {
  return request(app).post('/v4/control/register').set('Authorization', `Bearer ${REGISTRATION_TOKEN}`).send(body);
}

function storedNode(nodeId) {
  return getDatabase()
    .prepare('SELECT role, ip_class, country_code, endpoints, is_healthy FROM nodes WHERE id = ?')
    .get(nodeId);
}

function mismatchEvents() {
  return getDatabase()
    .prepare("SELECT * FROM audit_events WHERE event_type = 'node.reregister_mismatch' ORDER BY id")
    .all();
}

describe('Node re-registration', () => {
  let app;
  let nodeId;

  before(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    const db = getDatabase(testDbPath);
    runMigrations(db);
    seedDatabase(db);
    app = createApp();

    const first = await register(
      app,
      registerBody(PUBKEY, { role: 'CLIENT_ORIGIN', country: 'DE', ipClass: 'RESIDENTIAL' })
    );
    assert.strictEqual(first.status, 200, `registration failed: ${JSON.stringify(first.body)}`);
    nodeId = first.body.assigned_node_id;
  });

  after(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${testDbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('keeps the stored role, ip class and country when a known key asks for different ones', async () => {
    const res = await register(
      app,
      registerBody(PUBKEY, {
        role: 'EXIT_BRIDGE',
        country: 'RU',
        ipClass: 'DATACENTER',
        endpoints: ['203.0.113.7:51820']
      })
    );

    assert.strictEqual(res.status, 200);

    const stored = storedNode(nodeId);
    assert.strictEqual(stored.role, 'CLIENT_ORIGIN', 'role was rewritten by an unproven re-registration');
    assert.strictEqual(stored.country_code, 'DE', 'country was rewritten by an unproven re-registration');
    assert.strictEqual(stored.ip_class, 'RESIDENTIAL', 'ip class was rewritten by an unproven re-registration');
  });

  it('still updates the fields a node legitimately reports', async () => {
    const stored = storedNode(nodeId);

    // Endpoints change whenever the node moves; health and updated_at are what a
    // re-registration is for.
    assert.deepStrictEqual(JSON.parse(stored.endpoints), ['203.0.113.7:51820']);
    assert.ok(stored.is_healthy, 'a re-registered node must be marked healthy');
  });

  it('records one audit event naming the stored and the requested values', () => {
    const events = mismatchEvents();

    assert.strictEqual(events.length, 1, `expected exactly one mismatch event, found ${events.length}`);

    const event = events[0];
    assert.strictEqual(event.target_id, nodeId);

    const metadata = JSON.parse(event.metadata_json);
    assert.deepStrictEqual(metadata.stored, {
      role: 'CLIENT_ORIGIN',
      ip_class: 'RESIDENTIAL',
      country_code: 'DE'
    });
    assert.deepStrictEqual(metadata.requested, {
      role: 'EXIT_BRIDGE',
      ip_class: 'DATACENTER',
      country_code: 'RU'
    });
  });

  it('records nothing when the re-registration asks for the values already stored', async () => {
    const before = mismatchEvents().length;

    const res = await register(
      app,
      registerBody(PUBKEY, {
        role: 'CLIENT_ORIGIN',
        country: 'DE',
        ipClass: 'RESIDENTIAL',
        endpoints: ['203.0.113.7:51820']
      })
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(mismatchEvents().length, before, 'an unchanged re-registration is not a mismatch');
  });

  it('keeps a stored country when only the country differs', async () => {
    const before = mismatchEvents().length;

    const res = await register(
      app,
      registerBody(PUBKEY, { role: 'CLIENT_ORIGIN', country: 'CN', ipClass: 'RESIDENTIAL' })
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(storedNode(nodeId).country_code, 'DE');

    // Country alone decides what geofencing allows, so it is worth its own case:
    // the fields are compared one by one, not as a set.
    const events = mismatchEvents();
    assert.strictEqual(events.length, before + 1);
    assert.deepStrictEqual(JSON.parse(events[events.length - 1].metadata_json).changed, ['country_code']);
  });

  it('keeps the address a re-registering node already holds', async () => {
    const first = await register(app, registerBody(PUBKEY, { role: 'CLIENT_ORIGIN', country: 'DE' }));
    const second = await register(app, registerBody(PUBKEY, { role: 'CLIENT_ORIGIN', country: 'DE' }));

    assert.strictEqual(first.body.overlay_ipv4, second.body.overlay_ipv4);
  });

  it('re-enrols a node whose row was deleted and gives it an address', async () => {
    const created = await register(app, registerBody(PUBKEY_REENROL, { role: 'RELAY', country: 'FR' }));
    assert.strictEqual(created.status, 200);

    // The legitimate path cmd/sovereign-node/main.go takes when the control plane
    // no longer knows it: same key, no row, must enrol again.
    getDatabase().prepare('DELETE FROM nodes WHERE id = ?').run(created.body.assigned_node_id);

    const again = await register(app, registerBody(PUBKEY_REENROL, { role: 'RELAY', country: 'FR' }));

    assert.strictEqual(again.status, 200);
    assert.match(again.body.overlay_ipv4, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./);

    const stored = storedNode(again.body.assigned_node_id);
    assert.strictEqual(stored.role, 'RELAY', 'a fresh enrolment must store the role the node asks for');
    assert.strictEqual(stored.country_code, 'FR');
  });
});
