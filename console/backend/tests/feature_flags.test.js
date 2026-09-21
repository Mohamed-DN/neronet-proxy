const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const request = require('supertest');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

/**
 * Cloud PC is frozen behind SOVEREIGN_FEATURE_CLOUD_PC. Off is the default, and off
 * must mean the whole router: a gate on the authenticated routes only would leave
 * the public custom-domain gateway answering, and a client that hides the menu on
 * its own would show a feature the server has already switched off.
 */

const FLAG = 'SOVEREIGN_FEATURE_CLOUD_PC';

let dbHelper;
let app;
let token;

// One path per route in routes/cloudPc.js, including the unauthenticated gateway.
const cloudPcPaths = [
  { method: 'get', path: '/api/cloud-pc' },
  { method: 'post', path: '/api/cloud-pc', body: { name: 'x', device_id: 'y' } },
  { method: 'post', path: '/api/cloud-pc/some-id/project' },
  { method: 'post', path: '/api/cloud-pc/some-id/teardown' },
  { method: 'get', path: '/api/cloud-pc/custom-domains' },
  { method: 'post', path: '/api/cloud-pc/custom-domains', body: { domain: 'a.example.com' } },
  { method: 'post', path: '/api/cloud-pc/custom-domains/a.example.com/verify' },
  { method: 'delete', path: '/api/cloud-pc/custom-domains/a.example.com' },
  // Public by design: no Authorization header is sent for this one.
  { method: 'post', path: '/api/cloud-pc/custom-domains/a.example.com/auth-gateway', body: {}, anonymous: true }
];

function call(spec) {
  let req = request(app)[spec.method](spec.path);
  if (!spec.anonymous) req = req.set('Authorization', `Bearer ${token}`);
  return spec.body ? req.send(spec.body) : req;
}

describe('Cloud PC feature flag', () => {
  let previous;

  before(async () => {
    previous = process.env[FLAG];
    dbHelper = await setupTestDatabase();
    app = createApp();

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: `flags_${Date.now()}`,
        email: `flags_${Date.now()}@example.com`,
        password: 'A-sufficiently-long-password-1'
      });
    assert.ok([200, 201].includes(res.status), `could not register: ${JSON.stringify(res.body)}`);
    token = res.body.token;
    assert.ok(token, 'no token');
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('flag unset', () => {
    it('reports cloud_pc as false on /api/features', async () => {
      delete process.env[FLAG];
      const res = await request(app).get('/api/features');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { cloud_pc: false });
    });

    for (const spec of cloudPcPaths) {
      it(`${spec.method.toUpperCase()} ${spec.path} answers 404`, async () => {
        delete process.env[FLAG];
        const res = await call(spec);
        assert.strictEqual(res.status, 404, JSON.stringify(res.body));
        assert.match(res.body.error, /not found/i);
      });
    }

    it('answers a token holder and an anonymous caller identically', async () => {
      delete process.env[FLAG];
      const withToken = await call({ method: 'get', path: '/api/cloud-pc' });
      const anonymous = await request(app).get('/api/cloud-pc');
      assert.strictEqual(anonymous.status, withToken.status);
      assert.deepStrictEqual(anonymous.body, withToken.body);
    });
  });

  describe('flag set', () => {
    it('reports cloud_pc as true on /api/features', async () => {
      process.env[FLAG] = 'true';
      const res = await request(app).get('/api/features');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { cloud_pc: true });
    });

    it('serves the Cloud PC list again', async () => {
      process.env[FLAG] = 'true';
      const res = await call({ method: 'get', path: '/api/cloud-pc' });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(Array.isArray(res.body.cloud_pcs));
    });

    it('routes the public gateway to its handler instead of the gate', async () => {
      process.env[FLAG] = 'true';
      const res = await call(cloudPcPaths[cloudPcPaths.length - 1]);
      // The handler answers for an unknown domain with its own message; the gate's
      // message names the endpoint.
      assert.doesNotMatch(String(res.body.error), /Endpoint '.*' not found/);
    });

    it('accepts "1" as well as "true"', async () => {
      process.env[FLAG] = '1';
      assert.strictEqual((await request(app).get('/api/features')).body.cloud_pc, true);
    });

    for (const value of ['false', '0', '', 'yes', 'TRUEISH']) {
      it(`treats ${JSON.stringify(value)} as off`, async () => {
        process.env[FLAG] = value;
        assert.strictEqual((await request(app).get('/api/features')).body.cloud_pc, false);
        assert.strictEqual((await call({ method: 'get', path: '/api/cloud-pc' })).status, 404);
      });
    }
  });
});
