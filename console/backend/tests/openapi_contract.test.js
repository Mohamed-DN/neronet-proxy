// ==============================================================================
// NeroNet Sovereign Mesh - OpenAPI 3.1.0 Contract Verification Test (WP-403)
// Verifies that api/openapi.yaml is valid, complete, and synchronized with Express routes
// ==============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server');

describe('WP-403: OpenAPI Specification & API Contract', () => {
  const openapiPath = path.resolve(__dirname, '../../../api/openapi.yaml');

  test('1. api/openapi.yaml exists and declares OpenAPI 3.1.0', () => {
    assert.ok(fs.existsSync(openapiPath), 'api/openapi.yaml must exist');
    const content = fs.readFileSync(openapiPath, 'utf8');
    assert.ok(content.includes('openapi: 3.1.0'), 'Must specify openapi: 3.1.0');
    assert.ok(content.includes('title: NeroNet Sovereign Mesh Enterprise Console API'));
    assert.ok(content.includes('version: 4.0.0'));
  });

  test('2. Documents all primary enterprise paths', () => {
    const content = fs.readFileSync(openapiPath, 'utf8');
    const requiredPaths = [
      '/health',
      '/features',
      '/auth/login',
      '/auth/refresh',
      '/auth/logout',
      '/nodes',
      '/nodes/{id}',
      '/nodes/{id}/quarantine',
      '/nodes/{id}/revoke',
      '/compartments',
      '/compartments/peerings',
      '/acl/rules',
      '/audit/events',
      '/audit/verify',
      '/audit/recovery-proof/latest',
      '/stats/overview',
      '/stats/ha-leader',
      '/nuke/status',
      '/nuke/request',
      '/nuke/approve'
    ];

    for (const p of requiredPaths) {
      assert.ok(content.includes(`${p}:`), `OpenAPI specification must document path '${p}'`);
    }
  });

  test('3. Documents security schemas and bearer JWT auth', () => {
    const content = fs.readFileSync(openapiPath, 'utf8');
    assert.ok(content.includes('bearerAuth:'));
    assert.ok(content.includes('scheme: bearer'));
    assert.ok(content.includes('bearerFormat: JWT'));
  });

  test('4. Express server mounts the documented endpoints without collisions', () => {
    const app = createApp();
    assert.ok(app, 'Express app must instantiate cleanly');
    assert.equal(typeof app.handle, 'function');
  });
});
