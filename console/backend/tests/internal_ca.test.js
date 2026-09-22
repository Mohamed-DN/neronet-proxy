const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { setupTestDatabase } = require('./helpers/db');

/**
 * WP-304: Internal CA — TLS Certificate Provisioning & Fingerprint Pinning
 *
 * Test Scenarios:
 *  1. provisionRootCA() generates and stores a root CA.
 *  2. provisionRootCA() is idempotent — calling twice returns the same fingerprint.
 *  3. getCACertPem() returns valid PEM.
 *  4. getCAFingerprint() returns a 64-char lowercase hex string.
 *  5. pinCAFingerprintToNode() pins the fingerprint to a node.
 *  6. verifyNodePin() returns true for a correctly pinned node.
 *  7. verifyNodePin() returns false after fingerprint mismatch (fail-closed TLS pinning).
 *  8. verifyNodePin() auto-pins nodes with no prior pin (TOFU migration path).
 *  9. issueNodeCertificate() issues valid leaf cert verified by CA public key.
 * 10. revokeNodeCertificate() updates revocation status and reason.
 */

describe('WP-304: Internal CA provisioning and node fingerprint pinning', () => {
  let dbHelper;
  let pool;
  let InternalCAService;
  let testNodeId;

  before(async () => {
    dbHelper = await setupTestDatabase();
    pool = dbHelper.pool;

    InternalCAService = require('../services/InternalCAService');

    // Create a dummy node to pin against
    testNodeId = 'node-ca-test-001';
    await pool.query(
      `
      INSERT INTO nodes (id, user_id, name, public_key, overlay_ipv4, overlay_ipv6, role)
      VALUES ($1, (SELECT id FROM users LIMIT 1), 'CA Test Node', 'deadbeef' || repeat('0', 56), '100.64.200.1', 'fd7a:115c:a1e0::c8:1', 'CLIENT_ORIGIN')
      ON CONFLICT (id) DO NOTHING
    `,
      [testNodeId]
    );
  });

  after(async () => {
    if (dbHelper) await dbHelper.cleanup();
  });

  it('provisionRootCA() generates and persists the CA certificate', async () => {
    const ca = await InternalCAService.provisionRootCA({
      commonName: 'NeroNet Test CA',
      organization: 'NeroNet Test'
    });

    assert.ok(ca, 'CA must be returned');
    assert.ok(ca.fingerprint_sha256, 'CA must have a fingerprint');
    assert.strictEqual(ca.fingerprint_sha256.length, 64, 'SHA-256 fingerprint must be 64 hex chars');
    assert.ok(ca.cert_pem, 'CA must expose cert PEM');

    const x509 = new crypto.X509Certificate(ca.cert_pem);
    assert.strictEqual(x509.ca, true, 'Certificate must have BasicConstraints CA:TRUE');
  });

  it('provisionRootCA() is idempotent — second call returns same fingerprint', async () => {
    const ca1 = await InternalCAService.getRootCA();
    const ca2 = await InternalCAService.provisionRootCA();

    assert.strictEqual(ca1.fingerprint_sha256, ca2.fingerprint_sha256, 'Fingerprint must be stable across calls');
  });

  it('getCACertPem() returns a PEM-encoded certificate', async () => {
    const pem = await InternalCAService.getCACertPem();
    assert.ok(pem.startsWith('-----BEGIN CERTIFICATE-----'), 'Must return valid PEM certificate');
  });

  it('getCAFingerprint() returns a 64-char hex string', async () => {
    const fp = await InternalCAService.getCAFingerprint();
    assert.match(fp, /^[0-9a-f]{64}$/, 'Fingerprint must be lowercase hex SHA-256');
  });

  it('pinCAFingerprintToNode() stores the CA fingerprint on the node record', async () => {
    const fp = await InternalCAService.pinCAFingerprintToNode(testNodeId);
    const row = (await pool.query('SELECT pinned_ca_fingerprint FROM nodes WHERE id = $1', [testNodeId])).rows[0];
    assert.strictEqual(row.pinned_ca_fingerprint, fp, 'Pinned fingerprint must match the CA fingerprint');
  });

  it('verifyNodePin() returns true when fingerprint matches', async () => {
    const ok = await InternalCAService.verifyNodePin(testNodeId);
    assert.strictEqual(ok, true, 'verifyNodePin must return true for a correctly pinned node');
  });

  it('verifyNodePin() returns false when the stored pin does not match current CA fingerprint (fail-closed)', async () => {
    // Simulate a CA rotation / spoofed CA by writing a wrong fingerprint to the node
    const fakeFingerprint = '0'.repeat(64);
    await pool.query('UPDATE nodes SET pinned_ca_fingerprint = $1 WHERE id = $2', [fakeFingerprint, testNodeId]);

    const ok = await InternalCAService.verifyNodePin(testNodeId);
    assert.strictEqual(ok, false, 'verifyNodePin must return false when fingerprint is mismatched');

    // Restore correct pin
    await InternalCAService.pinCAFingerprintToNode(testNodeId);
  });

  it('verifyNodePin() auto-pins nodes with no prior pin (TOFU migration path)', async () => {
    await pool.query('UPDATE nodes SET pinned_ca_fingerprint = NULL WHERE id = $1', [testNodeId]);

    const ok = await InternalCAService.verifyNodePin(testNodeId);
    assert.strictEqual(ok, true, 'First verification of unpinned node must auto-pin and return true');

    const row = (await pool.query('SELECT pinned_ca_fingerprint FROM nodes WHERE id = $1', [testNodeId])).rows[0];
    const currentFp = await InternalCAService.getCAFingerprint();
    assert.strictEqual(row.pinned_ca_fingerprint, currentFp, 'Auto-pinned fingerprint must match current CA');
  });

  it('issueNodeCertificate() issues valid leaf cert verified by CA public key', async () => {
    const leaf = await InternalCAService.issueNodeCertificate(testNodeId, {
      commonName: 'leaf-node-001',
      validityDays: 30
    });

    assert.ok(leaf.cert_pem, 'Leaf cert must have PEM');
    assert.ok(leaf.fingerprint_sha256, 'Leaf cert must have fingerprint');
    assert.strictEqual(leaf.fingerprint_sha256.length, 64);

    const leafX509 = new crypto.X509Certificate(leaf.cert_pem);
    assert.strictEqual(leafX509.ca, false, 'Leaf cert must have BasicConstraints CA:FALSE');

    const caPem = await InternalCAService.getCACertPem();
    const caPub = crypto.createPublicKey(caPem);
    assert.strictEqual(leafX509.verify(caPub), true, 'Leaf certificate signature must verify against CA public key');
  });

  it('revokeNodeCertificate() marks certificate as revoked', async () => {
    const leaf = await InternalCAService.issueNodeCertificate(testNodeId, { commonName: 'leaf-revocable' });
    const revoked = await InternalCAService.revokeNodeCertificate(leaf.id, 'compromised_node_key');

    assert.strictEqual(revoked.revoked, true);
    assert.strictEqual(revoked.revoke_reason, 'compromised_node_key');
    assert.ok(revoked.revoked_at);
  });
});
