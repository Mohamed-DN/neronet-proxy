const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');

const REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
process.env.SOVEREIGN_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

const { setupTestDatabase } = require('./helpers/db');
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

let dbHelper;

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

async function storedNode(nodeId) {
  const res = await dbHelper.pool.query(
    'SELECT role, ip_class, country_code, endpoints, is_healthy FROM nodes WHERE id = $1',
    [nodeId]
  );
  return res.rows[0];
}

async function mismatchEvents() {
  const res = await dbHelper.pool.query(
    "SELECT * FROM audit_events WHERE event_type = 'node.reregister_mismatch' ORDER BY id"
  );
  return res.rows;
}

describe('Node re-registration', () => {
  let app;
  let nodeId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();

    const first = await register(
      app,
      registerBody(PUBKEY, { role: 'CLIENT_ORIGIN', country: 'DE', ipClass: 'RESIDENTIAL' })
    );
    assert.strictEqual(first.status, 200, `registration failed: ${JSON.stringify(first.body)}`);
    nodeId = first.body.assigned_node_id;
  });

  after(async () => {
    if (dbHelper) {
      await dbHelper.cleanup();
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

    const stored = await storedNode(nodeId);
    assert.strictEqual(stored.role, 'CLIENT_ORIGIN', 'role was rewritten by an unproven re-registration');
    assert.strictEqual(stored.country_code, 'DE', 'country was rewritten by an unproven re-registration');
    assert.strictEqual(stored.ip_class, 'RESIDENTIAL', 'ip class was rewritten by an unproven re-registration');
  });

  it('still updates the fields a node legitimately reports', async () => {
    const stored = await storedNode(nodeId);

    // Endpoints change whenever the node moves; health and updated_at are what a
    // re-registration is for.
    const ep = typeof stored.endpoints === 'string' ? JSON.parse(stored.endpoints) : stored.endpoints;
    assert.deepStrictEqual(ep, ['203.0.113.7:51820']);
    assert.ok(stored.is_healthy, 'a re-registered node must be marked healthy');
  });

  it('records one audit event naming the stored and the requested values', async () => {
    const events = await mismatchEvents();

    assert.strictEqual(events.length, 1, `expected exactly one mismatch event, found ${events.length}`);

    const event = events[0];
    assert.strictEqual(event.target_id, nodeId);

    const metadata = typeof event.metadata_json === 'string' ? JSON.parse(event.metadata_json) : event.metadata_json;
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
    const before = (await mismatchEvents()).length;

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
    assert.strictEqual((await mismatchEvents()).length, before, 'an unchanged re-registration is not a mismatch');
  });

  it('keeps a stored country when only the country differs', async () => {
    const before = (await mismatchEvents()).length;

    const res = await register(
      app,
      registerBody(PUBKEY, { role: 'CLIENT_ORIGIN', country: 'CN', ipClass: 'RESIDENTIAL' })
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await storedNode(nodeId)).country_code, 'DE');

    // Country alone decides what geofencing allows, so it is worth its own case:
    // the fields are compared one by one, not as a set.
    const events = await mismatchEvents();
    assert.strictEqual(events.length, before + 1);
    const meta =
      typeof events[events.length - 1].metadata_json === 'string'
        ? JSON.parse(events[events.length - 1].metadata_json)
        : events[events.length - 1].metadata_json;
    assert.deepStrictEqual(meta.changed, ['country_code']);
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
    await dbHelper.pool.query('DELETE FROM nodes WHERE id = $1', [created.body.assigned_node_id]);

    const again = await register(app, registerBody(PUBKEY_REENROL, { role: 'RELAY', country: 'FR' }));

    assert.strictEqual(again.status, 200);
    assert.match(again.body.overlay_ipv4, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./);

    const stored = await storedNode(again.body.assigned_node_id);
    assert.strictEqual(stored.role, 'RELAY', 'a fresh enrolment must store the role the node asks for');
    assert.strictEqual(stored.country_code, 'FR');
  });
});
