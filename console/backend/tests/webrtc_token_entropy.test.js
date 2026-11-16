/**
 * D21: WebRTC session and stream tokens must come from a CSPRNG, not from a hash of
 * the session id, Date.now or Math.random. Runs the engine against a stubbed
 * database; the module is behind a flag that is off, so the surface is small.
 */
const { describe, test, before, after, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const dbPath = require.resolve('../db/index');
const auditPath = require.resolve('../utils/audit');
const fakePool = {
  query: async (sql) => {
    if (/FROM cloud_pcs/i.test(sql)) {
      return { rows: [{ id: 'cpc-1', user_id: 'u1', device_id: 'd1', signaling_url: null }] };
    }
    if (/FROM custom_domains/i.test(sql)) {
      return { rows: [{ domain_name: 'pc.example.com', cloud_pc_id: 'cpc-1', otp_secret: 'ABCDEF234567' }] };
    }
    return { rows: [] };
  }
};
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { getDatabase: () => null, isPostgres: () => true, getPgPool: () => fakePool }
};
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: { logAuditEvent: () => {} } };

const Engine = require('../services/WebRtcSignalingEngine');
const actor = { id: 'u1', role: 'super-admin', username: 'a', organization_id: null };

describe('WebRTC tokens are unpredictable', () => {
  before(() => {
    mock.method(Date, 'now', () => 1700000000000);
    mock.method(Math, 'random', () => 0.5);
  });
  after(() => mock.restoreAll());

  test('projectDevice tokens do not repeat or derive from public inputs', async () => {
    const a = await Engine.projectDevice('cpc-1', actor);
    const b = await Engine.projectDevice('cpc-1', actor);
    assert.notStrictEqual(a.session_id, b.session_id);
    assert.notStrictEqual(a.stream_token, b.stream_token);
    const derived = `stok_${crypto.createHash('sha256').update(a.session_id).digest('hex')}`;
    assert.notStrictEqual(a.stream_token, derived);
    assert.match(a.session_id, /^webrtc_sess_[0-9a-f]{32}$/);
    assert.match(a.stream_token, /^stok_[0-9a-f]{64}$/);
  });

  test('authenticateGateway tokens do not repeat or derive from the domain and time', async () => {
    const a = await Engine.authenticateGateway('pc.example.com', 'ABCDEF234567');
    const b = await Engine.authenticateGateway('pc.example.com', 'ABCDEF234567');
    assert.notStrictEqual(a.stream_token, b.stream_token);
    const derived = `stream_auth_${crypto
      .createHash('sha256')
      .update('pc.example.com' + 1700000000000)
      .digest('hex')
      .substring(0, 16)}`;
    assert.notStrictEqual(a.stream_token, derived);
    assert.match(a.stream_token, /^stream_auth_[0-9a-f]{64}$/);
  });
});
