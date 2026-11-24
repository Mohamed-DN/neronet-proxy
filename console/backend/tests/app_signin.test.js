// ADR 0040 phase 0, slice A: device-code sign-in for the NeroNet app, app tokens and the
// one-node enrolment grant. Real database, real routes; nothing here is mocked.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createOrgFixture } = require('./helpers/orgFixture');
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { nodeKey, register, proveKey } = require('./helpers/nodeEnrolment');
const { settleAuditWrites } = require('../utils/audit');
const { createApp } = require('../server');
const TotpService = require('../services/TotpService');
const { CryptoShreddingService } = require('../services/CryptoShreddingService');

const base = '/api/app-auth';
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

// The installation's Ed25519 signing key. The console binds the app to its public half at
// start and wants a fresh signature with every refresh.
const newSigner = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
};
const refreshBody = (refreshToken, signer, { ts = Math.floor(Date.now() / 1000), nonce } = {}) => {
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const message = [
    'NERONET-APP-REFRESH-V1',
    'POST',
    `${base}/token/refresh`,
    crypto.createHash('sha256').update(refreshToken).digest('hex'),
    String(ts),
    n
  ].join(String.fromCharCode(10));
  const signature = crypto.sign(null, Buffer.from(message), signer.privateKey).toString('hex');
  return { refresh_token: refreshToken, timestamp: ts, nonce: n, signature };
};

