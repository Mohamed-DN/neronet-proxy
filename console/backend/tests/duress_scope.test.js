const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');

// Duress passwords are chosen by the account holder. Whatever one of them destroys
// must therefore be something that account could have destroyed through the normal
// API. Before this was enforced, any user could set their own "nuclear" password and
// sign in with it to run TRUNCATE TABLE nodes, users CASCADE: every organisation on
// the platform, gone, from the login form.

// A real Curve25519 public key is needed for the revocation to be recorded.
function wgKey(seed) {
  return Buffer.alloc(32, seed).toString('base64');
}

describe('Duress passwords are scoped to what their holder may delete', () => {
  let dbHelper;
  let pool;
  let app;

  const orgA = 'org-duress-a';
  const orgB = 'org-duress-b';
  const orgRegulated = 'org-duress-reg';

  async function addOrg(id, profile = 'standard') {
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy, profile)
       VALUES ($1, $1, $1, 'open', $2) ON CONFLICT (id) DO NOTHING`,
      [id, profile]
    );
  }

  async function addUser(id, orgId, orgRole, password = 'Standard-Pass-1!', platformRole = 'user') {
    const hash = await bcrypt.hash(password, 4);
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, $1, $2, $3, $4, $5)`,
      [id, `${id}@duress.test`, hash, platformRole, orgId]
    );
    await pool.query(`INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)`, [
      `mem-${id}`,
      id,
      orgId,
      orgRole
    ]);
    return jwt.sign({ sub: id, id, username: id, role: platformRole, organization_id: orgId }, config.JWT_SECRET);
  }

  let ipCounter = 10;
  async function addNode(id, userId, orgId, { compartmentId = null, keySeed } = {}) {
    ipCounter += 1;
    await pool.query(
      `INSERT INTO nodes (id, user_id, organization_id, compartment_id, name, public_key, overlay_ipv4, overlay_ipv6)
       VALUES ($1, $2, $3, $4, $1, $5, $6, $7)`,
      [id, userId, orgId, compartmentId, wgKey(keySeed), `100.64.77.${ipCounter}`, `fd7a:115c:a1e0::77:${ipCounter}`]
    );
  }

  async function addCompartment(id, orgId, hidden) {
    ipCounter += 1;
    await pool.query(
      `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden)
       VALUES ($1, $2, $1, $1, $3, $4)`,
      [id, orgId, `100.64.${ipCounter}.0/24`, hidden]
    );
  }

  async function count(sql, params) {
    const res = await pool.query(sql, params);
    return Number(res.rows[0].n);
  }

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    await addOrg(orgA);
    await addOrg(orgB);
    await addOrg(orgRegulated, 'regulated');
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  describe('setup-passwords', () => {
    it('refuses to set duress passwords without the current password', async () => {
      const token = await addUser('usr-dp-nocur', orgA, 'member');

      const res = await request(app)
        .post('/api/auth/setup-passwords')
        .set('Authorization', `Bearer ${token}`)
        .send({ pwd_nuclear: 'Nuclear-Pass-1!' });

      assert.strictEqual(res.status, 400);
      const row = await pool.query('SELECT password_hash_nuclear_wipe FROM users WHERE id = $1', ['usr-dp-nocur']);
      assert.strictEqual(row.rows[0].password_hash_nuclear_wipe, null, 'nothing may be stored');
    });

    it('refuses a wrong current password', async () => {
      const token = await addUser('usr-dp-wrongcur', orgA, 'member');

      const res = await request(app)
        .post('/api/auth/setup-passwords')
        .set('Authorization', `Bearer ${token}`)
        .send({ current_password: 'not-the-password', pwd_standard: 'Taken-Over-1!' });

      assert.strictEqual(res.status, 400);
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'usr-dp-wrongcur', password: 'Standard-Pass-1!' });
      assert.strictEqual(login.status, 200, 'the original password must still work');
    });

    it('refuses a duress password equal to another tier, which would make it unreachable', async () => {
      const token = await addUser('usr-dp-collide', orgA, 'member');

      const res = await request(app)
        .post('/api/auth/setup-passwords')
        .set('Authorization', `Bearer ${token}`)
        .send({ current_password: 'Standard-Pass-1!', pwd_nuclear: 'Standard-Pass-1!' });

      assert.strictEqual(res.status, 400);
    });
  });

  describe('nuclear wipe', () => {
    it('destroys only the account that holds the password, never another organisation', async () => {
      const attacker = await addUser('usr-nuke-member', orgA, 'member');
      await addNode('node-nuke-own', 'usr-nuke-member', orgA, { keySeed: 1 });

      // Bystanders: a colleague in the same organisation and a whole other tenant.
      await addUser('usr-nuke-colleague', orgA, 'owner');
      await addNode('node-nuke-colleague', 'usr-nuke-colleague', orgA, { keySeed: 2 });
      await addUser('usr-nuke-other-tenant', orgB, 'owner');
      await addNode('node-nuke-other-tenant', 'usr-nuke-other-tenant', orgB, { keySeed: 3 });

      const usersBefore = await count('SELECT count(*) AS n FROM users', []);

      const setup = await request(app)
        .post('/api/auth/setup-passwords')
        .set('Authorization', `Bearer ${attacker}`)
        .send({ current_password: 'Standard-Pass-1!', pwd_nuclear: 'Nuclear-Pass-1!' });
      assert.strictEqual(setup.status, 200);

      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'usr-nuke-member', password: 'Nuclear-Pass-1!' });

      // The duress sign-in still looks like a failed one.
      assert.strictEqual(login.status, 401);
      assert.strictEqual(login.body.token, undefined);

      // Nobody else lost anything.
      assert.strictEqual(await count('SELECT count(*) AS n FROM nodes WHERE id = $1', ['node-nuke-other-tenant']), 1);
      assert.strictEqual(await count('SELECT count(*) AS n FROM nodes WHERE id = $1', ['node-nuke-colleague']), 1);
      assert.strictEqual(await count('SELECT count(*) AS n FROM users', []), usersBefore - 1);
      assert.strictEqual(await count('SELECT count(*) AS n FROM organizations WHERE id = $1', [orgB]), 1);

      // The holder's own account and devices are gone ...
      assert.strictEqual(await count('SELECT count(*) AS n FROM users WHERE id = $1', ['usr-nuke-member']), 0);
      assert.strictEqual(await count('SELECT count(*) AS n FROM nodes WHERE id = $1', ['node-nuke-own']), 0);

      // ... and their key is revoked, so peers drop the tunnel rather than keep it.
      assert.strictEqual(
        await count('SELECT count(*) AS n FROM revoked_keys WHERE node_id = $1', ['node-nuke-own']),
        1,
        'the destroyed device must be revoked on the data plane'
      );
    });

    it('does nothing for a suspended account', async () => {
      await addUser('usr-nuke-suspended', orgA, 'member');
      await pool.query(`UPDATE users SET password_hash_nuclear_wipe = $1, status = 'suspended' WHERE id = $2`, [
        await bcrypt.hash('Nuclear-Pass-2!', 4),
        'usr-nuke-suspended'
      ]);
      await addNode('node-nuke-suspended', 'usr-nuke-suspended', orgA, { keySeed: 4 });

      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'usr-nuke-suspended', password: 'Nuclear-Pass-2!' });

      assert.strictEqual(login.status, 403);
      assert.strictEqual(await count('SELECT count(*) AS n FROM users WHERE id = $1', ['usr-nuke-suspended']), 1);
      assert.strictEqual(await count('SELECT count(*) AS n FROM nodes WHERE id = $1', ['node-nuke-suspended']), 1);
    });

    it('is not honoured where the organisation has the deniability module switched off', async () => {
      await addUser('usr-nuke-regulated', orgRegulated, 'owner');
      await pool.query(`UPDATE users SET password_hash_nuclear_wipe = $1 WHERE id = $2`, [
        await bcrypt.hash('Nuclear-Pass-3!', 4),
        'usr-nuke-regulated'
      ]);
      await addNode('node-nuke-regulated', 'usr-nuke-regulated', orgRegulated, { keySeed: 5 });

      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'usr-nuke-regulated', password: 'Nuclear-Pass-3!' });

      assert.strictEqual(login.status, 401);
      assert.strictEqual(await count('SELECT count(*) AS n FROM users WHERE id = $1', ['usr-nuke-regulated']), 1);
      assert.strictEqual(await count('SELECT count(*) AS n FROM nodes WHERE id = $1', ['node-nuke-regulated']), 1);
    });
  });

  describe('stealth wipe', () => {
    before(async () => {
      await addCompartment('cmp-stealth-a-hidden', orgA, true);
      await addCompartment('cmp-stealth-a-visible', orgA, false);
      await addCompartment('cmp-stealth-b-hidden', orgB, true);
      await addUser('usr-stealth-b-owner', orgB, 'owner');
      await addNode('node-stealth-b-ghost', 'usr-stealth-b-owner', orgB, {
        compartmentId: 'cmp-stealth-b-hidden',
        keySeed: 6
      });
    });

    async function withStealthPassword(id, orgRole, password) {
      await addUser(id, orgA, orgRole);
      await pool.query('UPDATE users SET password_hash_stealth_wipe = $1 WHERE id = $2', [
        await bcrypt.hash(password, 4),
        id
      ]);
    }

    it('a plain member cannot wipe hidden compartments, not even in their own organisation', async () => {
      await withStealthPassword('usr-stealth-member', 'member', 'Stealth-Pass-1!');

      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'usr-stealth-member', password: 'Stealth-Pass-1!' });
      assert.strictEqual(login.status, 200, 'the decoy session still opens');

      assert.strictEqual(
        await count('SELECT count(*) AS n FROM compartments WHERE id = $1', ['cmp-stealth-a-hidden']),
        1
      );
      assert.strictEqual(
        await count('SELECT count(*) AS n FROM compartments WHERE id = $1', ['cmp-stealth-b-hidden']),
        1
      );
    });

    it('an owner wipes the hidden compartments of their own organisation only', async () => {
      await withStealthPassword('usr-stealth-owner', 'owner', 'Stealth-Pass-2!');
      await addNode('node-stealth-a-ghost', 'usr-stealth-owner', orgA, {
        compartmentId: 'cmp-stealth-a-hidden',
        keySeed: 7
      });

      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'usr-stealth-owner', password: 'Stealth-Pass-2!' });
      assert.strictEqual(login.status, 200);
      assert.strictEqual(login.body.user.compartment_access, 'standard');

      // Own organisation: hidden compartment and its device are gone, key revoked.
      assert.strictEqual(
        await count('SELECT count(*) AS n FROM compartments WHERE id = $1', ['cmp-stealth-a-hidden']),
        0
      );
      assert.strictEqual(await count('SELECT count(*) AS n FROM nodes WHERE id = $1', ['node-stealth-a-ghost']), 0);
      assert.strictEqual(
        await count('SELECT count(*) AS n FROM revoked_keys WHERE node_id = $1', ['node-stealth-a-ghost']),
        1
      );
      assert.strictEqual(
        await count('SELECT count(*) AS n FROM compartments WHERE id = $1', ['cmp-stealth-a-visible']),
        1
      );

      // Another tenant's ghost vault is untouched.
      assert.strictEqual(
        await count('SELECT count(*) AS n FROM compartments WHERE id = $1', ['cmp-stealth-b-hidden']),
        1
      );
      assert.strictEqual(await count('SELECT count(*) AS n FROM nodes WHERE id = $1', ['node-stealth-b-ghost']), 1);
    });

    it('the vault unlock path is scoped the same way', async () => {
      await addCompartment('cmp-stealth-a-hidden-2', orgA, true);
      await withStealthPassword('usr-stealth-unlock', 'admin', 'Stealth-Pass-3!');
      const token = jwt.sign(
        {
          sub: 'usr-stealth-unlock',
          id: 'usr-stealth-unlock',
          username: 'usr-stealth-unlock',
          role: 'user',
          organization_id: orgA
        },
        config.JWT_SECRET
      );

      const res = await request(app)
        .post('/api/compartments/unlock')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'Stealth-Pass-3!' });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(
        await count('SELECT count(*) AS n FROM compartments WHERE id = $1', ['cmp-stealth-a-hidden-2']),
        0
      );
      assert.strictEqual(
        await count('SELECT count(*) AS n FROM compartments WHERE id = $1', ['cmp-stealth-b-hidden']),
        1
      );
    });
  });

  describe('registration', () => {
    it('cannot grant itself the platform super-admin role', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'usr-self-promoted', password: 'Register-Pass-1!', role: 'super-admin' });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.user.role, 'user');
      const row = await pool.query('SELECT role FROM users WHERE username = $1', ['usr-self-promoted']);
      assert.strictEqual(row.rows[0].role, 'user');
    });
  });
});
