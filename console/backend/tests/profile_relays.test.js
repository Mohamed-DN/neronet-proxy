/**
 * D21b: the Noise JSON profile lists the relays the installation really runs (the
 * enabled rows of transport_relays), never a made-up list. With none configured the
 * list is empty.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { getPgPool } = require('../db/index');
const { createApp } = require('../server');
const config = require('../config/env');
const { buildNoiseJsonProfile } = require('../utils/crypto');

const profileArgs = () => ({
  nodeId: 'svrn-node-test',
  privateKeyHex: '00'.repeat(32),
  publicKeyHex: '11'.repeat(32),
  overlayIpv4: '100.64.0.10',
  overlayIpv6: 'fd7a:115c:a1e0::a',
  presharedKeyHex: '22'.repeat(32)
});

describe('D21b buildNoiseJsonProfile relays', () => {
  test('no relays given means an empty list', () => {
    assert.deepStrictEqual(buildNoiseJsonProfile(profileArgs()).relays, []);
  });

  test('given relays are listed by id and url only', () => {
    const relays = [{ relay_id: 'relay-a', url: 'https://relay-a.example.com/derp', capability: 'derp-v2', extra: 1 }];
    assert.deepStrictEqual(buildNoiseJsonProfile({ ...profileArgs(), relays }).relays, [
      { relay_id: 'relay-a', url: 'https://relay-a.example.com/derp' }
    ]);
  });

  test('source carries no invented relay hostnames', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'crypto.js'), 'utf8');
    assert.ok(!/relay-us.|relay-eu.|relay-ap.|relay-oci|relay-hetzner|ashburn|ap-tokyo/.test(src));
  });
});

describe('D21b /api/configs/generate relays', () => {
  let dbHelper;
  let app;
  let token;
  let savedKey;
  let savedEndpoint;
  const generate = () =>
    request(app).post('/api/configs/generate').set('Authorization', `Bearer ${token}`).send({ name: 'D21b-Node' });

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();
    savedKey = config.SERVER_PUBKEY;
    savedEndpoint = config.SERVER_ENDPOINT;
    config.SERVER_PUBKEY = crypto.randomBytes(32).toString('base64');
    config.SERVER_ENDPOINT = 'vpn.example.com:51820';
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin_password' });
    token = res.body.token;
  });
  after(async () => {
    config.SERVER_PUBKEY = savedKey;
    config.SERVER_ENDPOINT = savedEndpoint;
    if (dbHelper) await dbHelper.cleanup();
  });

  test('empty when no relay is configured', async () => {
    const res = await generate();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.json_profile.relays, []);
  });

  test('lists enabled configured relays and skips disabled ones', async () => {
    const pool = getPgPool();
    const ins = (id, url, enabled) =>
      pool.query('INSERT INTO transport_relays (relay_id, url, credential_hash, enabled) VALUES ($1, $2, $3, $4)', [
        id,
        url,
        crypto.createHash('sha256').update(id).digest('hex'),
        enabled
      ]);
    await ins('relay-a', 'https://relay-a.example.com/derp', true);
    await ins('relay-off', 'https://relay-off.example.com/derp', false);
    const res = await generate();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.json_profile.relays, [
      { relay_id: 'relay-a', url: 'https://relay-a.example.com/derp' }
    ]);
  });
});
