// Erasing a person who owns more than one node. The erase overwrites each node's public key before
// deleting it; the column is UNIQUE, so overwriting every row with the same value made the second
// row fail and rolled the whole erase back: a person with two devices could not be erased.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { setupTestDatabase } = require('./helpers/db');
const NukeEngine = require('../modules/nuke/NukeEngine');
const { settleAuditWrites } = require('../utils/audit');

describe('erasing a person who owns two nodes', () => {
  let dbHelper;
  let pool;
  let n = 0;

  const person = async () => {
    n += 1;
    const id = `usr-two-${process.pid}-${n}`;
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, $2, $3, 'x', 'user', 'org-default')`,
      [id, `two_${process.pid}_${n}`, `${id}@erase.local`]
    );
    for (let k = 1; k <= 2; k++) {
      await pool.query(
        `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy)
         VALUES ($1, 'org-default', $2, $1, $3, $4, $5, 'CLIENT_ORIGIN', TRUE)`,
        [
          `pk_${crypto.randomBytes(8).toString('hex')}`,
          id,
          `100.64.${210 + n}.${k}`,
          `fd00:${900 + n}::${k}`,
          crypto.randomBytes(32).toString('hex')
        ]
      );
    }
    return id;
  };

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
  });

  after(async () => {
    await settleAuditWrites();
    if (dbHelper) await dbHelper.cleanup();
  });

  it('erases the account and both nodes', async () => {
    const id = await person();
    await NukeEngine.executeInstantUserDestruction(id);
    assert.strictEqual(
      (await pool.query('SELECT 1 FROM users WHERE id = $1', [id])).rows.length,
      0,
      'the person is still there'
    );
    assert.strictEqual(
      (await pool.query('SELECT 1 FROM nodes WHERE user_id = $1', [id])).rows.length,
      0,
      'a node is still there'
    );
  });
});
