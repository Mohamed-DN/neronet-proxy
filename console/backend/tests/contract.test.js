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
const { validateResponse, validators } = require('../middleware/contractValidator');

const FIXTURES_DIR = path.resolve(__dirname, '../../../api/contract/v4/fixtures');

const ALL_TYPES = [
  'RegisterRequest',
  'RegisterResponse',
  'HeartbeatRequest',
  'HeartbeatResponse',
  'DiscoverRequest',
  'DiscoverResponse',
  'CircuitRequest',
  'CircuitResponse',
  'ACLSyncRequest',
  'ACLSyncResponse',
  'RouteSyncRequest',
  'RouteSyncResponse',
  'NetmapRequest',
  'NetmapResponse'
];

describe('Contract Schema Compilation and Shared Fixtures', () => {
  it('has compiled validators for all 14 contract types', () => {
    assert.strictEqual(validators.size >= 14, true);
    for (const typeName of ALL_TYPES) {
      assert.ok(validators.has(typeName), `missing validator for ${typeName}`);
    }
  });

  for (const typeName of ALL_TYPES) {
    it(`validates shared fixture ${typeName}.json against schema`, () => {
      const fixturePath = path.join(FIXTURES_DIR, `${typeName}.json`);
      assert.ok(fs.existsSync(fixturePath), `fixture missing: ${fixturePath}`);
      const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      const val = validateResponse(typeName, data);
      assert.strictEqual(val.valid, true, `fixture ${typeName}.json failed schema: ${val.pointer} ${val.message}`);
    });
  }
});