describe('app sign-in by device code', () => {
  let dbHelper;
  let pool;
  let app;
  let fx;
  let mfaToken;
  let mfaSecret;
  // A code of the step `n` steps from now (the console accepts one step either side). Each
  // test uses its own step, in ascending order, because a code is accepted only once.
  const totp = (n) => TotpService.generateTotp(mfaSecret, { time: Date.now() + n * 30000 });

  // Starting needs proof that the caller holds the private half of the installation key, as
  // registration does. `over` can override or remove any field, to test the refusals.
  const start = async (over = {}) => {
    const key = 'public_key_hex' in over ? over.public_key_hex : nodeKey();
    const body = {
      platform: 'linux',
      device_name: 'Office laptop',
      public_key_hex: key,
      signing_key: newSigner().pub,
      ...over
    };
    if (!('nonce' in over) && !('proof' in over) && /^[0-9a-f]{64}$/.test(String(key))) {
      try {
        Object.assign(body, await proveKey(app, key, 'APP_SIGNIN'));
      } catch {
        // A key this suite did not make: sent without proof.
      }
    }
    return request(app).post(`${base}/device/start`).send(body);
  };
  const doRefresh = (token, signer, opts) =>
    request(app)
      .post(`${base}/token/refresh`)
      .send(refreshBody(token, signer, opts));
  const poll = (device_code) => request(app).post(`${base}/device/poll`).send({ device_code });
  const approve = (token, user_code, extra = {}) =>
    request(app)
      .post(`${base}/device/approve`)
      .set(bearer(token))
      .send({ user_code, ...extra });
  const forcePollable = (device_code) =>
    pool.query('UPDATE app_device_codes SET last_polled_at = NULL WHERE device_code_hash = $1', [
      crypto.createHash('sha256').update(device_code).digest('hex')
    ]);
  // Full happy path up to the tokens, for tests that need a signed-in app.
  async function signIn(token = fx.tokens.memberA, over = {}) {
    const signer = newSigner();
    const s = await start({ signing_key: signer.pub, ...over });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    const a = await approve(token, s.body.user_code);
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    await forcePollable(s.body.device_code);
    const p = await poll(s.body.device_code);
    assert.strictEqual(p.body.status, 'approved', JSON.stringify(p.body));
    return { start: s.body, tokens: p.body.app_token, grant: p.body.enrolment, key: s.body.public_key_hex, signer };
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    fx = await createOrgFixture(pool);
    mfaSecret = TotpService.generateSecret();
    const sealed = await CryptoShreddingService.sealForOrg(fx.orgs.A, mfaSecret);
    await pool.query('UPDATE users SET totp_enabled = TRUE, totp_secret = $2 WHERE id = $1', [fx.ids.member2A, sealed]);
    mfaToken = await issueConsoleTestToken({
      sub: fx.ids.member2A,
      id: fx.ids.member2A,
      username: 'sec_member2a',
      role: 'user',
      organization_id: fx.orgs.A
    });
  });

  after(async () => {
    await settleAuditWrites();
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('start and poll', () => {
    it('returns a secret device code and a short readable user code, and stores only hashes', async () => {
      const key = nodeKey();
      const res = await start({ public_key_hex: key });
      assert.strictEqual(res.status, 200);
      assert.match(res.body.device_code, /^[0-9a-f]{64}$/);
      assert.match(res.body.user_code, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
      assert.strictEqual(res.body.expires_in, 600);
      assert.ok(res.body.interval >= 1);
      assert.strictEqual(res.body.verification_uri, '/collega');
      assert.ok(res.body.verification_uri_complete.includes(res.body.user_code));
      const rows = (await pool.query('SELECT * FROM app_device_codes')).rows;
      const dump = JSON.stringify(rows);
      assert.ok(!dump.includes(res.body.device_code), 'device code must not be stored');
      assert.ok(!dump.includes(res.body.user_code.replace('-', '')), 'user code must not be stored');
      assert.ok(!dump.includes(res.body.user_code));
    });

    it('validates every field as untrusted input', async () => {
      const bad = [
        { platform: 'amiga' },
        { platform: undefined },
        { device_name: '' },
        { device_name: 'x'.repeat(200) },
        { device_name: '<script>alert(1)</script>' },
        { device_name: 'a\nb' },
        { public_key_hex: 'zz' },
        { public_key_hex: 'a'.repeat(63) },
        { signing_key: 'zz' },
        { signing_key: undefined },
        { signing_key: 'a'.repeat(63) },
        { scopes: ['admin:all'] },
        { scopes: 'devices:read' }
      ];
      for (const over of bad) {
        const res = await start(over);
        assert.strictEqual(res.status, 400, JSON.stringify(over));
      }
    });

    it('answers pending, then slow_down when polled too fast, then expired for an unknown code', async () => {
      const s = (await start()).body;
      assert.strictEqual((await poll(s.device_code)).body.status, 'pending');
      const fast = await poll(s.device_code);
      assert.strictEqual(fast.body.status, 'slow_down');
      assert.ok(fast.body.interval > s.interval);
      const unknown = await poll(crypto.randomBytes(32).toString('hex'));
      assert.strictEqual(unknown.body.status, 'expired');
      assert.strictEqual((await poll('not-a-code')).status, 400);
    });

    it('expires after ten minutes', async () => {
      const s = (await start()).body;
      await pool.query("UPDATE app_device_codes SET expires_at = NOW() - INTERVAL '1 second', last_polled_at = NULL");
      assert.strictEqual((await poll(s.device_code)).body.status, 'expired');
      assert.strictEqual((await approve(fx.tokens.memberA, s.user_code)).status, 410);
    });
  });

  describe('approve and deny', () => {
    it('shows what is asking, to a signed-in person only', async () => {
      const s = (await start({ platform: 'windows', device_name: 'Desk PC' })).body;
      const anon = await request(app).post(`${base}/device/lookup`).send({ user_code: s.user_code });
      assert.strictEqual(anon.status, 401);
      const res = await request(app)
        .post(`${base}/device/lookup`)
        .set(bearer(fx.tokens.memberA))
        .send({ user_code: s.user_code.toLowerCase().replace('-', ' ') });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.platform, 'windows');
      assert.strictEqual(res.body.device_name, 'Desk PC');
      assert.ok(res.body.request_ip);
      assert.strictEqual(typeof res.body.mfa_required, 'boolean');
      assert.ok(!('device_code' in res.body));
      assert.strictEqual(
        (
          await request(app)
            .post(`${base}/device/lookup`)
            .set(bearer(fx.tokens.memberA))
            .send({ user_code: 'ZZZZ-ZZZZ' })
        ).status,
        404
      );
    });

    it('approve is single use, hands tokens out once, and polls cleanly after', async () => {
      const r = await signIn();
      assert.match(r.tokens.access_token, /^nna_[0-9a-f]{64}$/);
      assert.match(r.tokens.refresh_token, /^nnr_[0-9a-f]{64}$/);
      assert.deepStrictEqual(r.tokens.scopes.sort(), ['app:self', 'devices:read']);
      assert.match(r.grant.preauth_key, /^nnk1_/);
      assert.match(r.grant.node_id, /^pk_[0-9a-f]{16}$/);
      await forcePollable(r.start.device_code);
      assert.strictEqual((await poll(r.start.device_code)).body.status, 'expired');
      const dump = JSON.stringify((await pool.query('SELECT * FROM app_sessions')).rows);
      assert.ok(!dump.includes(r.tokens.access_token) && !dump.includes(r.tokens.refresh_token));
      const dump2 = JSON.stringify((await pool.query('SELECT * FROM preauth_keys')).rows);
      assert.ok(!dump2.includes(r.grant.preauth_key));
    });

    it('cannot approve one code twice or after a denial', async () => {
      const s = (await start()).body;
      assert.strictEqual((await approve(fx.tokens.memberA, s.user_code)).status, 200);
      assert.strictEqual((await approve(fx.tokens.memberA, s.user_code)).status, 409);
      const d = (await start()).body;
      const den = await request(app)
        .post(`${base}/device/deny`)
        .set(bearer(fx.tokens.memberA))
        .send({ user_code: d.user_code });
      assert.strictEqual(den.status, 200);
      await forcePollable(d.device_code);
      assert.strictEqual((await poll(d.device_code)).body.status, 'denied');
      assert.strictEqual((await approve(fx.tokens.memberA, d.user_code)).status, 409);
    });

    it('requires a fresh second factor when the account has one', async () => {
      const s = (await start()).body;
      const none = await approve(mfaToken, s.user_code);
      assert.strictEqual(none.status, 401);
      assert.strictEqual(none.body.code, 'mfa_required');
      const wrong = await approve(mfaToken, s.user_code, { totp_code: '000000' });
      assert.strictEqual(wrong.status, 401);
      assert.strictEqual(wrong.body.code, 'mfa_invalid');
      const ok = await approve(mfaToken, s.user_code, { totp_code: totp(-1) });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });

    it('refuses an account that must have a second factor but has none enrolled', async () => {
      process.env.SOVEREIGN_MFA_MANDATORY = 'all';
      try {
        const s = (await start()).body;
        const res = await approve(fx.tokens.memberB, s.user_code);
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'mfa_setup_required');
      } finally {
        delete process.env.SOVEREIGN_MFA_MANDATORY;
      }
    });

    it('refuses a suspended account', async () => {
      const s = (await start()).body;
      await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [fx.ids.memberB]);
      try {
        assert.strictEqual((await approve(fx.tokens.memberB, s.user_code)).status, 403);
      } finally {
        await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [fx.ids.memberB]);
      }
    });

    it('refuses a member who has a blocked device, as adding a device does', async () => {
      await pool.query(
        `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role,
                            is_healthy, is_quarantined, quarantine_reason, device_kind)
         VALUES ('dev-app-blocked', $1, $2, 'blocked', '100.64.90.1', 'fd00:90::1', $3, 'CLIENT_ORIGIN', FALSE, TRUE,
                 'Manual security quarantine', 'profile')`,
        [fx.orgs.A, fx.ids.member2A, nodeKey()]
      );
      try {
        // member2A has a second factor; give a valid code so only the policy can refuse.
        const s = (await start()).body;
        const res = await approve(mfaToken, s.user_code, { totp_code: totp(1) });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'owner_has_blocked_device');
      } finally {
        await pool.query("DELETE FROM nodes WHERE id = 'dev-app-blocked'");
      }
    });

    it('refuses an installation key that is already revoked or owned by another person', async () => {
      const key = nodeKey();
      const first = await signIn(fx.tokens.memberA, { public_key_hex: key });
      const reg = await register(app, {
        public_key_hex: key,
        role: 'CLIENT_ORIGIN',
        preauth_key: first.grant.preauth_key
      });
      assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
      const s = (await start({ public_key_hex: key })).body;
      const res = await approve(fx.tokens.memberB, s.user_code);
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, 'installation_in_use');
    });
  });

  describe('enrolment grant', () => {
    it('enrols exactly one node for that person and organisation, with the key it was issued for', async () => {
      const r = await signIn(fx.tokens.memberA);
      const reg = await register(app, {
        public_key_hex: r.key,
        role: 'CLIENT_ORIGIN',
        preauth_key: r.grant.preauth_key
      });
      assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
      assert.strictEqual(reg.body.assigned_node_id, r.grant.node_id);
      const node = (await pool.query('SELECT user_id, organization_id FROM nodes WHERE id = $1', [r.grant.node_id]))
        .rows[0];
      assert.strictEqual(node.user_id, fx.ids.memberA);
      assert.strictEqual(node.organization_id, fx.orgs.A);
    });

    it('does not work for another key, nor a second node', async () => {
      const r = await signIn(fx.tokens.memberA);
      const other = nodeKey();
      const wrongKey = await register(app, {
        public_key_hex: other,
        role: 'CLIENT_ORIGIN',
        preauth_key: r.grant.preauth_key
      });
      assert.strictEqual(wrongKey.status, 403);
      const wrongRole = await register(app, {
        public_key_hex: r.key,
        role: 'EXIT_BRIDGE',
        preauth_key: r.grant.preauth_key
      });
      assert.ok([401, 403].includes(wrongRole.status));
      const ok = await register(app, {
        public_key_hex: r.key,
        role: 'CLIENT_ORIGIN',
        preauth_key: r.grant.preauth_key
      });
      assert.strictEqual(ok.status, 200);
      // A single-use grant is spent; a different key cannot ride on it afterwards either.
      const again = await register(app, {
        public_key_hex: other,
        role: 'CLIENT_ORIGIN',
        preauth_key: r.grant.preauth_key
      });
      assert.ok([401, 403].includes(again.status));
    });
  });

  describe('app token', () => {
    it('opens only the app routes, with their scopes', async () => {
      const r = await signIn(fx.tokens.memberA);
      const me = await request(app).get(`${base}/app/me`).set(bearer(r.tokens.access_token));
      assert.strictEqual(me.status, 200);
      assert.strictEqual(me.body.user_id, fx.ids.memberA);
      assert.strictEqual(me.body.node_id, r.grant.node_id);
      const dev = await request(app).get(`${base}/app/devices`).set(bearer(r.tokens.access_token));
      assert.strictEqual(dev.status, 200);
      assert.ok(Array.isArray(dev.body.devices));
      assert.strictEqual((await request(app).get(`${base}/app/me`)).status, 401);
      // A console session is not an app token.
      assert.strictEqual((await request(app).get(`${base}/app/me`).set(bearer(fx.tokens.memberA))).status, 401);
      // A scope the token was not issued with is refused.
      await pool.query("UPDATE app_sessions SET scopes = ARRAY['app:self'] WHERE node_id = $1", [r.grant.node_id]);
      assert.strictEqual(
        (await request(app).get(`${base}/app/devices`).set(bearer(r.tokens.access_token))).status,
        403
      );
    });

    it('reaches no other route: with valid-shaped input it gets what no credential gets, and only known public routes answer without one', async () => {
      const r = await signIn(fx.tokens.memberA);
      const routes = [];
      const walk = (stack, prefix) => {
        for (const layer of stack) {
          if (layer.route) {
            for (const method of Object.keys(layer.route.methods)) {
              if (method === '_all') continue;
              routes.push({ method, path: prefix + layer.route.path });
            }
          } else if (layer.name === 'router' && layer.handle.stack) {
            const src = layer.regexp.source
              .replace(/^\^/, '')
              .replace(/\\\//g, '/')
              .replace(/\/\?\(\?=\/\|\$\)$/, '')
              .replace(/\(\?:\/\(\[\^\/\]\+\?\)\)/g, '/:param')
              .replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, ':param');
            walk(layer.handle.stack, prefix + src);
          }
        }
      };
      walk(app._router.stack, '');
      const uuid = '00000000-0000-4000-8000-000000000001';
      const concrete = routes
        .map((x) => ({ ...x, template: x.path, path: x.path.replace(/:[A-Za-z]+\??/g, uuid) }))
        .filter((x) => !x.path.startsWith(`${base}/app/`) && !x.path.includes('*'));
      assert.ok(concrete.length > 100, `route walk found only ${concrete.length} routes`);
      assert.ok(
        concrete.some((x) => x.path.includes('/nuke')),
        'route walk must include nuke routes'
      );
      assert.ok(
        concrete.some((x) => x.path.includes('/organizations')),
        'route walk must include admin routes'
      );
      assert.ok(
        concrete.some((x) => x.path.startsWith('/v4/control/heartbeat')),
        'route walk must include node routes'
      );
      // A body that passes shape validation, so an authentication refusal (not a 400) is what stops a request.
      const body = {
        id: uuid,
        node_id: 'pk_0123456789abcdef',
        public_key_hex: 'a'.repeat(64),
        role: 'CLIENT_ORIGIN',
        nonce: 'b'.repeat(64),
        proof: 'c'.repeat(64),
        name: 'probe',
        username: 'probe',
        password: 'probe-probe-probe',
        code: 'ABCD-EFGH',
        token: 'x',
        endpoints: [],
        capability: {}
      };
      // Routes that answer without any credential, by design. A new unauthenticated route must be added
      // here on purpose, after review; the app token must never be the thing that opens a door.
      const PUBLIC = [
        ['get', /^\/(api\/)?(metrics|health|ready|live)/],
        ['get', /^\/api\/(health|ready|live|features|contract|openapi)/],
        ['get', /canary\.txt$/],
        ['get', /^\/api\/nuke\/canary/],
        ['post', /^\/api\/auth\/(login|register|refresh|logout|mfa)/],
        ['get', /^\/api\/auth\/(browser|mfa|oidc|sso|config)/],
        ['post', /^\/api\/auth\/browser/],
        ['post', /^\/api\/invitations\/accept$/],
        ['post', /^\/api\/app-auth\/(device\/(start|poll)|token\/refresh)$/],
        ['post', /^\/v4\/control\/(challenge|register)$/],
        ['post', /^\/api\/auth\/oidc\/callback$/]
      ];
      // Bodies the node routes accept, so that the credential check, not a 400 about the shape, is
      // what stops a request (the contract forbids unknown fields).
      const NODE = 'pk_0123456789abcdef';
      const V4_BODIES = {
        '/v4/control/heartbeat': { node_id: NODE, sequence_num: 1 },
        '/v4/control/discover': {},
        '/v4/control/sync-acls': { node_id: NODE, policy_epoch: 0 },
        '/v4/control/sync-routes': { node_id: NODE, route_epoch: 0 },
        '/v4/control/netmap': { node_id: NODE, version: 0 },
        '/v4/control/circuit': { target_country: 'IT', node_id: NODE }
      };
      const isPublic = (m, p) => PUBLIC.some(([pm, re]) => pm === m && re.test(p));
      const leaks = [];
      const unexpectedPublic = [];
      // Some node routes accept the fleet enrolment token and, in development, are open when none is set.
      // The walk runs as production does, with one set, so they are what they are there.
      const savedFleetToken = process.env.SOVEREIGN_REGISTRATION_TOKEN;
      process.env.SOVEREIGN_REGISTRATION_TOKEN = crypto.randomBytes(24).toString('hex');
      try {
        for (const { method, path } of concrete) {
          const send = (auth) => {
            let q = request(app)[method](path);
            if (auth) q = q.set('Authorization', `Bearer ${r.tokens.access_token}`);
            // A fresh account name each time, so that two identical requests are not told apart by the first having succeeded.
            if (V4_BODIES[path]) return q.send(V4_BODIES[path]);
            return method === 'get' || method === 'delete'
              ? q
              : q.send({
                  ...body,
                  username: `probe${crypto.randomBytes(4).toString('hex')}`,
                  email: `p${crypto.randomBytes(4).toString('hex')}@probe.example.com`
                });
          };
          const without = await send(false);
          const withToken = await send(true);
          if (withToken.status !== without.status)
            leaks.push(`${method} ${path}: ${without.status} -> ${withToken.status}`);
          // 404 is a feature that is switched off or a path that does not exist: it answers nobody.
          if (![401, 403, 404].includes(without.status) && !isPublic(method, path))
            unexpectedPublic.push(`${method} ${path}: ${without.status}`);
        }
      } finally {
        if (savedFleetToken === undefined) delete process.env.SOVEREIGN_REGISTRATION_TOKEN;
        else process.env.SOVEREIGN_REGISTRATION_TOKEN = savedFleetToken;
      }
      assert.deepStrictEqual(leaks, [], 'the app token opened something');
      assert.deepStrictEqual(
        unexpectedPublic,
        [],
        'a route answers without any credential and is not on the reviewed list'
      );
    });

    it('rotates the refresh token, and a signed replay of an old one outside the retry window revokes the whole app', async () => {
      const r = await signIn(fx.tokens.memberA);
      const reg = await register(app, {
        public_key_hex: r.key,
        role: 'CLIENT_ORIGIN',
        preauth_key: r.grant.preauth_key
      });
      assert.strictEqual(reg.status, 200);
      const one = await doRefresh(r.tokens.refresh_token, r.signer);
      assert.strictEqual(one.status, 200, JSON.stringify(one.body));
      assert.notStrictEqual(one.body.refresh_token, r.tokens.refresh_token);
      assert.strictEqual((await request(app).get(`${base}/app/me`).set(bearer(one.body.access_token))).status, 200);
      // The first access token stops working once rotated.
      assert.strictEqual((await request(app).get(`${base}/app/me`).set(bearer(r.tokens.access_token))).status, 401);
      // The day-long window for a lost response is over: the old token again, even signed, is a replay.
      await pool.query("UPDATE app_sessions SET rotated_at = NOW() - INTERVAL '25 hours' WHERE node_id = $1", [
        r.grant.node_id
      ]);
      const replay = await doRefresh(r.tokens.refresh_token, r.signer);
      assert.strictEqual(replay.status, 401);
      assert.strictEqual((await request(app).get(`${base}/app/me`).set(bearer(one.body.access_token))).status, 401);
      assert.strictEqual((await doRefresh(one.body.refresh_token, r.signer)).status, 401);
      const again = await register(app, { public_key_hex: r.key, role: 'CLIENT_ORIGIN' });
      assert.strictEqual(again.status, 403);
      await settleAuditWrites();
      const ev = await pool.query("SELECT 1 FROM audit_events WHERE event_type = 'APP_TOKEN_REUSE_DETECTED'");
      assert.strictEqual(ev.rows.length >= 1, true);
    });

    it('stops working when the person is suspended', async () => {
      const r = await signIn(fx.tokens.memberB);
      await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [fx.ids.memberB]);
      try {
        assert.strictEqual((await request(app).get(`${base}/app/me`).set(bearer(r.tokens.access_token))).status, 401);
        assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer)).status, 401);
      } finally {
        await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [fx.ids.memberB]);
      }
    });
  });

  describe('refresh proves possession of the installation key', () => {
    async function joined() {
      const r = await signIn(fx.tokens.memberA);
      const reg = await register(app, {
        public_key_hex: r.key,
        role: 'CLIENT_ORIGIN',
        preauth_key: r.grant.preauth_key
      });
      assert.strictEqual(reg.status, 200);
      return r;
    }
    const alive = async (access) => (await request(app).get(`${base}/app/me`).set(bearer(access))).status === 200;

    it('refuses a signature from another key, and the app carries on', async () => {
      const r = await joined();
      const res = await doRefresh(r.tokens.refresh_token, newSigner());
      assert.strictEqual(res.status, 401);
      assert.ok(await alive(r.tokens.access_token), 'a refusal must not harm the real app');
      assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer)).status, 200);
    });

    it('refuses a stolen refresh token that comes without the key, and does not revoke', async () => {
      const r = await joined();
      const bare = await request(app).post(`${base}/token/refresh`).send({ refresh_token: r.tokens.refresh_token });
      assert.strictEqual(bare.status, 401);
      const junk = await request(app)
        .post(`${base}/token/refresh`)
        .send({
          refresh_token: r.tokens.refresh_token,
          timestamp: Math.floor(Date.now() / 1000),
          nonce: 'a'.repeat(32),
          signature: 'b'.repeat(128)
        });
      assert.strictEqual(junk.status, 401);
      assert.ok(await alive(r.tokens.access_token));
    });

    it('refuses a stale signature and a replayed one', async () => {
      const r = await joined();
      const stale = await doRefresh(r.tokens.refresh_token, r.signer, { ts: Math.floor(Date.now() / 1000) - 120 });
      assert.strictEqual(stale.status, 401);
      const future = await doRefresh(r.tokens.refresh_token, r.signer, { ts: Math.floor(Date.now() / 1000) + 120 });
      assert.strictEqual(future.status, 401);
      const nonce = crypto.randomBytes(16).toString('hex');
      const first = await doRefresh(r.tokens.refresh_token, r.signer, { nonce });
      assert.strictEqual(first.status, 200);
      // The very same signed request, sent again by whoever captured it.
      const body = refreshBody(first.body.refresh_token, r.signer, { nonce });
      const again = await request(app).post(`${base}/token/refresh`).send(body);
      assert.strictEqual(again.status, 401, 'a nonce was accepted twice');
      assert.ok(await alive(first.body.access_token));
    });

    it('lets the key holder retry the previous token after a lost response, and again after a second lost answer', async () => {
      const r = await joined();
      const lost = await doRefresh(r.tokens.refresh_token, r.signer);
      assert.strictEqual(lost.status, 200);
      // The app never saw that answer and asks again with the token it still holds.
      const retry = await doRefresh(r.tokens.refresh_token, r.signer);
      assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
      assert.notStrictEqual(retry.body.refresh_token, lost.body.refresh_token);
      assert.strictEqual(await alive(lost.body.access_token), false, 'the unseen pair must be dead');
      // That answer was lost too. Still the same old token, still a legitimate retry.
      const again = await doRefresh(r.tokens.refresh_token, r.signer);
      assert.strictEqual(again.status, 200, JSON.stringify(again.body));
      assert.strictEqual(await alive(retry.body.access_token), false, 'two live chains');
      assert.ok(await alive(again.body.access_token));
      // The app got this one and carries on with it.
      const next = await doRefresh(again.body.refresh_token, r.signer);
      assert.strictEqual(next.status, 200);
      // The original token is now two rotations old: nothing can retry it any more.
      const replay = await doRefresh(r.tokens.refresh_token, r.signer);
      assert.strictEqual(replay.status, 401);
      assert.strictEqual(await alive(next.body.access_token), false, 'the app must be revoked');
      assert.strictEqual((await register(app, { public_key_hex: r.key, role: 'CLIENT_ORIGIN' })).status, 403);
    });

    it('answers a byte-identical replay of a captured request with a plain 401 and changes nothing', async () => {
      const r = await joined();
      const body = refreshBody(r.tokens.refresh_token, r.signer);
      const first = await request(app).post(`${base}/token/refresh`).send(body);
      assert.strictEqual(first.status, 200);
      const before = (
        await pool.query(
          'SELECT refresh_hash, previous_refresh_hash, revoked_at FROM app_sessions WHERE node_id = $1',
          [r.grant.node_id]
        )
      ).rows[0];
      const replay = await request(app).post(`${base}/token/refresh`).send(body);
      assert.strictEqual(replay.status, 401);
      const after = (
        await pool.query(
          'SELECT refresh_hash, previous_refresh_hash, revoked_at FROM app_sessions WHERE node_id = $1',
          [r.grant.node_id]
        )
      ).rows[0];
      assert.deepStrictEqual(after, before, 'a replayed request changed the session');
      assert.strictEqual(after.revoked_at, null);
      assert.ok(await alive(first.body.access_token));
    });

    it('answers an unsigned use of a replaced token with a plain 401: nobody can sign the app out without the key', async () => {
      const r = await joined();
      const next = await doRefresh(r.tokens.refresh_token, r.signer);
      assert.strictEqual(next.status, 200);
      const unsigned = await request(app).post(`${base}/token/refresh`).send({ refresh_token: r.tokens.refresh_token });
      assert.strictEqual(unsigned.status, 401);
      const wrongKey = await doRefresh(r.tokens.refresh_token, newSigner());
      assert.strictEqual(wrongKey.status, 401);
      assert.ok(await alive(next.body.access_token), 'a thief with an old token revoked the real app');
      assert.strictEqual((await doRefresh(next.body.refresh_token, r.signer)).status, 200);
      const row = (await pool.query('SELECT revoked_at FROM app_sessions WHERE node_id = $1', [r.grant.node_id]))
        .rows[0];
      assert.strictEqual(row.revoked_at, null);
    });

    it('answers a signature from a wrong clock with a plain 401 for current and replaced tokens alike', async () => {
      const r = await joined();
      const now = Math.floor(Date.now() / 1000);
      for (const ts of [now - 3600, now + 3600]) {
        assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer, { ts })).status, 401);
      }
      const next = await doRefresh(r.tokens.refresh_token, r.signer);
      assert.strictEqual(next.status, 200);
      for (const ts of [now - 3600, now + 3600]) {
        assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer, { ts })).status, 401);
      }
      assert.ok(await alive(next.body.access_token), 'a skewed clock revoked the app');
    });

    it('revokes on a fresh valid signature over a token replaced long ago, or more than one rotation back', async () => {
      const r = await joined();
      await doRefresh(r.tokens.refresh_token, r.signer);
      await pool.query("UPDATE app_sessions SET rotated_at = NOW() - INTERVAL '25 hours' WHERE node_id = $1", [
        r.grant.node_id
      ]);
      assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer)).status, 401);
      assert.strictEqual((await register(app, { public_key_hex: r.key, role: 'CLIENT_ORIGIN' })).status, 403);

      const q = await joined();
      const one = await doRefresh(q.tokens.refresh_token, q.signer);
      const two = await doRefresh(one.body.refresh_token, q.signer);
      assert.strictEqual(two.status, 200);
      // Two rotations old: the console still recognises it, and cuts the app.
      assert.strictEqual((await doRefresh(q.tokens.refresh_token, q.signer)).status, 401);
      assert.strictEqual(await alive(two.body.access_token), false);
    });
  });

  describe('the live topology socket', () => {
    it('refuses an app token, as it refuses anything that is not a console session', async () => {
      const http = require('http');
      const WebSocket = require('ws');
      const { initTopologyWebSocket, closeTopologyWebSocket } = require('../ws/topologyServer');
      const r = await signIn(fx.tokens.memberA);
      const server = http.createServer(app);
      initTopologyWebSocket(server);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      const attempt = (url, options) =>
        new Promise((resolve) => {
          const ws = new WebSocket(url, options);
          ws.on('open', () => {
            ws.close();
            resolve('open');
          });
          ws.on('unexpected-response', (_req, res) => resolve(`http-${res.statusCode}`));
          ws.on('error', () => resolve('error'));
          ws.on('close', () => resolve('closed'));
        });
      try {
        const viaQuery = await attempt(`ws://127.0.0.1:${port}/ws/topology?token=${r.tokens.access_token}`);
        const viaHeader = await attempt(`ws://127.0.0.1:${port}/ws/topology`, {
          headers: { Authorization: `Bearer ${r.tokens.access_token}` }
        });
        assert.strictEqual(viaQuery, 'http-401');
        assert.strictEqual(viaHeader, 'http-401');
      } finally {
        await closeTopologyWebSocket();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('list and revoke', () => {
    it("lists the person's own apps, and administrators their organisation's, without secrets", async () => {
      const mine = await signIn(fx.tokens.memberA, { device_name: 'Mine' });
      const mineList = await request(app).get(`${base}/sessions`).set(bearer(fx.tokens.memberA));
      assert.strictEqual(mineList.status, 200);
      assert.ok(mineList.body.sessions.some((s) => s.node_id === mine.grant.node_id));
      assert.ok(mineList.body.sessions.every((s) => s.user_id === fx.ids.memberA));
      assert.ok(!JSON.stringify(mineList.body).match(/nna_|nnr_|nnk1_|hash/));
      const other = await request(app).get(`${base}/sessions`).set(bearer(fx.tokens.member2A));
      assert.ok(!other.body.sessions.some((s) => s.node_id === mine.grant.node_id));
      const org = await request(app).get(`${base}/sessions?scope=organization`).set(bearer(fx.tokens.adminA));
      assert.ok(org.body.sessions.some((s) => s.node_id === mine.grant.node_id));
      const memberOrg = await request(app).get(`${base}/sessions?scope=organization`).set(bearer(fx.tokens.memberA));
      assert.strictEqual(memberOrg.status, 403);
      const otherOrg = await request(app).get(`${base}/sessions?scope=organization`).set(bearer(fx.tokens.adminB));
      assert.ok(!otherOrg.body.sessions.some((s) => s.node_id === mine.grant.node_id));
    });

    it('revoking cuts the node through the existing revocation path and refuses reconnection', async () => {
      const r = await signIn(fx.tokens.memberA, { device_name: 'To revoke' });
      const reg = await register(app, {
        public_key_hex: r.key,
        role: 'CLIENT_ORIGIN',
        preauth_key: r.grant.preauth_key
      });
      assert.strictEqual(reg.status, 200);
      const id = (await pool.query('SELECT id FROM app_sessions WHERE node_id = $1', [r.grant.node_id])).rows[0].id;
      // Another member of the same organisation, and an administrator of another one, cannot.
      assert.strictEqual(
        (await request(app).delete(`${base}/sessions/${id}`).set(bearer(fx.tokens.member2A))).status,
        404
      );
      assert.strictEqual(
        (await request(app).delete(`${base}/sessions/${id}`).set(bearer(fx.tokens.adminB))).status,
        404
      );
      const res = await request(app).delete(`${base}/sessions/${id}`).set(bearer(fx.tokens.memberA));
      assert.strictEqual(res.status, 200);
      assert.strictEqual((await request(app).get(`${base}/app/me`).set(bearer(r.tokens.access_token))).status, 401);
      const revoked = await pool.query('SELECT 1 FROM revoked_keys WHERE node_id = $1', [r.grant.node_id]);
      assert.strictEqual(revoked.rows.length, 1);
      const cred = await pool.query('SELECT revoked_at FROM node_credentials WHERE node_id = $1', [r.grant.node_id]);
      assert.ok(
        cred.rows.every((c) => c.revoked_at),
        'a credential of the removed node is still live'
      );
      const gone = await pool.query('SELECT 1 FROM nodes WHERE id = $1', [r.grant.node_id]);
      assert.strictEqual(gone.rows.length, 0, 'the node row must go with the app');
      const back = await register(app, { public_key_hex: r.key, role: 'CLIENT_ORIGIN' });
      assert.strictEqual(back.status, 403);
      assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer)).status, 401);
      await settleAuditWrites();
      const ev = await pool.query(
        "SELECT message, metadata_json FROM audit_events WHERE event_type = 'APP_SESSION_REVOKED'"
      );
      assert.ok(ev.rows.length >= 1);
      assert.ok(!JSON.stringify(ev.rows).match(/nna_|nnr_|nnk1_/));
    });

    it('lets an organisation administrator revoke, and spends an unused grant', async () => {
      const r = await signIn(fx.tokens.memberA, { device_name: 'Unjoined' });
      const id = (await pool.query('SELECT id FROM app_sessions WHERE node_id = $1', [r.grant.node_id])).rows[0].id;
      assert.strictEqual(
        (await request(app).delete(`${base}/sessions/${id}`).set(bearer(fx.tokens.adminA))).status,
        200
      );
      const reg = await register(app, {
        public_key_hex: r.key,
        role: 'CLIENT_ORIGIN',
        preauth_key: r.grant.preauth_key
      });
      assert.ok([401, 403].includes(reg.status), `unused grant still worked: ${reg.status}`);
    });

    it('audits sign-in steps without secrets', async () => {
      await settleAuditWrites();
      const ev = await pool.query(
        "SELECT event_type, message, metadata_json FROM audit_events WHERE event_type LIKE 'APP_%'"
      );
      const types = new Set(ev.rows.map((e) => e.event_type));
      for (const t of ['APP_SIGNIN_STARTED', 'APP_SIGNIN_APPROVED', 'APP_SIGNIN_DENIED', 'APP_SESSION_ISSUED']) {
        assert.ok(types.has(t), `missing audit event ${t}`);
      }
      assert.ok(!JSON.stringify(ev.rows).match(/nna_|nnr_|nnk1_|[0-9a-f]{64}/));
    });
  });

  // ---- Findings of the independent review of the first version -------------------------------

  async function joinApp(token = fx.tokens.memberA, over = {}) {
    const r = await signIn(token, over);
    const reg = await register(app, {
      public_key_hex: r.key,
      role: 'CLIENT_ORIGIN',
      preauth_key: r.grant.preauth_key
    });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
    r.sessionId = (await pool.query('SELECT id FROM app_sessions WHERE node_id = $1', [r.grant.node_id])).rows[0].id;
    return r;
  }
  const revokeApp = (token, r) => request(app).delete(`${base}/sessions/${r.sessionId}`).set(bearer(token));
  const meStatus = async (access) => (await request(app).get(`${base}/app/me`).set(bearer(access))).status;
  const node = async (id) => (await pool.query('SELECT * FROM nodes WHERE id = $1', [id])).rows[0];
  let rawSession = 0;
  let nodeSeq = 0;
  // A session row written straight to the table, to test what the service does with rows it
  // did not make itself.
  async function insertSession(over = {}) {
    rawSession += 1;
    const row = {
      id: `aps_${String(rawSession).padStart(24, '0')}`,
      user_id: fx.ids.memberA,
      organization_id: fx.orgs.A,
      installation_public_key: crypto.randomBytes(32).toString('hex'),
      signing_public_key: newSigner().pub,
      node_id: `pk_${crypto.randomBytes(8).toString('hex')}`,
      platform: 'linux',
      device_name: 'raw',
      ...over
    };
    await pool.query(
      `INSERT INTO app_sessions (id, user_id, organization_id, installation_public_key, signing_public_key, node_id,
                                 platform, device_name, scopes, access_hash, access_expires_at, refresh_hash,
                                 refresh_expires_at, auth_epoch, absolute_expires_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, ARRAY['app:self'], $9, NOW() + INTERVAL '1 hour', $10,
              NOW() + INTERVAL '1 day', u.console_auth_epoch, NOW() + INTERVAL '30 days'
         FROM users u WHERE u.id = $2`,
      [
        row.id,
        row.user_id,
        row.organization_id,
        row.installation_public_key,
        row.signing_public_key,
        row.node_id,
        row.platform,
        row.device_name,
        crypto.randomBytes(32).toString('hex'),
        crypto.randomBytes(32).toString('hex')
      ]
    );
    return row;
  }
  async function insertNode(id, over = {}) {
    nodeSeq += 1;
    const n = {
      user_id: fx.ids.memberA,
      public_key: crypto.randomBytes(32).toString('hex'),
      gateway: null,
      quarantined: false,
      ...over
    };
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy,
                          is_quarantined, quarantine_reason, profile_gateway_endpoint, device_kind)
       VALUES ($1, $2, $3, $1, $4, $5, $6, 'CLIENT_ORIGIN', TRUE, $7, $8, $9, 'mesh')`,
      [
        id,
        fx.orgs.A,
        n.user_id,
        `100.64.${150 + Math.floor(nodeSeq / 200)}.${(nodeSeq % 200) + 1}`,
        `fd00:${nodeSeq + 500}::1`,
        n.public_key,
        n.quarantined,
        n.quarantined ? 'Manual security quarantine' : null,
        n.gateway
      ]
    );
    return n;
  }

  describe('revocation outlives the 24 hour revoked-key list and removes the node', () => {
    it('refuses the revoked key after its revoked_keys entry expired, and the node row is gone', async () => {
      const r = await joinApp();
      assert.strictEqual((await revokeApp(fx.tokens.memberA, r)).status, 200);
      assert.strictEqual(await node(r.grant.node_id), undefined, 'the node row stayed');
      await pool.query("UPDATE revoked_keys SET expires_at = NOW() - INTERVAL '1 day' WHERE node_id = $1", [
        r.grant.node_id
      ]);
      const back = await register(app, { public_key_hex: r.key, role: 'CLIENT_ORIGIN' });
      assert.strictEqual(back.status, 403, JSON.stringify(back.body));
      assert.strictEqual(await node(r.grant.node_id), undefined, 'the refused registration re-created the node');
      // A new sign-in cannot take the key back either.
      const s = await start({ public_key_hex: r.key });
      const a = await approve(fx.tokens.memberA, s.body.user_code);
      assert.strictEqual(a.status, 409);
      assert.strictEqual(a.body.code, 'installation_revoked');
    });

    it('does the same when reuse of a replaced token revokes the app', async () => {
      const r = await joinApp();
      const one = await doRefresh(r.tokens.refresh_token, r.signer);
      await doRefresh(one.body.refresh_token, r.signer);
      assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer)).status, 401);
      assert.strictEqual(await node(r.grant.node_id), undefined);
      await pool.query("UPDATE revoked_keys SET expires_at = NOW() - INTERVAL '1 day' WHERE node_id = $1", [
        r.grant.node_id
      ]);
      assert.strictEqual((await register(app, { public_key_hex: r.key, role: 'CLIENT_ORIGIN' })).status, 403);
    });

    it('keeps the row of a node an administrator blocked, so signing out cannot erase the block', async () => {
      const r = await joinApp();
      await pool.query(
        "UPDATE nodes SET is_quarantined = TRUE, quarantine_reason = 'Manual security quarantine' WHERE id = $1",
        [r.grant.node_id]
      );
      assert.strictEqual((await revokeApp(fx.tokens.memberA, r)).status, 200);
      const row = await node(r.grant.node_id);
      assert.ok(row && row.is_quarantined, 'the blocked node row was erased');
      await pool.query("UPDATE revoked_keys SET expires_at = NOW() - INTERVAL '1 day' WHERE node_id = $1", [
        r.grant.node_id
      ]);
      assert.strictEqual((await register(app, { public_key_hex: r.key, role: 'CLIENT_ORIGIN' })).status, 403);
      // The block was the test's: leave the person without a blocked device for the tests that follow.
      await pool.query('DELETE FROM nodes WHERE id = $1', [r.grant.node_id]);
    });

    it('never removes a node that serves profile devices', async () => {
      const r = await joinApp();
      await pool.query("UPDATE nodes SET profile_gateway_endpoint = 'gw.example.com:51820' WHERE id = $1", [
        r.grant.node_id
      ]);
      assert.strictEqual((await revokeApp(fx.tokens.memberA, r)).status, 200);
      assert.ok(await node(r.grant.node_id), 'a gateway node was removed by an app sign-out');
      assert.strictEqual(await meStatus(r.tokens.access_token), 401, 'the app itself is still signed out');
      await pool.query('DELETE FROM nodes WHERE id = $1', [r.grant.node_id]);
    });

    it("cuts a node only when the session is that node's own: same owner and the full key", async () => {
      const gateway = await insertNode('pk_aaaaaaaaaaaaaaaa', {
        user_id: fx.ids.adminA,
        gateway: 'gw.example.com:51820'
      });
      // A session that merely names the node id, from another person, with another key.
      const raw = await insertSession({ node_id: 'pk_aaaaaaaaaaaaaaaa' });
      const res = await request(app).delete(`${base}/sessions/${raw.id}`).set(bearer(fx.tokens.memberA));
      assert.strictEqual(res.status, 200);
      const row = await node('pk_aaaaaaaaaaaaaaaa');
      assert.ok(row, 'a session that did not own the node removed it');
      assert.strictEqual(row.public_key, gateway.public_key);
      const keys = await pool.query('SELECT 1 FROM revoked_keys WHERE node_id = $1', ['pk_aaaaaaaaaaaaaaaa']);
      assert.strictEqual(keys.rows.length, 0, 'the gateway key was put on the revoked list');
      // Same owner, same 8-byte id, but another full key: still not that node.
      await insertNode('pk_bbbbbbbbbbbbbbbb', { user_id: fx.ids.memberA });
      const raw2 = await insertSession({ node_id: 'pk_bbbbbbbbbbbbbbbb' });
      assert.strictEqual(
        (await request(app).delete(`${base}/sessions/${raw2.id}`).set(bearer(fx.tokens.memberA))).status,
        200
      );
      assert.ok(await node('pk_bbbbbbbbbbbbbbbb'), 'a partial key match removed the node');
    });

    it('allows one live session per node at the database level', async () => {
      const first = await insertSession({ node_id: 'pk_cccccccccccccccc' });
      await assert.rejects(insertSession({ node_id: 'pk_cccccccccccccccc' }), /uq_app_sessions_active_node|duplicate/);
      await pool.query('UPDATE app_sessions SET revoked_at = NOW() WHERE id = $1', [first.id]);
      await insertSession({ node_id: 'pk_cccccccccccccccc' });
    });

    it('ends the app token when the node is deleted in the console', async () => {
      const r = await joinApp();
      assert.strictEqual(await meStatus(r.tokens.access_token), 200);
      await pool.query('DELETE FROM nodes WHERE id = $1', [r.grant.node_id]);
      assert.strictEqual(await meStatus(r.tokens.access_token), 401);
      assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer)).status, 401);
    });
  });

  describe('who may approve', () => {
    it('refuses a read-only role, which may not create nodes', async () => {
      const s = (await start()).body;
      const a = await approve(fx.tokens.auditorA, s.user_code);
      assert.strictEqual(a.status, 403, JSON.stringify(a.body));
      const status = (await pool.query('SELECT status FROM app_device_codes ORDER BY created_at DESC LIMIT 1')).rows[0]
        .status;
      assert.strictEqual(status, 'pending', 'a read-only person approved an app');
    });

    it('ends an app whose person was made read-only after the approval', async () => {
      const r = await joinApp();
      await pool.query("UPDATE memberships SET role = 'auditor' WHERE user_id = $1", [fx.ids.memberA]);
      try {
        assert.strictEqual(await meStatus(r.tokens.access_token), 401);
        assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer)).status, 401);
      } finally {
        await pool.query("UPDATE memberships SET role = 'member' WHERE user_id = $1", [fx.ids.memberA]);
      }
    });
  });

  describe('the installation key is proven at start', () => {
    it('refuses a start without proof, with a proof for another key, and a proof used twice', async () => {
      const key = nodeKey();
      const bare = await start({ public_key_hex: key, nonce: undefined, proof: undefined });
      assert.strictEqual(bare.status, 401, JSON.stringify(bare.body));
      const other = nodeKey();
      const proofOfOther = await proveKey(app, other, 'APP_SIGNIN');
      const wrong = await start({ public_key_hex: key, ...proofOfOther });
      assert.strictEqual(wrong.status, 401);
      const proof = await proveKey(app, key, 'APP_SIGNIN');
      assert.strictEqual((await start({ public_key_hex: key, ...proof })).status, 200);
      assert.strictEqual((await start({ public_key_hex: key, ...proof })).status, 401, 'a proof was accepted twice');
      // A proof made for registering is not a proof for signing in.
      const registerProof = await proveKey(app, key, 'CLIENT_ORIGIN');
      assert.strictEqual((await start({ public_key_hex: key, ...registerProof })).status, 401);
    });

    it('will not approve an installation whose node exists but was not made by an app sign-in', async () => {
      const key = nodeKey();
      const id = `pk_${key.slice(0, 16)}`;
      await insertNode(id, { user_id: fx.ids.memberA, public_key: key, gateway: 'gw.example.com:51820' });
      const s = (await start({ public_key_hex: key })).body;
      const a = await approve(fx.tokens.memberA, s.user_code);
      assert.strictEqual(a.status, 409);
      assert.strictEqual(a.body.code, 'installation_in_use');
      assert.ok(await node(id), 'the gateway is untouched');
    });

    it('will not approve a key that another person has an active app session for', async () => {
      const key = nodeKey();
      await insertSession({
        installation_public_key: key,
        node_id: `pk_${key.slice(0, 16)}`,
        user_id: fx.ids.memberB,
        organization_id: fx.orgs.B
      });
      const s = (await start({ public_key_hex: key })).body;
      const a = await approve(fx.tokens.memberA, s.user_code);
      assert.strictEqual(a.status, 409);
    });
  });

  describe('an app token is only as good as the account behind it', () => {
    it("ends when the account's authentication epoch moves (password, role, MFA change, revoke all sessions)", async () => {
      const r = await joinApp();
      await pool.query('UPDATE users SET console_auth_epoch = console_auth_epoch + 1 WHERE id = $1', [fx.ids.memberA]);
      assert.strictEqual(await meStatus(r.tokens.access_token), 401);
      assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer)).status, 401);
    });

    it('ends at its absolute lifetime however often it was refreshed', async () => {
      const r = await joinApp();
      await pool.query("UPDATE app_sessions SET absolute_expires_at = NOW() - INTERVAL '1 second' WHERE node_id = $1", [
        r.grant.node_id
      ]);
      assert.strictEqual(await meStatus(r.tokens.access_token), 401);
      assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer)).status, 401);
    });

    it('re-checks the blocked-device rule when the app collects its tokens and when it refreshes', async () => {
      const key = nodeKey();
      const signer = newSigner();
      const s = (await start({ public_key_hex: key, signing_key: signer.pub })).body;
      assert.strictEqual((await approve(fx.tokens.memberA, s.user_code)).status, 200);
      await insertNode('pk_dddddddddddddddd', { user_id: fx.ids.memberA, quarantined: true });
      try {
        await forcePollable(s.device_code);
        const p = await poll(s.device_code);
        assert.notStrictEqual(p.body.status, 'approved', 'an app was issued to a person with a blocked device');
      } finally {
        await pool.query("DELETE FROM nodes WHERE id = 'pk_dddddddddddddddd'");
      }
      const r = await joinApp();
      await insertNode('pk_eeeeeeeeeeeeeeee', { user_id: fx.ids.memberA, quarantined: true });
      try {
        assert.strictEqual((await doRefresh(r.tokens.refresh_token, r.signer)).status, 401);
      } finally {
        await pool.query("DELETE FROM nodes WHERE id = 'pk_eeeeeeeeeeeeeeee'");
      }
    });
  });

  describe('the second factor is fresh, used once, and audited', () => {
    it('accepts a code only once', async () => {
      const code = totp(0);
      const one = (await start()).body;
      assert.strictEqual((await approve(mfaToken, one.user_code, { totp_code: code })).status, 200);
      const two = (await start()).body;
      const reuse = await approve(mfaToken, two.user_code, { totp_code: code });
      assert.strictEqual(reuse.status, 401);
      assert.strictEqual(reuse.body.code, 'mfa_invalid');
    });

    it('audits failed proofs, and keeps a recovery code when the approval itself fails', async () => {
      const [good] = TotpService.generateRecoveryCodes(1);
      await pool.query('UPDATE users SET totp_recovery_codes = $2::jsonb WHERE id = $1', [
        fx.ids.member2A,
        JSON.stringify([TotpService.hashRecoveryCode(good)])
      ]);
      const failed = (await start()).body;
      await approve(mfaToken, failed.user_code, { totp_code: '111111' });
      await settleAuditWrites();
      const ev = await pool.query("SELECT message FROM audit_events WHERE event_type = 'APP_SIGNIN_MFA_FAILED'");
      assert.ok(ev.rows.length >= 1, 'a failed second factor left no audit event');
      assert.ok(!JSON.stringify(ev.rows).includes('111111'));

      await pool.query(
        `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role,
                            is_healthy, is_quarantined, quarantine_reason, device_kind)
         VALUES ('dev-app-blocked2', $1, $2, 'blocked', '100.64.91.1', 'fd00:91::1', $3, 'CLIENT_ORIGIN', FALSE, TRUE,
                 'Manual security quarantine', 'profile')`,
        [fx.orgs.A, fx.ids.member2A, nodeKey()]
      );
      const s = (await start()).body;
      const refused = await approve(mfaToken, s.user_code, { recovery_code: good });
      assert.strictEqual(refused.status, 403);
      await pool.query("DELETE FROM nodes WHERE id = 'dev-app-blocked2'");
      const left = (await pool.query('SELECT totp_recovery_codes FROM users WHERE id = $1', [fx.ids.member2A])).rows[0];
      assert.strictEqual(left.totp_recovery_codes.length, 1, 'the recovery code was spent by a refused approval');
      const ok = await approve(mfaToken, s.user_code, { recovery_code: good });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      const spent = (await pool.query('SELECT totp_recovery_codes FROM users WHERE id = $1', [fx.ids.member2A]))
        .rows[0];
      assert.strictEqual(spent.totp_recovery_codes.length, 0);
    });
  });

  describe('rate limits', () => {
    it('meters start by address, poll by device code and refresh by address', () => {
      const dir = path.resolve(__dirname, '..');
      const res = spawnSync(process.execPath, [path.join(dir, 'tests', 'helpers', 'appSigninLimitProbe.js')], {
        cwd: dir,
        env: { ...process.env, SOVEREIGN_RATE_LIMIT_DISABLED: 'false' },
        encoding: 'utf8'
      });
      assert.strictEqual(res.status, 0, `probe failed: ${res.stderr}`);
      const line = String(res.stdout)
        .split(String.fromCharCode(10))
        .map((l) => l.trim())
        .find((l) => l.startsWith('PROBE_RESULT '));
      assert.ok(line, `probe printed no result: ${res.stdout}`);
      const r = JSON.parse(line.slice('PROBE_RESULT '.length));
      assert.strictEqual(r.startAllowed, 30);
      assert.strictEqual(r.startLast, 429);
      assert.strictEqual(r.startOtherAddress, 200);
      assert.strictEqual(r.pollFirst, 200);
      assert.strictEqual(r.pollLast, 429);
      assert.strictEqual(r.pollOtherCode, 200, 'one app polling hard slowed another');
      assert.strictEqual(r.refreshFirst, 401);
      assert.strictEqual(r.refreshLast, 429);
      assert.deepStrictEqual(r.approveCodes, [404, 404, 404, 404, 404, 429], 'approve is not limited to 5 per person');
      assert.strictEqual(r.approveOtherPerson, 404, 'one person used another person budget');
    });
  });
});
