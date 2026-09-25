const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../server');
const { setupTestDatabase } = require('./helpers/db');

describe('WP-503: Security Headers & Defense-in-Depth Tests', () => {
  let dbHelper;
  let app;

  before(async () => {
    dbHelper = await setupTestDatabase();
    app = createApp();
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('Enforces X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  });

  it('Enforces X-Frame-Options: DENY against clickjacking', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
  });

  it('Enforces Content-Security-Policy with frame-ancestors none', async () => {
    const res = await request(app).get('/api/health');
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'CSP header must be present');
    assert.ok(csp.includes("frame-ancestors 'none'"), 'Must disallow embedding via frame-ancestors none');
    assert.ok(csp.includes("default-src 'self'"), 'Must restrict default-src to self');
  });

  it('Enforces Referrer-Policy: strict-origin-when-cross-origin', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  });

  it('Enforces Permissions-Policy disabling dangerous device sensors', async () => {
    const res = await request(app).get('/api/health');
    const pp = res.headers['permissions-policy'];
    assert.ok(pp, 'Permissions-Policy header must be present');
    assert.ok(pp.includes('camera=()'));
    assert.ok(pp.includes('microphone=()'));
    assert.ok(pp.includes('geolocation=()'));
  });

  it('Removes X-Powered-By to prevent server technology leakage', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.headers['x-powered-by'], undefined);
  });

  it('Safely rejects XSS injection payloads in JSON endpoints', async () => {
    const maliciousPayload = {
      name: '<script>alert("xss")</script>',
      description: '"><img src=x onerror=alert(1)>'
    };
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        username: maliciousPayload.name,
        password: maliciousPayload.description
      });
    assert.ok([400, 401].includes(res.status), 'Must return 400 or 401 for invalid credentials');
    assert.strictEqual(res.headers['content-type'].includes('application/json'), true);
    assert.ok(!res.text.includes('<script>alert("xss")</script>'));
  });

  it('Rejects classic SQL Injection payloads in login without unhandled crash', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        username: "' OR 1=1 --",
        password: "' OR 'a'='a"
      });
    assert.strictEqual(res.status, 401);
    assert.ok(res.body.error);
  });
});
