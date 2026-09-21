const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { setupTestDatabase } = require('./helpers/db');
const { logAuditEvent, auditHealth } = require('../utils/audit');

/**
 * The audit ledger silently recorded nothing on PostgreSQL for the entire life of
 * the deployment: the insert named a column `metadata` where the table defines
 * `metadata_json`, the error was caught and logged, and the request carried on.
 * The SQLite branch used the correct name, so every test passed.
 *
 * These tests check the write lands and, more importantly, that a failure is
 * counted rather than swallowed — the property whose absence hid the bug.
 */
describe('the audit ledger records what it is given', () => {
  let dbHelper;

  before(async () => {
    dbHelper = await setupTestDatabase();
    await dbHelper.pool.query('DELETE FROM audit_events');
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('writes an event that can be read back', async () => {
    await logAuditEvent({
      eventType: 'ACL_RULE_CREATED',
      severity: 'warning',
      actorUsername: 'admin',
      targetId: 'acl-test-1',
      targetType: 'acl_rule',
      message: 'ACL rule acl-test-1 created',
      metadata: { source: '100.64.0.1/32' }
    });

    const res = await dbHelper.pool.query('SELECT * FROM audit_events WHERE target_id = $1', ['acl-test-1']);
    const row = res.rows[0];

    assert.ok(row, 'the event reached the table');
    assert.strictEqual(row.event_type, 'ACL_RULE_CREATED');
    assert.strictEqual(row.actor_username, 'admin');
    assert.match(JSON.stringify(row.metadata_json), /100\.64\.0\.1/);
  });

  it('records an event whose severity is an alias rather than dropping it', async () => {
    // severity is constrained to info/warn/error/critical. A caller writing
    // 'warning' had the whole record rejected and silently lost.
    await logAuditEvent({
      eventType: 'ACL_RULE_DELETED',
      severity: 'warning',
      actorUsername: 'admin',
      targetId: 'acl-test-2',
      message: 'ACL rule acl-test-2 deleted'
    });

    const res = await dbHelper.pool.query('SELECT * FROM audit_events WHERE target_id = $1', ['acl-test-2']);
    const row = res.rows[0];

    assert.ok(row, 'the record survived a severity alias');
    assert.strictEqual(row.severity, 'warn');
  });

  it('counts a failed write instead of discarding it', async () => {
    const before = auditHealth().failed_writes;

    // A NOT NULL column left empty is a write the table will refuse.
    await logAuditEvent({
      eventType: null,
      message: null
    });

    const after = auditHealth();
    assert.ok(after.failed_writes > before, 'a failed audit write must be counted, not swallowed');
    assert.strictEqual(after.status, 'degraded');
    assert.ok(after.last_failure?.reason, 'the reason is kept for the health probe');
  });
});
