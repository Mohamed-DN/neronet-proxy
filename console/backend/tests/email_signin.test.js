// Sign-in with a username or an email, and invitations bound to an email.
//
// The email of an invitation is set only by the administrator who issues it. The account
// that accepts it carries that address, and nothing the accepting person sends can change
// it. Signing in by email must reveal nothing: an unknown address, an ambiguous one and a
// placeholder one all get the answer of an unknown username, through the same dummy
// bcrypt comparison.
const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const { settleAuditWrites } = require('../utils/audit');

const ORG = 'org-email-a';
const PASSWORD = 'Una frase lunga 7';
const OTHER_PASSWORD = 'Un altra frase 9';

describe('Sign-in by username or email, and email-bound invitations', () => {
  let dbHelper;
  let pool;
  let app;
  let ownerToken;
  let hash;
  let otherHash;
  const savedMfa = process.env.SOVEREIGN_MFA_MANDATORY;

  async function addAccount(id, { username = id, email, password = hash, status = 'active', orgRole = null } = {}) {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, status, organization_id)
       VALUES ($1, $2, $3, $4, 'user', $5, $6)`,
      [id, username, email, password, status, ORG]
    );
    if (orgRole) {
      await pool.query('INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)', [
        `mem-${id}`,
        id,
        ORG,
        orgRole
      ]);
    }
  }

  const login = (identifier, password = PASSWORD) =>
    request(app).post('/api/auth/login').send({ username: identifier, password });

  const invite = (body = {}) =>
    request(app).post(`/api/organizations/${ORG}/invitations`).set('Authorization', `Bearer ${ownerToken}`).send(body);

  const accept = (body) => request(app).post('/api/invitations/accept').send(body);

  let seq = 0;
  const freshName = () => `emailer${process.pid % 1000}x${++seq}`;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();
    hash = bcrypt.hashSync(PASSWORD, 4);
    otherHash = bcrypt.hashSync(OTHER_PASSWORD, 4);
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'Casa Email', $1, 'deny')`,
      [ORG]
    );
    await addAccount('usr-em-owner', { email: 'owner@email.test', orgRole: 'owner' });
    ownerToken = await issueConsoleTestToken({
      sub: 'usr-em-owner',
      id: 'usr-em-owner',
      username: 'usr-em-owner',
      role: 'user',
      organization_id: ORG
    });
  });

  afterEach(() => {
    mock.restoreAll();
    if (savedMfa === undefined) delete process.env.SOVEREIGN_MFA_MANDATORY;
    else process.env.SOVEREIGN_MFA_MANDATORY = savedMfa;
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('migration', () => {
    it('invitations.email is nullable, lowercase, at most 255 characters and shaped like an address', async () => {
      const col = (
        await pool.query(
          `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'invitations' AND column_name = 'email'`
        )
      ).rows[0];
      assert.ok(col, 'the email column exists');
      assert.strictEqual(col.is_nullable, 'YES');
      const insert = (email) =>
        pool.query(
          `INSERT INTO invitations (id, organization_id, token_hash, code_hash, email)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            `inv-mig-${++seq}`,
            ORG,
            crypto.randomBytes(32).toString('hex'),
            crypto.randomBytes(32).toString('hex'),
            email
          ]
        );
      await insert(null);
      for (const bad of ['Upper@Example.com', 'no-at-sign', `${'a'.repeat(250)}@example.com`, '']) {
        await assert.rejects(() => insert(bad), /check|too long/i, `rejects ${bad.slice(0, 20)}`);
      }
    });
  });

  describe('sign-in', () => {
    it('an email works as the sign-in name, whatever its case', async () => {
      await addAccount('usr-em-ada', { username: 'ada', email: 'Ada.Lovelace@Example.com' });
      const byName = await login('ada');
      assert.strictEqual(byName.status, 200, JSON.stringify(byName.body));
      const byEmail = await login('ada.lovelace@EXAMPLE.com');
      assert.strictEqual(byEmail.status, 200, JSON.stringify(byEmail.body));
      assert.strictEqual(byEmail.body.user.id, 'usr-em-ada');
      assert.ok(byEmail.body.token);
      assert.strictEqual((await login('ada.lovelace@example.com', 'wrong password')).status, 401);
    });

    it('an exact username wins over an email equal to another account’s username', async () => {
      await addAccount('usr-em-x', { username: 'xavier', email: 'shared@example.com' });
      await addAccount('usr-em-y', { username: 'shared@example.com', email: 'y@example.com', password: otherHash });
      const asUsername = await login('shared@example.com', OTHER_PASSWORD);
      assert.strictEqual(asUsername.status, 200, JSON.stringify(asUsername.body));
      assert.strictEqual(asUsername.body.user.id, 'usr-em-y');
      // The owner of that address, trying it as an email, is not let in through the other account.
      assert.strictEqual((await login('shared@example.com', PASSWORD)).status, 401);
    });

    it('an unknown email gets the answer of an unknown username, through the dummy comparison', async () => {
      const compare = mock.method(bcrypt, 'compare');
      const unknownName = await login('nobody-here');
      const unknownEmail = await login('nobody@example.com');
      assert.strictEqual(unknownName.status, 401);
      assert.strictEqual(unknownEmail.status, 401);
      assert.deepStrictEqual(unknownEmail.body, unknownName.body);
      assert.strictEqual(compare.mock.callCount(), 2, 'one comparison each, against the dummy hash');
      assert.strictEqual(compare.mock.calls[0].arguments[1], compare.mock.calls[1].arguments[1]);
      assert.ok(compare.mock.calls[0].arguments[1].startsWith('$2a$10$'));
    });

    it('an email shared by several accounts, differing only in case, signs nobody in', async () => {
      await addAccount('usr-em-d1', { username: 'dup-one', email: 'Twin@Example.com' });
      await addAccount('usr-em-d2', { username: 'dup-two', email: 'twin@example.com', password: otherHash });
      const compare = mock.method(bcrypt, 'compare');
      for (const [id, pw] of [
        ['twin@example.com', PASSWORD],
        ['TWIN@example.com', OTHER_PASSWORD]
      ]) {
        const res = await login(id, pw);
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(res.body, { error: 'Invalid username or password' });
      }
      assert.strictEqual(compare.mock.callCount(), 2, 'only the dummy comparison ran');
      assert.strictEqual((await login('dup-one')).status, 200, 'each still signs in by username');
    });

    it('the <username>@sovereign.local placeholder is not a sign-in name', async () => {
      await addAccount('usr-em-ph', { username: 'placeholder', email: 'placeholder@sovereign.local' });
      const res = await login('placeholder@sovereign.local');
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(res.body, { error: 'Invalid username or password' });
      assert.strictEqual((await login('placeholder')).status, 200);
    });

    it('a suspended account is refused by email exactly as by username', async () => {
      await addAccount('usr-em-susp', { username: 'suspended-one', email: 'susp@example.com', status: 'suspended' });
      const byName = await login('suspended-one');
      const byEmail = await login('susp@example.com');
      assert.strictEqual(byName.status, 403);
      assert.strictEqual(byEmail.status, 403);
      assert.deepStrictEqual(byEmail.body, byName.body);
      assert.strictEqual((await login('susp@example.com', 'wrong password')).status, 401);
    });

    it('an administrator who signs in by email is still asked for an authenticator', async () => {
      process.env.SOVEREIGN_MFA_MANDATORY = 'admins';
      await addAccount('usr-em-adm', { username: 'mfa-admin', email: 'mfa.admin@example.com', orgRole: 'admin' });
      const res = await login('MFA.Admin@example.com');
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.mfa_required, true);
      assert.strictEqual(res.body.token, undefined);
    });
  });

  describe('invitation with an email', () => {
    it('stores the address normalised, shows it to the administrator, and never on the public accept', async () => {
      const created = await invite({ email: '  New.Person@Example.COM ' });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      assert.strictEqual(created.body.invitation.email, 'new.person@example.com');
      const listed = await request(app)
        .get(`/api/organizations/${ORG}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const mine = listed.body.invitations.find((i) => i.id === created.body.invitation.id);
      assert.strictEqual(mine.email, 'new.person@example.com');

      const username = freshName();
      const res = await accept({ token: created.body.token, username, password: PASSWORD });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.ok(!JSON.stringify(res.body).includes('example.com'), 'the accept response carries no email');
      const user = (await pool.query('SELECT email FROM users WHERE username = $1', [username])).rows[0];
      assert.strictEqual(user.email, 'new.person@example.com');

      const byEmail = await login('NEW.PERSON@example.com');
      assert.strictEqual(byEmail.status, 200, JSON.stringify(byEmail.body));
      assert.strictEqual(byEmail.body.user.username, username);

      await settleAuditWrites();
      const audit = await pool.query(
        `SELECT * FROM audit_events WHERE target_id IN ($1) AND event_type LIKE 'INVITATION_%'`,
        [created.body.invitation.id]
      );
      assert.ok(audit.rows.length >= 2);
      assert.ok(!JSON.stringify(audit.rows).includes('new.person@example.com'), 'no email in the audit trail');
    });

    it('the accepting person cannot choose or change the address', async () => {
      const bound = await invite({ email: 'bound@example.com' });
      const u1 = freshName();
      const res = await accept({
        token: bound.body.token,
        username: u1,
        password: PASSWORD,
        email: 'attacker@example.com'
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(
        (await pool.query('SELECT email FROM users WHERE username = $1', [u1])).rows[0].email,
        'bound@example.com'
      );

      const plain = await invite();
      assert.strictEqual(plain.body.invitation.email, null);
      const u2 = freshName();
      assert.strictEqual(
        (await accept({ token: plain.body.token, username: u2, password: PASSWORD, email: 'victim@example.com' }))
          .status,
        201
      );
      assert.strictEqual(
        (await pool.query('SELECT email FROM users WHERE username = $1', [u2])).rows[0].email,
        `${u2}@sovereign.local`,
        'without an address the placeholder applies, whatever the body says'
      );
    });

    it('an address that already belongs to an account is refused when the administrator creates it', async () => {
      await addAccount('usr-em-owned', { username: 'owned', email: 'Owned@Example.com' });
      const before = (await pool.query('SELECT count(*)::int AS n FROM invitations')).rows[0].n;
      const res = await invite({ email: 'owned@example.com' });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, 'email_taken');
      assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM invitations')).rows[0].n, before);
    });

    it('refuses an address that is not one, is too long, or is a placeholder', async () => {
      for (const email of [
        'no-at-sign',
        'a@b',
        'two@@example.com',
        `${'a'.repeat(250)}@example.com`,
        42,
        'x@sovereign.local'
      ]) {
        const res = await invite({ email });
        assert.strictEqual(res.status, 400, String(email).slice(0, 30));
        assert.strictEqual(res.body.error, 'invalid_email');
      }
    });

    it('if the address was taken meanwhile, accepting fails safely and does not spend the invitation', async () => {
      const created = await invite({ email: 'late@example.com' });
      await addAccount('usr-em-late', { username: 'late-comer', email: 'LATE@example.com' });
      const res = await accept({ token: created.body.token, username: freshName(), password: PASSWORD });
      assert.ok(res.status >= 400 && res.status < 500, String(res.status));
      assert.ok(!JSON.stringify(res.body).toLowerCase().includes('late@example.com'));
      assert.notStrictEqual(res.body.error, 'username_taken');
      const stored = (await pool.query('SELECT used_at FROM invitations WHERE id = $1', [created.body.invitation.id]))
        .rows[0];
      assert.strictEqual(stored.used_at, null, 'the invitation is still usable');
    });
  });
});
