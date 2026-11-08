const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { createApp } = require('../server');
const { AuditChainService } = require('../services/AuditChainService');
const { settleAuditWrites } = require('../utils/audit');
const enrolment = require('./helpers/nodeEnrolment');
const Preauth = require('../services/PreAuthKeyService');

describe('Production audit callers preserve admitted tenant context', () => {
  const orgA = 'org-audit-callers-a';
  const orgB = 'org-audit-callers-b';
  const actor = 'usr-audit-callers';
  const password = 'caller-fixture-password';
  let db, app, admin, member;

  async function row(type, target) {
    await settleAuditWrites();
    const result = await db.pool.query(
      'SELECT * FROM audit_events WHERE event_type=$1 AND target_id=$2 ORDER BY id DESC LIMIT 1',
      [type, target]
    );
    assert.equal(result.rowCount, 1, `${type} must really be persisted`);
    return result.rows[0];
  }

  before(async () => {
    db = await setupTestDatabase();
    assert.match(db.dbName, /^neronet_t_/);
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='audit_events' AND column_name='organization_id'"
        )
      ).rows[0].n,
      1
    );
    console.info(
      `Caller runtime Node ${process.version}; PostgreSQL ${(await db.pool.query('SHOW server_version')).rows[0].server_version}`
    );
    app = createApp();
    for (const org of [orgA, orgB])
      await db.pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$1,$1)', [org]);
    await db.pool.query(
      "INSERT INTO users(id,username,email,password_hash,role,organization_id) VALUES($1,$1,$2,$3,'user',$4)",
      [actor, `${actor}@audit.test`, bcrypt.hashSync(password, 4), orgA]
    );
    await db.pool.query("INSERT INTO memberships(id,user_id,organization_id,role) VALUES($1,$2,$3,'admin')", [
      `mem-${actor}`,
      actor,
      orgA
    ]);
    member = await issueConsoleTestToken({ id: actor, username: actor, role: 'user', organization_id: orgA });
    admin = await issueConsoleTestToken({
      id: 'usr-admin',
      username: 'admin',
      role: 'super-admin',
      organization_id: 'org-default'
    });
  });
  after(async () => {
    await settleAuditWrites();
    if (db) await db.cleanup();
  });

  it('login event uses the principal actually issued under the session lock', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: actor, password, organization_id: orgB });
    assert.equal(response.status, 200);
    assert.equal(response.body.user.organization_id, orgA);
    assert.equal((await row('AUTH_LOGIN', actor)).organization_id, response.body.user.organization_id);
  });

  it('keeps the issued principal scope when the account moves before audit delivery', async () => {
    // Scheduling only: issue the real session first, then move the account after
    // its admission transaction commits. Moving before admission correctly fails
    // the password snapshot check and must never be made to succeed by this test.
    const Mfa = require('../services/MfaSessionService');
    const originalSignIn = Mfa.signIn;
    Mfa.signIn = async (options) => {
      const session = await originalSignIn(options);
      await db.pool.query('UPDATE users SET organization_id=$1 WHERE id=$2', [orgB, actor]);
      return session;
    };
    try {
      const response = await request(app).post('/api/auth/login').send({ username: actor, password });
      assert.equal(response.status, 200);
      assert.equal(response.body.user.organization_id, orgA);
      assert.equal((await row('AUTH_LOGIN', actor)).organization_id, response.body.user.organization_id);
    } finally {
      Mfa.signIn = originalSignIn;
      await db.pool.query('UPDATE users SET organization_id=$1 WHERE id=$2', [orgA, actor]);
    }
  });

  it('records the accepted principal username rather than an obsolete password lookup snapshot', async () => {
    const Mfa = require('../services/MfaSessionService');
    const originalSignIn = Mfa.signIn;
    const renamed = `${actor}-renamed`;
    Mfa.signIn = async (options) => {
      await db.pool.query('UPDATE users SET username=$1 WHERE id=$2', [renamed, actor]);
      return originalSignIn(options);
    };
    try {
      const response = await request(app).post('/api/auth/login').send({ username: actor, password });
      assert.equal(response.status, 200);
      assert.equal(response.body.user.username, renamed);
      assert.equal((await row('AUTH_LOGIN', actor)).actor_username, renamed);
    } finally {
      Mfa.signIn = originalSignIn;
      await db.pool.query('UPDATE users SET username=$1 WHERE id=$2', [actor, actor]);
    }
  });

  it('pre-auth creation preserves the real actor and persisted resource organization', async () => {
    const response = await request(app)
      .post('/api/preauth-keys')
      .auth(member, { type: 'bearer' })
      .send({ organization_id: orgB });
    assert.equal(response.status, 201);
    const event = await row('preauth_key.created', response.body.id);
    assert.equal(event.actor_user_id, actor);
    assert.equal(event.organization_id, orgA);
  });

  it('cross-organization pre-auth revocation uses the mutated key scope and keeps its public response', async () => {
    const key = await Preauth.createPreAuthKey({ ownerId: actor, organizationId: orgB });
    const response = await request(app).delete(`/api/preauth-keys/${key.id}`).auth(admin, { type: 'bearer' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { success: true, id: key.id });
    assert.ok((await db.pool.query('SELECT revoked_at FROM preauth_keys WHERE id=$1', [key.id])).rows[0].revoked_at);
    const event = await row('preauth_key.revoked', key.id);
    assert.equal(event.organization_id, orgB);
    assert.equal(event.actor_user_id, 'usr-admin');
  });

  it('cross-organization ACL creation/update/deletion use the resource organization', async () => {
    const created = await request(app)
      .post('/api/acl/rules')
      .auth(admin, { type: 'bearer' })
      .send({ organization_id: orgB, source_cidr: '10.2.0.0/16', action: 'DROP' });
    assert.equal(created.status, 201);
    const id = created.body.rule.id;
    const updated = await request(app)
      .put(`/api/acl/rules/${id}`)
      .auth(admin, { type: 'bearer' })
      .send({ description: 'tenant context' });
    assert.equal(updated.status, 200);
    const deleted = await request(app).delete(`/api/acl/rules/${id}`).auth(admin, { type: 'bearer' });
    assert.equal(deleted.status, 200);
    for (const type of ['ACL_RULE_CREATED', 'ACL_RULE_UPDATED', 'ACL_RULE_DELETED'])
      assert.equal((await row(type, id)).organization_id, orgB, type);
  });

  it('global ACL remains unattributed even for a principal in org-default', async () => {
    const response = await request(app).post('/api/acl/rules').auth(admin, { type: 'bearer' }).send({ action: 'DROP' });
    assert.equal(response.status, 201);
    assert.equal((await row('ACL_RULE_CREATED', response.body.rule.id)).organization_id, null);
  });

  it('captures admitted context before asynchronous delivery and actor transfer', async () => {
    const original = AuditChainService.appendEvent;
    let release, started;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    AuditChainService.appendEvent = async function (event) {
      if (event.eventType === 'preauth_key.created') {
        started();
        await barrier;
      }
      return original.call(this, event);
    };
    let timer;
    try {
      const pending = request(app)
        .post('/api/preauth-keys')
        .auth(member, { type: 'bearer' })
        .send({})
        .then((response) => response);
      await Promise.race([
        entered,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The actual pre-auth handler did not reach its audit write')),
            8000
          );
        })
      ]);
      clearTimeout(timer);
      await db.pool.query('UPDATE users SET organization_id=$1 WHERE id=$2', [orgB, actor]);
      release();
      const response = await pending;
      assert.equal(response.status, 201);
      assert.equal(response.body.organization_id, orgA);
      assert.equal((await row('preauth_key.created', response.body.id)).organization_id, orgA);
    } finally {
      clearTimeout(timer);
      release();
      AuditChainService.appendEvent = original;
      await db.pool.query('UPDATE users SET organization_id=$1 WHERE id=$2', [orgA, actor]);
    }
  });

  it('deleting another organization user attributes the deleted RETURNING row', async () => {
    const id = 'usr-audit-callers-delete';
    await db.pool.query(
      "INSERT INTO users(id,username,email,password_hash,organization_id) VALUES($1,$1,$2,'hash',$3)",
      [id, `${id}@audit.test`, orgB]
    );
    const response = await request(app).delete(`/api/users/${id}`).auth(admin, { type: 'bearer' });
    assert.equal(response.status, 200);
    assert.equal((await row('USER_DELETE', id)).organization_id, orgB);
  });

  it('public registration preserves an unassigned inserted account without accepting body scope hints', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ username: 'audit-caller-register', password, organization_id: orgB });
    assert.equal(response.status, 201);
    const user = (
      await db.pool.query('SELECT id, organization_id FROM users WHERE username=$1', ['audit-caller-register'])
    ).rows[0];
    assert.equal(user.organization_id, null);
    assert.equal((await row('USER_REGISTER', user.id)).organization_id, user.organization_id);
  });

  it('administrative user creation attributes the inserted account', async () => {
    const response = await request(app)
      .post('/api/users')
      .auth(admin, { type: 'bearer' })
      .send({ username: 'audit-caller-created', password, organization_id: orgB });
    assert.equal(response.status, 201);
    const user = (await db.pool.query('SELECT organization_id FROM users WHERE id=$1', [response.body.user.id]))
      .rows[0];
    assert.equal((await row('USER_CREATE', response.body.user.id)).organization_id, user.organization_id);
  });

  it('logout records the admitted principal even after its session is revoked', async () => {
    const token = await issueConsoleTestToken({ id: actor, username: actor, role: 'user', organization_id: orgA });
    const response = await request(app)
      .post('/api/auth/logout')
      .auth(token, { type: 'bearer' })
      .send({ organization_id: orgB });
    assert.equal(response.status, 200);
    assert.equal((await row('AUTH_LOGOUT', actor)).organization_id, orgA);
  });

  it('cross-organization account session revocation records the locked target account scope', async () => {
    const id = 'usr-audit-revoke-target';
    await db.pool.query(
      "INSERT INTO users(id,username,email,password_hash,organization_id) VALUES($1,$1,$2,'hash',$3)",
      [id, `${id}@audit.test`, orgB]
    );
    await issueConsoleTestToken({ id, username: id, role: 'user', organization_id: orgB });
    const response = await request(app)
      .post(`/api/users/${id}/revoke-sessions`)
      .auth(admin, { type: 'bearer' })
      .send({ organization_id: orgA });
    assert.equal(response.status, 200);
    assert.ok(response.body.revoked_count > 0);
    assert.equal((await row('USER_REVOKE_SESSIONS', id)).organization_id, orgB);
  });

  it('MFA setup and enrollment preserve the admitted account organization', async () => {
    const id = 'usr-audit-mfa-target';
    await db.pool.query('INSERT INTO users(id,username,email,password_hash,organization_id) VALUES($1,$1,$2,$3,$4)', [
      id,
      `${id}@audit.test`,
      bcrypt.hashSync(password, 4),
      orgB
    ]);
    const token = await issueConsoleTestToken({ id, username: id, role: 'user', organization_id: orgB });
    const setup = await request(app)
      .post('/api/auth/mfa/setup')
      .auth(token, { type: 'bearer' })
      .send({ organization_id: orgA });
    assert.equal(setup.status, 200);
    assert.equal((await row('AUTH_MFA_SETUP_STARTED', id)).organization_id, orgB);
    const code = require('../services/TotpService').generateTotp(setup.body.secret);
    const verified = await request(app)
      .post('/api/auth/mfa/verify')
      .auth(token, { type: 'bearer' })
      .send({ code, organization_id: orgA });
    assert.equal(verified.status, 200);
    assert.equal((await row('AUTH_MFA_ENROLLED', id)).organization_id, verified.body.user.organization_id);
  });

  it('MFA completion uses the principal issued under the completion lock', async () => {
    const id = 'usr-audit-mfa-locked';
    const Totp = require('../services/TotpService');
    const secret = Totp.generateSecret();
    await db.pool.query(
      'INSERT INTO users(id,username,email,password_hash,organization_id,totp_enabled,totp_secret) VALUES($1,$1,$2,$3,$4,TRUE,$5)',
      [id, `${id}@audit.test`, bcrypt.hashSync(password, 4), orgB, secret]
    );
    const pending = await request(app).post('/api/auth/login').send({ username: id, password });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.mfa_required, true);
    const Mfa = require('../services/MfaSessionService');
    const original = Mfa.complete;
    Mfa.complete = async (...args) => {
      await db.pool.query('UPDATE users SET username=$1 WHERE id=$2', [`${id}-renamed`, id]);
      return original(...args);
    };
    try {
      const verified = await request(app)
        .post('/api/auth/mfa/verify')
        .send({ mfa_token: pending.body.mfa_token, code: Totp.generateTotp(secret) });
      assert.equal(verified.status, 200);
      const event = await row('AUTH_MFA_VERIFY', id);
      assert.equal(event.organization_id, verified.body.user.organization_id);
      assert.equal(event.actor_username, verified.body.user.username);
    } finally {
      Mfa.complete = original;
    }
  });

  it('MFA setup records the account accepted under its lock rather than the earlier caller lookup', async () => {
    const id = 'usr-audit-mfa-setup-lock';
    await db.pool.query('INSERT INTO users(id,username,email,password_hash,organization_id) VALUES($1,$1,$2,$3,$4)', [
      id,
      `${id}@audit.test`,
      bcrypt.hashSync(password, 4),
      orgB
    ]);
    const token = await issueConsoleTestToken({ id, username: id, role: 'user', organization_id: orgB });
    const Mfa = require('../services/MfaSessionService');
    const original = Mfa.setup;
    Mfa.setup = async (...args) => {
      await db.pool.query('UPDATE users SET username=$1 WHERE id=$2', [`${id}-renamed`, id]);
      return original(...args);
    };
    try {
      const response = await request(app).post('/api/auth/mfa/setup').auth(token, { type: 'bearer' }).send({});
      assert.equal(response.status, 200);
      assert.equal((await row('AUTH_MFA_SETUP_STARTED', id)).actor_username, `${id}-renamed`);
    } finally {
      Mfa.setup = original;
    }
  });

  it('MFA enrollment records the completed principal scope', async () => {
    const id = 'usr-audit-mfa-enroll';
    await db.pool.query('INSERT INTO users(id,username,email,password_hash,organization_id) VALUES($1,$1,$2,$3,$4)', [
      id,
      `${id}@audit.test`,
      bcrypt.hashSync(password, 4),
      orgB
    ]);
    const token = await issueConsoleTestToken({ id, username: id, role: 'user', organization_id: orgB });
    const setup = await request(app).post('/api/auth/mfa/setup').auth(token, { type: 'bearer' }).send({});
    assert.equal(setup.status, 200);
    const code = require('../services/TotpService').generateTotp(setup.body.secret);
    const response = await request(app).post('/api/auth/mfa/verify').auth(token, { type: 'bearer' }).send({ code });
    assert.equal(response.status, 200);
    assert.equal((await row('AUTH_MFA_ENROLLED', id)).organization_id, response.body.user.organization_id);
  });

  it('re-registration mismatch retains the enrolled node scope through afterCommit', async () => {
    const key = await Preauth.createPreAuthKey({ ownerId: actor, organizationId: orgA });
    const public_key_hex = enrolment.nodeKey();
    const first = await enrolment.register(app, {
      public_key_hex,
      preauth_key: key.secret,
      role: 'CLIENT_ORIGIN',
      endpoints: [],
      capability: { country_code: 'IT' }
    });
    assert.equal(first.status, 200);
    const response = await enrolment.register(app, {
      public_key_hex,
      role: 'EXIT_BRIDGE',
      endpoints: [],
      capability: { country_code: 'FR' }
    });
    assert.equal(response.status, 200);
    assert.equal((await row('node.reregister_mismatch', first.body.assigned_node_id)).organization_id, orgA);
  });
});
