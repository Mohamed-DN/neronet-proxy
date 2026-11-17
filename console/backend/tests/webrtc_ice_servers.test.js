/**
 * D21b: ICE servers carry no shared credential. STUN only unless TURN is configured;
 * when it is, each session gets its own time-limited TURN REST credential (coturn
 * use-auth-secret): username "<expiry>:<session id>", credential base64(HMAC-SHA1).
 */
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dbPath = require.resolve('../db/index');
const auditPath = require.resolve('../utils/audit');
const fakePool = {
  query: async (sql) =>
    /FROM cloud_pcs/i.test(sql)
      ? { rows: [{ id: 'cpc-1', user_id: 'u1', device_id: 'd1', signaling_url: null }] }
      : { rows: [] }
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
const SECRET = 'example-turn-secret';
const VARS = ['SOVEREIGN_TURN_URLS', 'SOVEREIGN_TURN_SECRET', 'SOVEREIGN_TURN_TTL_SECONDS'];

describe('WebRTC ICE servers', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('source holds no TURN secret or shared username', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'WebRtcSignalingEngine.js'), 'utf8');
    assert.ok(!/turn_secret_token|username: 'neronet'/.test(src));
  });

  test('STUN only, no credential, when TURN is not configured', async () => {
    const out = await Engine.projectDevice('cpc-1', actor);
    assert.ok(out.ice_servers.length >= 1);
    for (const s of out.ice_servers) {
      assert.ok(String(s.urls).startsWith('stun:'));
      assert.strictEqual(s.credential, undefined);
      assert.strictEqual(s.username, undefined);
    }
  });

  test('a URL list without a secret (or the reverse) stays STUN only', async () => {
    process.env.SOVEREIGN_TURN_URLS = 'turn:turn.example.com:3478';
    let out = await Engine.projectDevice('cpc-1', actor);
    assert.ok(out.ice_servers.every((s) => s.credential === undefined));
    delete process.env.SOVEREIGN_TURN_URLS;
    process.env.SOVEREIGN_TURN_SECRET = SECRET;
    out = await Engine.projectDevice('cpc-1', actor);
    assert.ok(out.ice_servers.every((s) => s.credential === undefined));
  });

  test('configured TURN issues a per-session time-limited REST credential', async () => {
    process.env.SOVEREIGN_TURN_URLS = 'turn:turn.example.com:3478, turns:turn.example.com:5349';
    process.env.SOVEREIGN_TURN_SECRET = SECRET;
    const before = Math.floor(Date.now() / 1000);
    const out = await Engine.projectDevice('cpc-1', actor);
    const turn = out.ice_servers.find((s) => s.credential);
    assert.deepStrictEqual(turn.urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349']);
    const [expiry, sessionId] = turn.username.split(':');
    assert.strictEqual(sessionId, out.session_id);
    assert.ok(Number(expiry) >= before + 3600 && Number(expiry) <= before + 3600 + 5);
    const expected = crypto.createHmac('sha1', SECRET).update(turn.username).digest('base64');
    assert.strictEqual(turn.credential, expected);
    assert.ok(!JSON.stringify(out).includes(SECRET));
  });

  test('two sessions never share a credential', async () => {
    process.env.SOVEREIGN_TURN_URLS = 'turn:turn.example.com:3478';
    process.env.SOVEREIGN_TURN_SECRET = SECRET;
    const a = (await Engine.projectDevice('cpc-1', actor)).ice_servers.find((s) => s.credential);
    const b = (await Engine.projectDevice('cpc-1', actor)).ice_servers.find((s) => s.credential);
    assert.notStrictEqual(a.username, b.username);
    assert.notStrictEqual(a.credential, b.credential);
  });
});
