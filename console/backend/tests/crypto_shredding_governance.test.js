const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const config = require('../config/env');
const {
  CryptoShreddingService,
  LegalHoldActiveError,
  DualAuthorizationRequiredError,
  KeyShreddedError
} = require('../services/CryptoShreddingService');

describe('WP-302: Crypto-Shredding with Governance (NeroNuke v2)', () => {
  let dbHelper;
  let pool;
  let app;

  let testOrgId;
  let testOrg2Id;
  let admin1Id;
  let admin2Id;
  let admin1Token;
  let admin2Token;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;
    app = createApp();

    testOrgId = 'org-shred-target';
    testOrg2Id = 'org-shred-safe';

    await pool.query(
      `INSERT INTO organizations (id, name, slug, profile)
       VALUES ($1, 'Target Org', 'target-org', 'standard'),
              ($2, 'Safe Org', 'safe-org', 'standard')
       ON CONFLICT (id) DO NOTHING`,
      [testOrgId, testOrg2Id]
    );

    // Create Admin 1 (Initiator)
    admin1Id = 'usr-admin-initiator';
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, 'initiator', 'initiator@test.net', 'hash', 'super-admin', $2)
       ON CONFLICT (id) DO NOTHING`,
      [admin1Id, testOrgId]
    );

    // Create Admin 2 (Second Approver)
    admin2Id = 'usr-admin-approver';
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, 'approver', 'approver@test.net', 'hash', 'super-admin', $2)
       ON CONFLICT (id) DO NOTHING`,
      [admin2Id, testOrgId]
    );

    admin1Token = jwt.sign(
      { id: admin1Id, username: 'initiator', role: 'super-admin', organization_id: testOrgId },
      config.JWT_SECRET,
      { expiresIn: '1h' }
    );

    admin2Token = jwt.sign(
      { id: admin2Id, username: 'approver', role: 'super-admin', organization_id: testOrgId },
      config.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('1. performs envelope encryption with per-org isolated DEK', async () => {
    const sensitivePayload = 'Top Secret Organization Ledger Records 12345';
    const ciphertext = await CryptoShreddingService.encryptData(testOrgId, sensitivePayload);
    assert.ok(ciphertext);
    assert.notStrictEqual(ciphertext, sensitivePayload);

    const decrypted = await CryptoShreddingService.decryptData(testOrgId, ciphertext);
    assert.strictEqual(decrypted, sensitivePayload);

    // Isolated key test: DEK for org2 cannot decrypt org1 ciphertext
    await CryptoShreddingService.getOrCreateOrgDEK(testOrg2Id);
    await assert.rejects(async () => {
      await CryptoShreddingService.decryptData(testOrg2Id, ciphertext);
    }, /Unsupported state or unable to authenticate data|Invalid/);
  });

  it('2. blocks destruction when an active legal hold is in place', async () => {
    // Impose legal hold
    const hold = await CryptoShreddingService.imposeLegalHold(testOrgId, 'SEC Investigation Order #2026-991', admin1Id);
    assert.ok(hold.id);
    assert.strictEqual(hold.active, true);

    // Attempting to request destruction MUST fail
    await assert.rejects(async () => {
      await CryptoShreddingService.requestDestruction({
        targetType: 'organization',
        targetId: testOrgId,
        initiatorUserId: admin1Id
      });
    }, LegalHoldActiveError);

    // Release legal hold
    const released = await CryptoShreddingService.releaseLegalHold(hold.id, admin1Id);
    assert.strictEqual(released.active, false);
  });

  it('3. rejects self-approval and enforces dual-authorization (4-eyes principle)', async () => {
    // 1. Admin 1 requests destruction
    const auth = await CryptoShreddingService.requestDestruction({
      targetType: 'organization',
      targetId: testOrgId,
      initiatorUserId: admin1Id,
      comment: 'Customer GDPR complete purge request'
    });
    assert.ok(auth.id);
    assert.strictEqual(auth.status, 'pending');

    // 2. Admin 1 tries to approve their own request -> MUST BE REJECTED!
    await assert.rejects(async () => {
      await CryptoShreddingService.approveAndExecuteDestruction(auth.id, admin1Id, 'Self approval');
    }, DualAuthorizationRequiredError);

    // 3. Admin 2 approves -> SUCCEEDS!
    const result = await CryptoShreddingService.approveAndExecuteDestruction(
      auth.id,
      admin2Id,
      'Dual authorization approved by CISO'
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.shredResult.key_status, 'destroyed');
  });

  it('4. ensures data in historical backups is permanently illegible after crypto-shredding', async () => {
    // Attempting to decrypt data created before the shredding must fail permanently with KeyShreddedError
    await assert.rejects(async () => {
      await CryptoShreddingService.decryptData(testOrgId, 'some-ciphertext-from-backup');
    }, KeyShreddedError);
  });

  it('5. validates Governance REST API endpoints for legal holds and dual-authorization', async () => {
    // 1. Impose legal hold via API
    const holdRes = await request(app).post('/api/nuke/legal-hold').set('Authorization', `Bearer ${admin1Token}`).send({
      organization_id: testOrg2Id,
      reason: 'DOJ Subpoena preservation'
    });

    assert.strictEqual(holdRes.status, 201);
    const holdId = holdRes.body.hold.id;

    // 2. List legal holds
    const listRes = await request(app).get('/api/nuke/legal-hold').set('Authorization', `Bearer ${admin1Token}`);

    assert.strictEqual(listRes.status, 200);
    assert.ok(listRes.body.legal_holds.some((h) => h.id === holdId && h.active));

    // 3. Request destruction via API while under hold -> 403 Forbidden
    const blockedReq = await request(app)
      .post('/api/nuke/dual-auth/request')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        target_type: 'organization',
        target_id: testOrg2Id
      });

    assert.strictEqual(blockedReq.status, 403);
    assert.strictEqual(blockedReq.body.code, 'LEGAL_HOLD_ACTIVE');

    // 4. Release legal hold
    const releaseRes = await request(app)
      .delete(`/api/nuke/legal-hold/${holdId}`)
      .set('Authorization', `Bearer ${admin1Token}`);

    assert.strictEqual(releaseRes.status, 200);
    assert.strictEqual(releaseRes.body.success, true);

    // 5. Request destruction after release -> 201 Created
    const reqRes = await request(app)
      .post('/api/nuke/dual-auth/request')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        target_type: 'organization',
        target_id: testOrg2Id,
        comment: 'End of contract decommission'
      });

    assert.strictEqual(reqRes.status, 201);
    const authId = reqRes.body.authorization.id;

    // 6. Admin 1 self-approval attempt via API -> 403 Forbidden
    const selfApproveRes = await request(app)
      .post(`/api/nuke/dual-auth/approve/${authId}`)
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ comment: 'Self approving' });

    assert.strictEqual(selfApproveRes.status, 403);
    assert.strictEqual(selfApproveRes.body.code, 'DUAL_AUTHORIZATION_REQUIRED');

    // 7. Admin 2 approval via API -> 200 OK
    const secondApproveRes = await request(app)
      .post(`/api/nuke/dual-auth/approve/${authId}`)
      .set('Authorization', `Bearer ${admin2Token}`)
      .send({ comment: 'Second admin verified and approved' });

    assert.strictEqual(secondApproveRes.status, 200);
    assert.strictEqual(secondApproveRes.body.success, true);
  });
});
