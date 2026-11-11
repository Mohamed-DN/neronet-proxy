// Invitations: an administrator invites a person into their organisation; the person
// chooses their own username and password from anywhere, while public registration
// stays closed. The token is a bearer secret, so it is treated like a password: shown
// once, stored only as a hash, single use, and every failure looks the same.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const request = require('supertest');
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { settleAuditWrites } = require('../utils/audit');

const ORG_A = 'org-inv-a';
const ORG_B = 'org-inv-b';
const CODE_FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

describe('Invitations', () => {
  let dbHelper;
  let pool;
  let app;
  const tokens = {};
  const saved = {
    reg: process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION,
    mfa: process.env.SOVEREIGN_MFA_MANDATORY
  };

  async function addUser(id, { orgRole = null, platformRole = 'user', organizationId = ORG_A } = {}) {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, $1, $2, 'hash', $3, $4)`,
      [id, `${id}@inv.test`, platformRole, organizationId]
    );
    if (orgRole) {
      await pool.query('INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)', [
        `mem-${id}`,
        id,
        organizationId,
        orgRole
      ]);
    }
    return issueConsoleTestToken({ sub: id, id, username: id, role: platformRole, organization_id: organizationId });
  }

  function invite(as, orgId, body = {}) {
    return request(app)
      .post(`/api/organizations/${orgId}/invitations`)
      .set('Authorization', `Bearer ${tokens[as]}`)
      .send(body);
  }

  function list(as, orgId) {
    return request(app).get(`/api/organizations/${orgId}/invitations`).set('Authorization', `Bearer ${tokens[as]}`);
  }

  function revoke(as, orgId, id) {
    return request(app)
      .delete(`/api/organizations/${orgId}/invitations/${id}`)
      .set('Authorization', `Bearer ${tokens[as]}`);
  }

  function accept(body) {
    return request(app).post('/api/invitations/accept').send(body);
  }

  let seq = 0;
  function freshName() {
    seq += 1;
    return `invitee${process.pid % 1000}x${seq}`;
  }

  async function row(id) {
    return (await pool.query('SELECT * FROM invitations WHERE id = $1', [id])).rows[0];
  }

  async function invitationCount() {
    return (await pool.query('SELECT count(*)::int AS n FROM invitations')).rows[0].n;
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    for (const [id, name] of [
      [ORG_A, 'Casa Rossi'],
      [ORG_B, 'Casa Bianchi']
    ]) {
      await pool.query(`INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, $2, $1, 'deny')`, [
        id,
        name
      ]);
    }
    tokens.owner = await addUser('usr-inv-owner', { orgRole: 'owner' });
    tokens.admin = await addUser('usr-inv-admin', { orgRole: 'admin' });
    tokens.netadmin = await addUser('usr-inv-netadmin', { orgRole: 'network_admin' });
    tokens.auditor = await addUser('usr-inv-auditor', { orgRole: 'auditor' });
    tokens.member = await addUser('usr-inv-member', { orgRole: 'member' });
    tokens.nomember = await addUser('usr-inv-nomember');
    tokens.adminB = await addUser('usr-inv-admin-b', { orgRole: 'admin', organizationId: ORG_B });
    tokens.ownerB = await addUser('usr-inv-owner-b', { orgRole: 'owner', organizationId: ORG_B });
    tokens.super = await addUser('usr-inv-super', { platformRole: 'super-admin', organizationId: 'org-default' });
  });

  afterEach(() => {
    for (const [key, name] of [
      ['reg', 'SOVEREIGN_ALLOW_SELF_REGISTRATION'],
      ['mfa', 'SOVEREIGN_MFA_MANDATORY']
    ]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('create', () => {
    it('an owner invites a member: the link token and the short code are returned once', async () => {
      const res = await invite('owner', ORG_A, { display_name_hint: 'Zia Carla' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.match(res.body.token, TOKEN_FORMAT);
      assert.match(res.body.code, CODE_FORMAT);
      const inv = res.body.invitation;
      assert.strictEqual(inv.role, 'member');
      assert.strictEqual(inv.organization_id, ORG_A);
      assert.strictEqual(inv.display_name_hint, 'Zia Carla');
      assert.strictEqual(inv.status, 'pending');
      const days = (Date.parse(inv.expires_at) - Date.parse(inv.created_at)) / 86_400_000;
      assert.ok(Math.abs(days - 7) < 0.01, `default lifetime is 7 days, got ${days}`);
      assert.strictEqual(inv.token, undefined);
      assert.strictEqual(inv.token_hash, undefined);
      assert.strictEqual(inv.code_hash, undefined);
    });

    it('stores neither the token nor the code, only the SHA-256 of the token', async () => {
      const res = await invite('owner', ORG_A);
      assert.strictEqual(res.status, 201);
      const stored = await row(res.body.invitation.id);
      assert.strictEqual(stored.token_hash, crypto.createHash('sha256').update(res.body.token).digest('hex'));
      const plainCode = res.body.code.replace(/-/g, '');
      const everything = JSON.stringify(stored);
      assert.ok(!everything.includes(res.body.token), 'the token itself is in the database');
      assert.ok(!everything.includes(plainCode), 'the code itself is in the database');
      assert.ok(!everything.includes(res.body.code), 'the code itself is in the database');
      // Every text column of every invitation, not just this row's known columns.
      const dump = await pool.query('SELECT row_to_json(i)::text AS j FROM invitations i');
      for (const { j } of dump.rows) {
        assert.ok(!j.includes(res.body.token) && !j.includes(plainCode));
      }
    });

    it('lifetime: 1 to 30 days, nothing outside', async () => {
      const ok = await invite('owner', ORG_A, { expires_in_days: 30 });
      assert.strictEqual(ok.status, 201);
      const days = (Date.parse(ok.body.invitation.expires_at) - Date.parse(ok.body.invitation.created_at)) / 86_400_000;
      assert.ok(Math.abs(days - 30) < 0.01);
      for (const bad of [0, 31, -1, 2.5, '7', null]) {
        const before = await invitationCount();
        const res = await invite('owner', ORG_A, { expires_in_days: bad });
        assert.strictEqual(res.status, 400, `expires_in_days=${JSON.stringify(bad)} accepted`);
        assert.strictEqual(await invitationCount(), before);
      }
    });

    it('nobody invites above their own role, and owner is never invitable', async () => {
      const cases = [
        ['owner', 'admin', 201],
        ['owner', 'network_admin', 201],
        ['owner', 'auditor', 201],
        ['owner', 'member', 201],
        ['owner', 'owner', 400],
        ['admin', 'admin', 201],
        ['admin', 'network_admin', 201],
        ['admin', 'auditor', 201],
        ['admin', 'member', 201],
        ['admin', 'owner', 400],
        ['super', 'admin', 201],
        ['super', 'owner', 400],
        ['owner', 'super-admin', 400],
        ['owner', 'user', 400],
        ['owner', 'god', 400]
      ];
      for (const [as, role, status] of cases) {
        const before = await invitationCount();
        const res = await invite(as, ORG_A, { role });
        assert.strictEqual(res.status, status, `${as} inviting ${role}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.strictEqual(await invitationCount(), before + (status === 201 ? 1 : 0));
        if (status === 201) assert.strictEqual(res.body.invitation.role, role);
      }
    });

    it('roles below admin cannot invite at all', async () => {
      for (const as of ['netadmin', 'auditor', 'member']) {
        const before = await invitationCount();
        const res = await invite(as, ORG_A, { role: 'member' });
        assert.strictEqual(res.status, 403, `${as} invited someone`);
        assert.strictEqual(await invitationCount(), before);
      }
    });

    it('an account with no membership in the organisation is not told it exists', async () => {
      const res = await invite('nomember', ORG_A, { role: 'member' });
      assert.strictEqual(res.status, 404);
    });

    it('an admin of another organisation cannot invite into this one', async () => {
      const before = await invitationCount();
      for (const as of ['adminB', 'ownerB']) {
        const res = await invite(as, ORG_A, { role: 'member' });
        assert.strictEqual(res.status, 404, `${as} reached organisation A`);
      }
      assert.strictEqual(await invitationCount(), before);
    });

    it('the platform super-admin may invite into any organisation that exists', async () => {
      assert.strictEqual((await invite('super', ORG_B, { role: 'member' })).status, 201);
      assert.strictEqual((await invite('super', 'org-does-not-exist', { role: 'member' })).status, 404);
    });

    it('requires a session', async () => {
      const res = await request(app).post(`/api/organizations/${ORG_A}/invitations`).send({ role: 'member' });
      assert.strictEqual(res.status, 401);
    });

    it('is audited without the secret', async () => {
      const res = await invite('admin', ORG_A, { role: 'auditor' });
      await settleAuditWrites();
      const audit = await pool.query(
        `SELECT * FROM audit_events WHERE event_type = 'INVITATION_CREATE' AND target_id = $1`,
        [res.body.invitation.id]
      );
      assert.strictEqual(audit.rows.length, 1);
      assert.strictEqual(audit.rows[0].actor_user_id, 'usr-inv-admin');
      assert.strictEqual(audit.rows[0].organization_id, ORG_A);
      const text = JSON.stringify(audit.rows[0]);
      assert.ok(!text.includes(res.body.token) && !text.includes(res.body.code.replace(/-/g, '')));
    });
  });

  describe('list', () => {
    it('shows the organisation’s invitations and never a secret', async () => {
      const created = await invite('owner', ORG_A, { display_name_hint: 'Nonno' });
      const res = await list('admin', ORG_A);
      assert.strictEqual(res.status, 200);
      const found = res.body.invitations.find((i) => i.id === created.body.invitation.id);
      assert.ok(found);
      assert.strictEqual(found.created_by_username, 'usr-inv-owner');
      const text = JSON.stringify(res.body);
      assert.ok(!text.includes(created.body.token));
      assert.ok(!text.includes(created.body.code.replace(/-/g, '')));
      assert.ok(!/token|code_hash/.test(Object.keys(found).join(',')), Object.keys(found).join(','));
      assert.ok(res.body.invitations.every((i) => i.organization_id === ORG_A));
    });

    it('is refused to roles below admin and to other organisations', async () => {
      for (const as of ['netadmin', 'auditor', 'member']) assert.strictEqual((await list(as, ORG_A)).status, 403);
      assert.strictEqual((await list('adminB', ORG_A)).status, 404);
      const super_ = await list('super', ORG_A);
      assert.strictEqual(super_.status, 200);
    });
  });

  describe('revoke', () => {
    it('an admin revokes a pending invitation; it can no longer be accepted', async () => {
      const created = await invite('owner', ORG_A);
      const res = await revoke('admin', ORG_A, created.body.invitation.id);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.invitation.status, 'revoked');
      const stored = await row(created.body.invitation.id);
      assert.ok(stored.revoked_at);
      assert.strictEqual(stored.revoked_by, 'usr-inv-admin');
      const acc = await accept({ token: created.body.token, username: freshName(), password: 'Password123!' });
      assert.strictEqual(acc.status, 400);
      await settleAuditWrites();
      const audit = await pool.query(
        `SELECT 1 FROM audit_events WHERE event_type = 'INVITATION_REVOKE' AND target_id = $1`,
        [created.body.invitation.id]
      );
      assert.strictEqual(audit.rows.length, 1);
    });

    it('another organisation’s admin cannot revoke it and is not told it exists', async () => {
      const created = await invite('owner', ORG_A);
      const res = await revoke('adminB', ORG_A, created.body.invitation.id);
      assert.strictEqual(res.status, 404);
      // Nor through their own organisation's address.
      const sideways = await revoke('adminB', ORG_B, created.body.invitation.id);
      assert.strictEqual(sideways.status, 404);
      assert.strictEqual((await row(created.body.invitation.id)).revoked_at, null);
    });

    it('roles below admin cannot revoke', async () => {
      const created = await invite('owner', ORG_A);
      for (const as of ['netadmin', 'auditor', 'member']) {
        assert.strictEqual((await revoke(as, ORG_A, created.body.invitation.id)).status, 403);
      }
      assert.strictEqual((await row(created.body.invitation.id)).revoked_at, null);
    });

    it('a used invitation cannot be revoked', async () => {
      const created = await invite('owner', ORG_A);
      await accept({ token: created.body.token, username: freshName(), password: 'Password123!' });
      const res = await revoke('owner', ORG_A, created.body.invitation.id);
      assert.strictEqual(res.status, 409);
    });
  });

  describe('accept', () => {
    it('creates the account and its membership with the invited role; the person then signs in normally', async () => {
      const created = await invite('owner', ORG_A, { role: 'network_admin' });
      const username = freshName();
      const res = await accept({ token: created.body.token, username, password: 'Una frase lunga 7' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.username, username);
      assert.strictEqual(res.body.token, undefined, 'accepting does not sign in by itself');

      const user = (await pool.query('SELECT * FROM users WHERE username = $1', [username])).rows[0];
      assert.ok(user);
      assert.strictEqual(user.role, 'user', 'an invitation never grants a platform role');
      assert.strictEqual(user.organization_id, ORG_A);
      assert.notStrictEqual(user.password_hash, 'Una frase lunga 7');
      const membership = (await pool.query('SELECT * FROM memberships WHERE user_id = $1', [user.id])).rows;
      assert.deepStrictEqual(
        membership.map((m) => [m.organization_id, m.role]),
        [[ORG_A, 'network_admin']]
      );
      const stored = await row(created.body.invitation.id);
      assert.ok(stored.used_at);
      assert.strictEqual(stored.used_by, user.id);

      const login = await request(app).post('/api/auth/login').send({ username, password: 'Una frase lunga 7' });
      assert.strictEqual(login.status, 200, JSON.stringify(login.body));

      await settleAuditWrites();
      const audit = await pool.query(
        `SELECT * FROM audit_events WHERE event_type = 'INVITATION_ACCEPT' AND target_id = $1`,
        [created.body.invitation.id]
      );
      assert.strictEqual(audit.rows.length, 1);
      assert.strictEqual(audit.rows[0].actor_user_id, user.id);
      assert.strictEqual(audit.rows[0].organization_id, ORG_A);
    });

    it('accepts the short code as typed by a person: any case, spaces, dashes, O for 0 and I or L for 1', async () => {
      const created = await invite('owner', ORG_A);
      const typed = created.body.code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
      const res = await accept({ code: ` ${typed} `, username: freshName(), password: 'Password123!' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });

    it('works while public registration is closed, and registration stays closed', async () => {
      process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION = 'false';
      const created = await invite('owner', ORG_A);
      const acc = await accept({ token: created.body.token, username: freshName(), password: 'Password123!' });
      assert.strictEqual(acc.status, 201);
      const reg = await request(app)
        .post('/api/auth/register')
        .send({ username: freshName(), password: 'Password123!', token: created.body.token });
      assert.strictEqual(reg.status, 403);
      assert.strictEqual(reg.body.error, 'registration_disabled');
    });

    it('is single use: the second acceptance fails like any bad token and creates nobody', async () => {
      const created = await invite('owner', ORG_A);
      const first = await accept({ token: created.body.token, username: freshName(), password: 'Password123!' });
      assert.strictEqual(first.status, 201);
      const second = freshName();
      const again = await accept({ token: created.body.token, username: second, password: 'Password123!' });
      const byCode = await accept({ code: created.body.code, username: second, password: 'Password123!' });
      for (const res of [again, byCode]) {
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error, 'invitation_invalid');
      }
      assert.strictEqual((await pool.query('SELECT 1 FROM users WHERE username = $1', [second])).rows.length, 0);
    });

    it('is single use under concurrency: exactly one of many simultaneous acceptances wins', async () => {
      const created = await invite('owner', ORG_A);
      const names = Array.from({ length: 6 }, () => freshName());
      const results = await Promise.all(
        names.map((username, i) =>
          accept(
            i % 2 === 0
              ? { token: created.body.token, username, password: 'Password123!' }
              : { code: created.body.code, username, password: 'Password123!' }
          )
        )
      );
      assert.deepStrictEqual(results.map((r) => r.status).sort(), [201, 400, 400, 400, 400, 400]);
      const made = await pool.query('SELECT count(*)::int AS n FROM users WHERE username = ANY($1)', [names]);
      assert.strictEqual(made.rows[0].n, 1);
    });

    it('expired, revoked, used, unknown and malformed all get the same answer', async () => {
      const expired = await invite('owner', ORG_A);
      await pool.query(
        `UPDATE invitations SET created_at = now() - interval '8 days', expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [expired.body.invitation.id]
      );
      const revoked = await invite('owner', ORG_A);
      await revoke('owner', ORG_A, revoked.body.invitation.id);
      const used = await invite('owner', ORG_A);
      await accept({ token: used.body.token, username: freshName(), password: 'Password123!' });

      const attempts = [
        { token: expired.body.token },
        { code: expired.body.code },
        { token: revoked.body.token },
        { token: used.body.token },
        { token: crypto.randomBytes(32).toString('base64url') },
        { code: 'ABCD-EFGH-JKMN' },
        { token: 'not-a-token' },
        { code: 'UUUU-UUUU-UUUU' },
        { token: `${expired.body.token}x` },
        { token: { $ne: null } },
        { token: [expired.body.token] }
      ];
      const bodies = new Set();
      for (const secret of attempts) {
        const username = freshName();
        const res = await accept({ ...secret, username, password: 'Password123!' });
        assert.strictEqual(res.status, 400, `${JSON.stringify(secret)}: ${res.status}`);
        bodies.add(JSON.stringify(res.body));
        assert.strictEqual((await pool.query('SELECT 1 FROM users WHERE username = $1', [username])).rows.length, 0);
      }
      assert.strictEqual(bodies.size, 1, `the answers differ: ${[...bodies].join(' | ')}`);
      assert.strictEqual(JSON.parse([...bodies][0]).error, 'invitation_invalid');
    });

    it('an invitation is only as good as its author: one issued by an admin since demoted no longer works', async () => {
      await addUser('usr-inv-fallen', { orgRole: 'admin' });
      const fallen = await issueConsoleTestToken({
        sub: 'usr-inv-fallen',
        id: 'usr-inv-fallen',
        username: 'usr-inv-fallen',
        role: 'user',
        organization_id: ORG_A
      });
      const created = await request(app)
        .post(`/api/organizations/${ORG_A}/invitations`)
        .set('Authorization', `Bearer ${fallen}`)
        .send({ role: 'admin' });
      assert.strictEqual(created.status, 201);
      await pool.query("UPDATE memberships SET role = 'member' WHERE user_id = 'usr-inv-fallen'");
      const res = await accept({ token: created.body.token, username: freshName(), password: 'Password123!' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, 'invitation_invalid');
      assert.strictEqual((await row(created.body.invitation.id)).used_at, null);
    });

    it('a username already in use is refused and the invitation stays usable', async () => {
      const created = await invite('owner', ORG_A);
      const res = await accept({ token: created.body.token, username: 'usr-inv-member', password: 'Password123!' });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, 'username_taken');
      assert.strictEqual((await row(created.body.invitation.id)).used_at, null);
      const retry = await accept({ token: created.body.token, username: freshName(), password: 'Password123!' });
      assert.strictEqual(retry.status, 201);
    });

    it('checks the fields before the secret, so a missing field says nothing about the token', async () => {
      const created = await invite('owner', ORG_A);
      for (const body of [
        { token: created.body.token, username: freshName() },
        { token: created.body.token, password: 'Password123!' },
        { token: created.body.token, username: freshName(), password: '' },
        { token: created.body.token, username: freshName(), password: 42 },
        { token: created.body.token, username: 'a b', password: 'Password123!' },
        { token: created.body.token, username: 'x'.repeat(65), password: 'Password123!' },
        { username: freshName(), password: 'Password123!' },
        { token: created.body.token, code: created.body.code, username: freshName(), password: 'Password123!' }
      ]) {
        const res = await accept(body);
        assert.strictEqual(res.status, 400, JSON.stringify(body));
        assert.notStrictEqual(res.body.error, 'invitation_invalid', JSON.stringify(body));
      }
      assert.strictEqual((await row(created.body.invitation.id)).used_at, null);
    });

    it('an invited admin must enrol an authenticator at first sign-in, as any admin', async () => {
      process.env.SOVEREIGN_MFA_MANDATORY = 'admins';
      const created = await invite('owner', ORG_A, { role: 'admin' });
      const username = freshName();
      assert.strictEqual((await accept({ token: created.body.token, username, password: 'Password123!' })).status, 201);
      const login = await request(app).post('/api/auth/login').send({ username, password: 'Password123!' });
      assert.strictEqual(login.status, 200);
      assert.strictEqual(login.body.mfa_required, true);
      assert.strictEqual(login.body.mfa_setup_required, true);
      assert.strictEqual(login.body.token, undefined);

      const member = await invite('owner', ORG_A, { role: 'member' });
      const memberName = freshName();
      await accept({ token: member.body.token, username: memberName, password: 'Password123!' });
      const memberLogin = await request(app)
        .post('/api/auth/login')
        .send({ username: memberName, password: 'Password123!' });
      assert.strictEqual(memberLogin.status, 200);
      assert.ok(memberLogin.body.token, 'a member is not asked for an authenticator in admins mode');
    });
  });
});

describe('Invitation acceptance is rate limited per real client address', () => {
  it(
    'ten attempts, then 429; another address is unaffected; a forged forwarded-for prefix does not help',
    {
      timeout: 60_000
    },
    () => {
      const BACKEND_DIR = path.resolve(__dirname, '..');
      const res = spawnSync(process.execPath, [path.join(BACKEND_DIR, 'tests', 'helpers', 'invitationLimitProbe.js')], {
        cwd: BACKEND_DIR,
        env: { ...process.env, SOVEREIGN_RATE_LIMIT_DISABLED: 'false' },
        encoding: 'utf8'
      });
      assert.strictEqual(res.status, 0, `probe failed: ${res.stderr}`);
      const line = String(res.stdout)
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('PROBE_RESULT '));
      assert.ok(line, `probe printed no result:\n${res.stdout}`);
      const r = JSON.parse(line.slice('PROBE_RESULT '.length));
      assert.deepStrictEqual(r.codes, [400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 429]);
      assert.strictEqual(r.forged, 429, 'a client-supplied forwarded-for entry bought a fresh budget');
      assert.strictEqual(r.otherAddress, 400);
    }
  );
});
