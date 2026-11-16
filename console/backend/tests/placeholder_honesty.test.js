/**
 * D21: nothing that looks like a real credential or artefact may be a placeholder.
 * A profile without a real server key, a QR that is not a QR, a header that names
 * the wrong profile type are all refused or corrected here.
 */
const { describe, test, before, after, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const QRCode = require('qrcode');

const { setupTestDatabase } = require('./helpers/db');
const { getPgPool } = require('../db/index');
const { createApp } = require('../server');
const config = require('../config/env');
const { buildWireGuardConfig, generateQrCodeDataUrl, generateCurve25519Keypair } = require('../utils/crypto');

const PLACEHOLDER = 'NeroNetServerMasterPublicKeyBase64Placeholder=';
const ENDPOINT = 'vpn.example.com:51820';
const REAL_KEY = crypto.randomBytes(32).toString('base64');

const baseArgs = () => ({
  deviceName: 'Test',
  role: 'CLIENT_ORIGIN',
  privateKeyBase64: generateCurve25519Keypair().privateKeyBase64,
  overlayIpv4: '100.64.0.10',
  overlayIpv6: 'fd7a:115c:a1e0::a'
});

describe('D21 placeholders are never served', () => {
  let savedKey;
  let savedEndpoint;
  before(() => {
    savedKey = config.SERVER_PUBKEY;
    savedEndpoint = config.SERVER_ENDPOINT;
    config.SERVER_ENDPOINT = ENDPOINT;
  });
  after(() => {
    config.SERVER_PUBKEY = savedKey;
    config.SERVER_ENDPOINT = savedEndpoint;
  });

  test('config default endpoint is not a made-up relay host', () => {
    assert.ok(!/neronet\.darknero/.test(String(savedEndpoint)));
  });

  test('buildWireGuardConfig refuses without a server endpoint', () => {
    config.SERVER_PUBKEY = REAL_KEY;
    try {
      for (const bad of ['', 'vpn.example.com', 'vpn.example.com:0', 'vpn.example.com:99999', ':51820', 'a b:51820']) {
        config.SERVER_ENDPOINT = bad;
        assert.throws(
          () => buildWireGuardConfig(baseArgs()),
          (err) => err.status === 503 && err.code === 'server_endpoint_missing',
          `endpoint ${JSON.stringify(bad)}`
        );
      }
    } finally {
      config.SERVER_ENDPOINT = ENDPOINT;
    }
  });

  test('buildWireGuardConfig uses the configured endpoint', () => {
    config.SERVER_PUBKEY = REAL_KEY;
    assert.ok(buildWireGuardConfig(baseArgs()).includes(`Endpoint = ${ENDPOINT}`));
  });

  test('config default is never the placeholder', () => {
    assert.notStrictEqual(config.SERVER_PUBKEY, PLACEHOLDER);
  });

  test('buildWireGuardConfig refuses without a server key', () => {
    config.SERVER_PUBKEY = '';
    assert.throws(
      () => buildWireGuardConfig(baseArgs()),
      (err) => err.status === 503 && err.code === 'server_key_missing'
    );
  });

  test('buildWireGuardConfig refuses a key that is not 32 bytes of base64', () => {
    config.SERVER_PUBKEY = '';
    assert.throws(
      () => buildWireGuardConfig({ ...baseArgs(), serverPublicKey: PLACEHOLDER }),
      (err) => err.status === 503 && err.code === 'server_key_missing'
    );
  });

  test('buildWireGuardConfig uses the configured key', () => {
    config.SERVER_PUBKEY = REAL_KEY;
    const conf = buildWireGuardConfig(baseArgs());
    assert.ok(conf.includes(`PublicKey = ${REAL_KEY}`));
    assert.ok(!conf.includes('Placeholder'));
  });

  test('header names the real profile type', () => {
    config.SERVER_PUBKEY = REAL_KEY;
    const direct = buildWireGuardConfig(baseArgs());
    assert.ok(direct.includes('Onion Obfuscation: Direct (0-Hop)'));
    assert.ok(!direct.includes('3-Hop'));
    const one = buildWireGuardConfig({ ...baseArgs(), onionRoutingEnabled: true, onionHops: 1 });
    assert.ok(one.includes('Onion Obfuscation: 1-Hop Multi-Route'));
    assert.ok(!one.includes('3-Hop'));
    const dflt = buildWireGuardConfig({ ...baseArgs(), onionRoutingEnabled: true });
    assert.ok(dflt.includes('Onion Obfuscation: 3-Hop Multi-Route'));
  });

  test('QR generation failure is an error, not a placeholder image', async () => {
    const m = mock.method(QRCode, 'toDataURL', async () => {
      throw new Error('boom');
    });
    try {
      await assert.rejects(
        () => generateQrCodeDataUrl('x'),
        (err) => err.status === 503 && err.code === 'qr_generation_failed'
      );
    } finally {
      m.mock.restore();
    }
  });
});

describe('D21 /api/configs/generate fails honestly', () => {
  let dbHelper;
  let app;
  let token;
  let savedKey;
  let savedEndpoint;

  const nodeCount = async () => {
    const res = await getPgPool().query("SELECT COUNT(*) AS c FROM nodes WHERE name = 'D21-Node'");
    return Number(res.rows[0].c);
  };
  const generate = () =>
    request(app).post('/api/configs/generate').set('Authorization', `Bearer ${token}`).send({ name: 'D21-Node' });

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();
    savedKey = config.SERVER_PUBKEY;
    savedEndpoint = config.SERVER_ENDPOINT;
    config.SERVER_ENDPOINT = ENDPOINT;
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin_password' });
    token = res.body.token;
  });
  after(async () => {
    config.SERVER_PUBKEY = savedKey;
    config.SERVER_ENDPOINT = savedEndpoint;
    if (dbHelper) await dbHelper.cleanup();
  });

  test('503 server_key_missing and no node is created', async () => {
    config.SERVER_PUBKEY = '';
    const res = await generate();
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.code, 'server_key_missing');
    assert.ok(!JSON.stringify(res.body).includes('Placeholder'));
    assert.strictEqual(await nodeCount(), 0);
  });

  test('503 server_endpoint_missing and no node is created', async () => {
    config.SERVER_PUBKEY = REAL_KEY;
    config.SERVER_ENDPOINT = '';
    try {
      const res = await generate();
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.code, 'server_endpoint_missing');
    } finally {
      config.SERVER_ENDPOINT = ENDPOINT;
    }
    assert.strictEqual(await nodeCount(), 0);
  });

  test('503 qr_generation_failed rolls the node back', async () => {
    config.SERVER_PUBKEY = REAL_KEY;
    const m = mock.method(QRCode, 'toDataURL', async () => {
      throw new Error('boom');
    });
    try {
      const res = await generate();
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.code, 'qr_generation_failed');
    } finally {
      m.mock.restore();
    }
    assert.strictEqual(await nodeCount(), 0);
  });

  test('200 with the real key when configured', async () => {
    config.SERVER_PUBKEY = REAL_KEY;
    const res = await generate();
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.wireguard_conf.includes(`PublicKey = ${REAL_KEY}`));
    assert.ok(res.body.qrcode_data_url.startsWith('data:image/png'));
  });
});
