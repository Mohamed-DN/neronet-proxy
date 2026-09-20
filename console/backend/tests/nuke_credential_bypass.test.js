const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_nuke_credential_bypass.db');

const { initDatabase } = require('../server');
const { getDatabase, closeDatabase } = require('../db/index');
const { closeValkey } = require('../db/valkey');
const NukeEngine = require('../services/NukeEngine');

/**
 * The personal dead man's switch is unlocked with a credential the user chose. Some
 * modes accepted more than that: any six digit number, any string of ten characters or
 * more, and fixed strings written into the source. An attacker holding nothing but a
 * valid session could open the switch. Only the stored secret may open it.
 */
describe('Personal dead man switch: only the stored secret unlocks', () => {
  let userId;

  before(async () => {
    closeDatabase();
    process.env.SOVEREIGN_DB_PATH = TEST_DB_PATH;
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    await initDatabase();
    userId = getDatabase().prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  });

  after(() => {
    closeDatabase();
    closeValkey();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  async function configure(mode) {
    const secret = crypto.randomBytes(12).toString('hex');
    await NukeEngine.setupPersonalDMS(userId, {
      passphrase: crypto.randomBytes(12).toString('hex'),
      heartbeat_interval_seconds: 3600,
      steganography_mode: mode,
      steganography_secret: secret
    });
    return secret;
  }

  async function attempt(credential) {
    try {
      const res = await NukeEngine.unlockPersonalDMS(userId, credential);
      return { ok: true, res };
    } catch (err) {
      return { ok: false, status: err.status };
    }
  }

  for (const mode of ['reverse_password', 'split_reverse', 'shadow_password', 'mobile_otp', 'hardware_key']) {
    describe(`mode ${mode}`, () => {
      it('unlocks with the stored secret', async () => {
        const secret = await configure(mode);
        const out = await attempt(secret);
        assert.strictEqual(out.ok, true);
        assert.strictEqual(out.res.unlocked, true);
      });

      it('refuses an arbitrary six digit number', async () => {
        await configure(mode);
        const out = await attempt(String(100000 + crypto.randomInt(900000)));
        assert.strictEqual(out.ok, false, 'a six digit number opened the switch');
        assert.strictEqual(out.status, 401);
      });

      it('refuses an arbitrary string of ten characters or more', async () => {
        await configure(mode);
        const out = await attempt(crypto.randomBytes(16).toString('hex'));
        assert.strictEqual(out.ok, false, 'a long arbitrary string opened the switch');
        assert.strictEqual(out.status, 401);
      });

      it('refuses an empty credential', async () => {
        await configure(mode);
        const out = await attempt('');
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.status, 401);
      });
    });
  }
});
