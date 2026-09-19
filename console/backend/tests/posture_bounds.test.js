const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildPostureDocument } = require('../utils/posture');

describe('posture document from an untrusted attestation', () => {
  it('bounds the length of every string it stores', () => {
    const huge = 'x'.repeat(1024 * 1024);
    const doc = buildPostureDocument({ os_name: huge, os_version: huge, client_version: huge });

    assert.strictEqual(doc.os_name.length, 128);
    assert.strictEqual(doc.os_version.length, 128);
    assert.strictEqual(doc.client_version.length, 128);
    assert.ok(JSON.stringify(doc).length < 1024);
  });

  it('keeps ordinary values unchanged', () => {
    const doc = buildPostureDocument({ os_name: 'linux', os_version: '13', client_version: 'v4.0.0' });

    assert.strictEqual(doc.os_name, 'linux');
    assert.strictEqual(doc.os_version, '13');
    assert.strictEqual(doc.client_version, 'v4.0.0');
  });
});
