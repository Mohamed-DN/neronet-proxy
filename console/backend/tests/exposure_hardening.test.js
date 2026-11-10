// Security review of 10 November 2026 (C1, M1): what an anonymous Internet client may do.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const RegistrationPolicy = require('../services/RegistrationPolicy');

describe('exposure hardening', () => {
  let dbHelper;
  let app;
  const saved = { reg: process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION, env: process.env.NODE_ENV };

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();
  });
  afterEach(() => {
    if (saved.reg === undefined) delete process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION;
    else process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION = saved.reg;
    process.env.NODE_ENV = saved.env;
  });
  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('C1: self-registration', () => {
    it('is off in production unless switched on, and on elsewhere by default', () => {
      delete process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION;
      process.env.NODE_ENV = 'production';
      assert.strictEqual(RegistrationPolicy.selfRegistrationAllowed(), false);
      process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION = 'true';
      assert.strictEqual(RegistrationPolicy.selfRegistrationAllowed(), true);
      process.env.NODE_ENV = 'test';
      delete process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION;
      assert.strictEqual(RegistrationPolicy.selfRegistrationAllowed(), true);
      process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION = 'false';
      assert.strictEqual(RegistrationPolicy.selfRegistrationAllowed(), false);
    });

    it('refuses an anonymous account when registration is off and creates no user', async () => {
      process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION = 'false';
      const res = await request(app).post('/api/auth/register').send({ username: 'walkin', password: 'Password123!' });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error, 'registration_disabled');
      assert.ok(!res.body.token);
      const row = await dbHelper.pool.query("SELECT 1 FROM users WHERE username = 'walkin'");
      assert.strictEqual(row.rows.length, 0);
    });

    it('still registers when an operator has switched it on', async () => {
      process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION = 'true';
      const res = await request(app).post('/api/auth/register').send({ username: 'invited', password: 'Password123!' });
      assert.strictEqual(res.status, 201);
    });
  });

  describe('M1: CORS', () => {
    it('does not reflect an origin that is not configured', async () => {
      const res = await request(app).get('/api/health').set('Origin', 'https://evil.darknero.com');
      assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
      assert.strictEqual(res.headers['access-control-allow-credentials'], undefined);
    });

    it('answers a configured origin with credentials allowed', async () => {
      const config = require('../config/env');
      const origin = config.CORS_ORIGINS[0];
      const res = await request(app).get('/api/health').set('Origin', origin);
      assert.strictEqual(res.headers['access-control-allow-origin'], origin);
      assert.strictEqual(res.headers['access-control-allow-credentials'], 'true');
    });

    it('allows localhost origins outside production only', () => {
      const { originAllowed } = require('../middleware/cors');
      assert.strictEqual(originAllowed('http://localhost:9999', { production: false }), true);
      assert.strictEqual(originAllowed('http://localhost:9999', { production: true }), false);
      assert.strictEqual(originAllowed('https://localhost.evil.example', { production: false }), false);
      assert.strictEqual(originAllowed(undefined, { production: true }), true);
    });
  });
});