describe('Wire contract enforcement on /v4/control/* endpoints', () => {
  let dbHelper;
  let app;
  const AUTH = { Authorization: `Bearer ${REGISTRATION_TOKEN}` };

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('Valid request fixtures succeed against real handlers', () => {
    let registeredNodeId;

    it('POST /v4/control/register with RegisterRequest.json', async () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'RegisterRequest.json'), 'utf8'));
      const res = await request(app).post('/v4/control/register').set(AUTH).send(fixture);

      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      registeredNodeId = res.body.assigned_node_id;

      // Validate response against RegisterResponse schema
      const val = validateResponse('RegisterResponse', res.body);
      assert.strictEqual(val.valid, true, `${val.pointer} ${val.message}`);
    });

    it('POST /v4/control/heartbeat with HeartbeatRequest.json', async () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'HeartbeatRequest.json'), 'utf8'));
      fixture.node_id = registeredNodeId;
      const res = await request(app).post('/v4/control/heartbeat').set(AUTH).send(fixture);

      assert.strictEqual(res.status, 200, JSON.stringify(res.body));

      const val = validateResponse('HeartbeatResponse', res.body);
      assert.strictEqual(val.valid, true, `${val.pointer} ${val.message}`);
    });

    it('POST /v4/control/discover with DiscoverRequest.json', async () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'DiscoverRequest.json'), 'utf8'));
      const res = await request(app).post('/v4/control/discover').set(AUTH).send(fixture);

      assert.strictEqual(res.status, 200, JSON.stringify(res.body));

      const val = validateResponse('DiscoverResponse', res.body);
      assert.strictEqual(val.valid, true, `${val.pointer} ${val.message}`);
    });

    it('POST /v4/control/circuit with CircuitRequest.json', async () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'CircuitRequest.json'), 'utf8'));
      const res = await request(app).post('/v4/control/circuit').set(AUTH).send(fixture);

      // Either 200 or 503 (if test db has fewer than 3 distinct relays for diversity)
      assert.ok([200, 503].includes(res.status));
      if (res.status === 200) {
        const val = validateResponse('CircuitResponse', res.body);
        assert.strictEqual(val.valid, true, `${val.pointer} ${val.message}`);
      }
    });

    it('POST /v4/control/sync-acls with ACLSyncRequest.json', async () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'ACLSyncRequest.json'), 'utf8'));
      fixture.node_id = registeredNodeId;
      const res = await request(app).post('/v4/control/sync-acls').set(AUTH).send(fixture);

      assert.strictEqual(res.status, 200, JSON.stringify(res.body));

      const val = validateResponse('ACLSyncResponse', res.body);
      assert.strictEqual(val.valid, true, `${val.pointer} ${val.message}`);
    });

    it('POST /v4/control/sync-routes with RouteSyncRequest.json', async () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'RouteSyncRequest.json'), 'utf8'));
      fixture.node_id = registeredNodeId;
      const res = await request(app).post('/v4/control/sync-routes').set(AUTH).send(fixture);

      assert.strictEqual(res.status, 200, JSON.stringify(res.body));

      const val = validateResponse('RouteSyncResponse', res.body);
      assert.strictEqual(val.valid, true, `${val.pointer} ${val.message}`);
    });

    it('POST /v4/control/netmap with NetmapRequest.json', async () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'NetmapRequest.json'), 'utf8'));
      fixture.node_id = registeredNodeId;
      const res = await request(app).post('/v4/control/netmap').set(AUTH).send(fixture);

      assert.strictEqual(res.status, 200, JSON.stringify(res.body));

      const val = validateResponse('NetmapResponse', res.body);
      assert.strictEqual(val.valid, true, `${val.pointer} ${val.message}`);
    });
  });

  describe('Strict 400 Bad Request with RFC 6901 JSON pointer on invalid inputs', () => {
    it('/register rejects missing public_key_hex with pointer /public_key_hex', async () => {
      const res = await request(app).post('/v4/control/register').set(AUTH).send({});

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/public_key_hex');
    });

    it('/register rejects wrong type for public_key_hex with pointer /public_key_hex', async () => {
      const res = await request(app).post('/v4/control/register').set(AUTH).send({ public_key_hex: 12345 });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/public_key_hex');
    });

    it('/register rejects wrong nested type capability.asn with pointer /capability/asn', async () => {
      const res = await request(app)
        .post('/v4/control/register')
        .set(AUTH)
        .send({
          public_key_hex: 'a'.repeat(64),
          capability: { asn: 'invalid-asn-string' }
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/capability/asn');
    });

    it('/register rejects additional properties with pointer /unexpected_field', async () => {
      const res = await request(app)
        .post('/v4/control/register')
        .set(AUTH)
        .send({
          public_key_hex: 'a'.repeat(64),
          unexpected_field: 'unwanted'
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/unexpected_field');
    });

    it('/heartbeat rejects missing node_id with pointer /node_id', async () => {
      const res = await request(app).post('/v4/control/heartbeat').set(AUTH).send({});

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/node_id');
    });

    it('/heartbeat rejects wrong type for cpu_usage_pct with pointer /cpu_usage_pct', async () => {
      const res = await request(app).post('/v4/control/heartbeat').set(AUTH).send({
        node_id: 'pk_1234567890abcdef',
        cpu_usage_pct: 'not-a-number'
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/cpu_usage_pct');
    });

    it('/heartbeat rejects wrong nested type posture.is_rootless with pointer /posture/is_rootless', async () => {
      const res = await request(app)
        .post('/v4/control/heartbeat')
        .set(AUTH)
        .send({
          node_id: 'pk_1234567890abcdef',
          posture: {
            node_id: 'pk_1234567890abcdef',
            os_name: 'linux',
            os_version: '12',
            client_version: 'v4.0.0',
            country_code: 'IT',
            asn: 0,
            disk_encrypted: null,
            firewall_active: null,
            timestamp_utc: new Date().toISOString(),
            is_rootless: 'should-be-boolean'
          }
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/posture/is_rootless');
    });

    it('/discover rejects non-number limit with pointer /limit', async () => {
      const res = await request(app).post('/v4/control/discover').set(AUTH).send({
        limit: 'twenty'
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/limit');
    });

    it('/circuit rejects missing target_country with pointer /target_country', async () => {
      const res = await request(app).post('/v4/control/circuit').set(AUTH).send({});

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/target_country');
    });

    it('/circuit rejects non-integer hop_count with pointer /hop_count', async () => {
      const res = await request(app).post('/v4/control/circuit').set(AUTH).send({
        target_country: 'US',
        hop_count: 'three'
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/hop_count');
    });

    it('/sync-acls rejects missing node_id with pointer /node_id', async () => {
      const res = await request(app).post('/v4/control/sync-acls').set(AUTH).send({});

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/node_id');
    });

    it('/sync-acls rejects non-integer policy_epoch with pointer /policy_epoch', async () => {
      const res = await request(app).post('/v4/control/sync-acls').set(AUTH).send({
        node_id: 'pk_test',
        policy_epoch: 'epoch-one'
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/policy_epoch');
    });

    it('/sync-routes rejects missing node_id with pointer /node_id', async () => {
      const res = await request(app).post('/v4/control/sync-routes').set(AUTH).send({});

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/node_id');
    });

    it('/sync-routes rejects non-integer route_epoch with pointer /route_epoch', async () => {
      const res = await request(app).post('/v4/control/sync-routes').set(AUTH).send({
        node_id: 'pk_test',
        route_epoch: 'epoch-two'
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/route_epoch');
    });

    it('/netmap rejects missing node_id with pointer /node_id', async () => {
      const res = await request(app).post('/v4/control/netmap').set(AUTH).send({});

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/node_id');
    });

    it('/netmap rejects non-integer version with pointer /version', async () => {
      const res = await request(app).post('/v4/control/netmap').set(AUTH).send({
        node_id: 'pk_test',
        version: 'version-one'
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.pointer, '/version');
    });
  });

  describe('Response validation assertions in test environment', () => {
    it('validateResponse detects schema compliance on valid response', () => {
      const res = validateResponse('HeartbeatResponse', {
        acknowledged: true,
        force_rekey: false,
        drain_and_exit: false,
        revoked_keys: [],
        is_quarantined: false,
        policy_epoch: 1,
        route_epoch: 1,
        netmap_version: 1
      });
      assert.strictEqual(res.valid, true);
    });

    it('validateResponse flags non-compliant response with failing pointer', () => {
      const res = validateResponse('HeartbeatResponse', {
        acknowledged: 'not-a-bool',
        force_rekey: false,
        drain_and_exit: false,
        revoked_keys: [],
        is_quarantined: false,
        policy_epoch: 1,
        route_epoch: 1,
        netmap_version: 1
      });
      assert.strictEqual(res.valid, false);
      assert.strictEqual(res.pointer, '/acknowledged');
    });
  });
});
