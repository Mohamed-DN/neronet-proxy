const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { createApp, initDatabase } = require('../server');
const { getDatabase, closeDatabase } = require('../db/index');
const { initTopologyWebSocket, closeTopologyWebSocket } = require('../ws/topologyServer');
const { closeValkey } = require('../db/valkey');
const RiskEngine = require('../services/RiskEngine');
const PolicyEngine = require('../services/PolicyEngine');
const PeeringEngine = require('../services/PeeringEngine');
const WebRtcSignalingEngine = require('../services/WebRtcSignalingEngine');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_m2.db');

describe('Milestone 2: Advanced Engines & Policy Integration Suite', () => {
  let app;
  let server;
  let adminToken;
  let tenantAToken;
  let tenantBToken;
  let testNodeId;

  before(async () => {
    process.env.SOVEREIGN_DB_PATH = TEST_DB_PATH;
    if (fs.existsSync(TEST_DB_PATH)) {
      try {
        fs.unlinkSync(TEST_DB_PATH);
      } catch (e) {}
    }

    await initDatabase();
    app = createApp();

    server = http.createServer(app);
    initTopologyWebSocket(server);

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });

    // 1. Admin login
    const adminRes = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin_password' });
    assert.strictEqual(adminRes.status, 200);
    adminToken = adminRes.body.token;

    // 2. Register Tenant A
    const userARes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'tenant_alpha_m2', password: 'Password123!', tier: 'managed_cloud' });
    assert.strictEqual(userARes.status, 201);
    tenantAToken = userARes.body.token;

    // 3. Register Tenant B
    const userBRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'tenant_beta_m2', password: 'Password123!', tier: 'hybrid_byos' });
    assert.strictEqual(userBRes.status, 201);
    tenantBToken = userBRes.body.token;

    // 4. Create a test node for Tenant A
    const nodeRes = await request(app).post('/api/nodes').set('Authorization', `Bearer ${tenantAToken}`).send({
      name: 'M2-Test-Node',
      role: 'CLIENT_ORIGIN',
      country_code: 'US'
    });
    assert.strictEqual(nodeRes.status, 201);
    testNodeId = nodeRes.body.node.id;
  });

  after(async () => {
    closeTopologyWebSocket();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase();
    closeValkey();
    if (fs.existsSync(TEST_DB_PATH)) {
      try {
        fs.unlinkSync(TEST_DB_PATH);
      } catch (e) {}
    }
  });

  // ===========================================================================
  // 1. Behavioral Risk Score & Impossible Travel Engine
  // ===========================================================================
  describe('1. Behavioral Risk Score & Impossible Travel Engine', () => {
    it('should compute exact Haversine distance and velocity between coordinates', () => {
      // Washington DC (38.8951, -77.0364) to London (51.5074, -0.1278) ~ 5900 km
      const distance = RiskEngine.calculateDistanceKm(38.8951, -77.0364, 51.5074, -0.1278);
      assert.ok(distance > 5800 && distance < 6100, `Expected ~5900km, got ${distance}`);

      // Velocity in 1 hour (3600s) = ~5900 km/h
      const velocity = RiskEngine.calculateVelocityKmh(38.8951, -77.0364, 51.5074, -0.1278, 3600);
      assert.ok(velocity > 5800 && velocity < 6100, `Expected ~5900km/h, got ${velocity}`);

      // Zero or negative time delta handled safely
      const zeroVel = RiskEngine.calculateVelocityKmh(38.8951, -77.0364, 51.5074, -0.1278, 0);
      assert.strictEqual(zeroVel, 0.0);
    });

    it('should reject telemetry with missing coordinates or out-of-bounds coordinates (400)', async () => {
      // Missing lat/lon
      const res1 = await request(app)
        .post('/api/risk/telemetry')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ node_id: testNodeId });
      assert.strictEqual(res1.status, 400);

      // Lat out of bounds (> 90)
      const res2 = await request(app)
        .post('/api/risk/telemetry')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ node_id: testNodeId, latitude: 120.0, longitude: 0.0 });
      assert.strictEqual(res2.status, 400);

      // Non-existent node (404)
      const res3 = await request(app)
        .post('/api/risk/telemetry')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ node_id: 'non-existent-node-999', latitude: 38.0, longitude: -77.0 });
      assert.strictEqual(res3.status, 404);
    });

    it('should ingest normal baseline telemetry with green low risk score (<40)', async () => {
      const now = Date.now() / 1000;
      const res = await request(app).post('/api/risk/telemetry').set('Authorization', `Bearer ${tenantAToken}`).send({
        node_id: testNodeId,
        latitude: 38.8951,
        longitude: -77.0364,
        rtt_ms: 15.0,
        jitter_ms: 1.0,
        timestamp_epoch: now
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.node_id, testNodeId);
      assert.strictEqual(res.body.impossible_travel_detected, false);
      assert.ok(res.body.risk_score < 40);
      assert.strictEqual(res.body.color, 'green');
    });

    it('should detect impossible travel (>1000km/h) and increment risk score by 50', async () => {
      // 10 minutes later, heartbeat from London (velocity > 35,000 km/h)
      const t1 = Date.now() / 1000 + 600;
      const res = await request(app).post('/api/risk/telemetry').set('Authorization', `Bearer ${tenantAToken}`).send({
        node_id: testNodeId,
        latitude: 51.5074,
        longitude: -0.1278,
        rtt_ms: 25.0,
        timestamp_epoch: t1
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.impossible_travel_detected, true);
      assert.ok(res.body.velocity_kmh > 1000.0);
      assert.ok(res.body.risk_score >= 50);
    });

    it('should auto-quarantine node when risk_score exceeds 75 and reassign overlay IP to 100.64.250.0/24', async () => {
      // Send anomaly with severe RTT and high velocity triggering > 75 risk
      const t2 = Date.now() / 1000 + 610;
      const res = await request(app)
        .post(`/api/nodes/${testNodeId}/telemetry`)
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({
          latitude: -33.8688, // Sydney
          longitude: 151.2093,
          rtt_ms: 450.0, // +25 RTT anomaly
          jitter_ms: 35.0, // +15 Jitter anomaly
          timestamp_epoch: t2
        });

      assert.strictEqual(res.status, 200);
      assert.ok(res.body.risk_score > 75);
      assert.strictEqual(res.body.is_quarantined, true);
      assert.strictEqual(res.body.color, 'red');
      assert.ok(res.body.overlay_ipv4.startsWith('100.64.250.'));

      // Verify node status in GET /api/nodes/:id
      const nodeCheck = await request(app)
        .get(`/api/nodes/${testNodeId}`)
        .set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(nodeCheck.status, 200);
      assert.strictEqual(nodeCheck.body.node.is_quarantined, true);
      assert.strictEqual(nodeCheck.body.node.status, 'quarantined');
      assert.ok(nodeCheck.body.node.overlay_ipv4.startsWith('100.64.250.'));
    });

    it('should retrieve list of all risk scores and dashboard summary', async () => {
      const scoresRes = await request(app).get('/api/risk/scores').set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(scoresRes.status, 200);
      assert.ok(Array.isArray(scoresRes.body.risk_scores));
      assert.ok(scoresRes.body.risk_scores.length >= 1);

      const dashRes = await request(app).get('/api/risk/dashboard').set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(dashRes.status, 200);
      assert.ok(dashRes.body.total_nodes >= 1);
      assert.ok(dashRes.body.quarantined_nodes >= 1);
      assert.ok(typeof dashRes.body.average_risk_score === 'number');
    });

    it('should retrieve risk details for a specific node via GET /api/nodes/:id/risk', async () => {
      const nodeRiskRes = await request(app)
        .get(`/api/nodes/${testNodeId}/risk`)
        .set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(nodeRiskRes.status, 200);
      assert.strictEqual(nodeRiskRes.body.node_id, testNodeId);
      assert.ok(typeof nodeRiskRes.body.risk_score === 'number');
      assert.ok(typeof nodeRiskRes.body.is_quarantined === 'boolean');
      assert.ok(['green', 'yellow', 'red'].includes(nodeRiskRes.body.color));
    });

    it('should accurately compute distance between antipodal coordinates and polar extremes', () => {
      // Equator antipodes (0, 0) to (0, 180) -> half circumference ~ 20015 km
      const antipodalDist = RiskEngine.calculateDistanceKm(0, 0, 0, 180);
      assert.ok(antipodalDist > 19900 && antipodalDist < 20100, `Expected ~20015km, got ${antipodalDist}`);

      // North Pole (90, 0) to South Pole (-90, 0) -> ~ 20015 km
      const poleDist = RiskEngine.calculateDistanceKm(90, 0, -90, 0);
      assert.ok(poleDist > 19900 && poleDist < 20100, `Expected ~20015km, got ${poleDist}`);

      // Same point distance is 0
      const sameDist = RiskEngine.calculateDistanceKm(45.0, -75.0, 45.0, -75.0);
      assert.strictEqual(Math.round(sameDist), 0);
    });

    it('should remediate/attest risk score back to 0 and lift quarantine', async () => {
      // Non-owner tenant cannot attest another tenant's node (403)
      const forbiddenRes = await request(app)
        .post(`/api/risk/attest/${testNodeId}`)
        .set('Authorization', `Bearer ${tenantBToken}`);
      assert.strictEqual(forbiddenRes.status, 403);

      // Node owner attests
      const attestRes = await request(app)
        .post(`/api/risk/attest/${testNodeId}`)
        .set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(attestRes.status, 200);
      assert.strictEqual(attestRes.body.success, true);
      assert.strictEqual(attestRes.body.risk_score, 0);
      assert.strictEqual(attestRes.body.status, 'active');

      // Verify node state
      const nodeCheck = await request(app)
        .get(`/api/nodes/${testNodeId}`)
        .set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(nodeCheck.status, 200);
      assert.strictEqual(nodeCheck.body.node.is_quarantined, false);
      assert.strictEqual(nodeCheck.body.node.risk_score, 0);
      assert.strictEqual(nodeCheck.body.node.status, 'active');
    });
  });

  // ===========================================================================
  // 2. Geo-Fencing Policy Engine
  // ===========================================================================
  describe('2. Geo-Fencing Policy Engine', () => {
    it('should enforce super-admin authorization on policy management', async () => {
      const forbiddenCreate = await request(app)
        .post('/api/geofencing/policies')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ country_code: 'KP', action: 'BLOCK' });
      assert.strictEqual(forbiddenCreate.status, 403);

      const forbiddenDelete = await request(app)
        .delete('/api/geofencing/policies/pol-test')
        .set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(forbiddenDelete.status, 403);
    });

    it('should validate ISO 2-letter country code and valid policy action', async () => {
      // Bad country code
      const badCountry = await request(app)
        .post('/api/geofencing/policies')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ country_code: 'USA_INVALID', action: 'BLOCK' });
      assert.strictEqual(badCountry.status, 400);

      // Bad action
      const badAction = await request(app)
        .post('/api/geofencing/policies')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ country_code: 'KP', action: 'DESTROY_TRAFFIC' });
      assert.strictEqual(badAction.status, 400);
    });

    it('should create, list, and evaluate ALLOW, BLOCK, and QUARANTINE country rules', async () => {
      // 1. Create BLOCK rule for KP
      const kpRes = await request(app)
        .post('/api/geofencing/policies')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          country_code: 'KP',
          country_name: 'North Korea',
          action: 'BLOCK',
          description: 'Strict embargo block'
        });
      assert.strictEqual(kpRes.status, 201);
      assert.strictEqual(kpRes.body.policy.country_code, 'KP');
      assert.strictEqual(kpRes.body.policy.action, 'BLOCK');
      const kpPolicyId = kpRes.body.policy.id;

      // 2. Create QUARANTINE rule for SY
      const syRes = await request(app)
        .post('/api/geofencing/policies')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          country_code: 'SY',
          country_name: 'Syria',
          action: 'QUARANTINE',
          description: 'Quarantine high risk routing'
        });
      assert.strictEqual(syRes.status, 201);

      // 3. List policies
      const listRes = await request(app).get('/api/geofencing/policies').set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(listRes.status, 200);
      assert.ok(listRes.body.policies.some((p) => p.country_code === 'KP'));
      assert.ok(listRes.body.policies.some((p) => p.country_code === 'SY'));

      // 4. Evaluate BLOCK rule
      const evalBlocked = await request(app)
        .post('/api/geofencing/evaluate')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ country_code: 'KP' });
      assert.strictEqual(evalBlocked.status, 200);
      assert.strictEqual(evalBlocked.body.action, 'BLOCK');
      assert.strictEqual(evalBlocked.body.allowed, false);

      // 5. Evaluate QUARANTINE rule
      const evalQuar = await request(app)
        .post('/api/geofencing/evaluate')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ country_code: 'SY' });
      assert.strictEqual(evalQuar.status, 200);
      assert.strictEqual(evalQuar.body.action, 'QUARANTINE');
      assert.strictEqual(evalQuar.body.allowed, false);

      // 6. Update existing policy (SY from QUARANTINE to ALLOW)
      const updateRes = await request(app)
        .post('/api/geofencing/policies')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ country_code: 'SY', country_name: 'Syria Updated', action: 'ALLOW', description: 'Updated to allow' });
      assert.strictEqual(updateRes.status, 201);
      assert.strictEqual(updateRes.body.policy.action, 'ALLOW');

      // 7. Delete rule
      const delRes = await request(app)
        .delete(`/api/geofencing/policies/${kpPolicyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(delRes.status, 200);
      assert.strictEqual(delRes.body.success, true);

      // 8. Delete non-existent policy returns 404
      const delNotFound = await request(app)
        .delete('/api/geofencing/policies/pol-nonexistent-999')
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(delNotFound.status, 404);
    });

    it('should default-allow censorship-heavy jurisdictions (RU, EG, CN, IN) and unconfigured countries', async () => {
      const censorshipCountries = ['RU', 'EG', 'CN', 'IN'];
      for (const cc of censorshipCountries) {
        const evalRes = await request(app)
          .post('/api/geofencing/evaluate')
          .set('Authorization', `Bearer ${tenantAToken}`)
          .send({ country_code: cc });
        assert.strictEqual(evalRes.status, 200);
        assert.strictEqual(evalRes.body.action, 'ALLOW');
        assert.strictEqual(evalRes.body.allowed, true);
        assert.strictEqual(evalRes.body.is_censorship_bypass, true);
      }

      // Unconfigured non-censorship country (e.g. JP, DE) also default ALLOW
      const unconfRes = await request(app)
        .post('/api/geofencing/evaluate')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ country_code: 'JP' });
      assert.strictEqual(unconfRes.status, 200);
      assert.strictEqual(unconfRes.body.action, 'ALLOW');
      assert.strictEqual(unconfRes.body.allowed, true);
      assert.strictEqual(unconfRes.body.is_default, true);
    });
  });

  // ===========================================================================
  // 3. Cross-Mesh Peering API
  // ===========================================================================
  describe('3. Cross-Mesh Peering API', () => {
    let createdPeeringId;
    let validPeeringToken;

    it('should enforce super-admin authorization on peering endpoints', async () => {
      const forbiddenReq = await request(app)
        .post('/api/peering/request')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ initiator_endpoint: 'https://external.mesh.com' });
      assert.strictEqual(forbiddenReq.status, 403);

      const forbiddenAccept = await request(app)
        .post('/api/peering/accept')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ peering_token: {} });
      assert.strictEqual(forbiddenAccept.status, 403);
    });

    it('should validate CIDR formatting in shared subnets (400)', async () => {
      const badSubnetRes = await request(app)
        .post('/api/peering/request')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          initiator_endpoint: 'https://external.mesh.com',
          shared_subnets: ['invalid_cidr_format_100.64.0.0']
        });
      assert.strictEqual(badSubnetRes.status, 400);
    });

    it('should generate Ed25519 signed peering token with scope definition', async () => {
      const reqRes = await request(app)
        .post('/api/peering/request')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          initiator_endpoint: 'https://remote-partner.darknero.com:8443',
          scope_mode: 'SPECIFIC_SUBNETS',
          shared_subnets: ['100.64.10.0/24', '100.64.20.0/24'],
          expires_at: new Date(Date.now() + 30 * 86400000).toISOString()
        });

      assert.strictEqual(reqRes.status, 201);
      const agr = reqRes.body.peering_agreement;
      assert.ok(agr.peering_id);
      assert.ok(agr.signature);
      assert.ok(agr.initiator_public_key);
      assert.strictEqual(agr.scope_mode, 'SPECIFIC_SUBNETS');
      assert.strictEqual(agr.shared_subnets.length, 2);

      createdPeeringId = agr.peering_id;
      validPeeringToken = agr;
    });

    // These cases used to pass the literal strings 'INVALID_SIGNATURE' and 'EXPIRED',
    // and the implementation checked for exactly those literals. The tests were
    // written to the implementation and the implementation to the tests, so a token
    // carrying any other non-empty string federated a hostile network -- verified
    // against the running system before this was fixed. Forgeries here are now real
    // forgeries.
    it('rejects a token whose signature does not verify', async () => {
      const forged = await request(app)
        .post('/api/peering/accept')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          peering_token: { ...validPeeringToken, signature: Buffer.from('not a signature').toString('base64') },
          expected_fingerprint: PeeringEngine.publicKeyFingerprint(validPeeringToken.initiator_public_key)
        });

      assert.strictEqual(forged.status, 400);
      assert.match(forged.body.error, /signature/i);
    });

    it('rejects a token whose payload was altered after signing', async () => {
      // The signature stays valid for the original payload; widening the shared
      // subnets must invalidate it, or the signature protects nothing that matters.
      const tampered = await request(app)
        .post('/api/peering/accept')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          peering_token: { ...validPeeringToken, shared_subnets: ['0.0.0.0/0'] },
          expected_fingerprint: PeeringEngine.publicKeyFingerprint(validPeeringToken.initiator_public_key)
        });

      assert.strictEqual(tampered.status, 400);
    });

    it('rejects a token signed by a different key than it claims', async () => {
      const attacker = crypto.generateKeyPairSync('ed25519');
      const attackerPublic = attacker.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

      const payload = {
        version: '1.0',
        peering_id: 'attacker-001',
        initiator_endpoint: 'https://hostile.example',
        initiator_public_key: validPeeringToken.initiator_public_key, // claims to be us
        scope_mode: 'ALL',
        shared_device_ids: [],
        shared_subnets: ['0.0.0.0/0'],
        expires_at: new Date(Date.now() + 86400000).toISOString()
      };
      const signature = crypto
        .sign(null, Buffer.from(JSON.stringify(payload, Object.keys(payload).sort())), attacker.privateKey)
        .toString('base64');

      const res = await request(app)
        .post('/api/peering/accept')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          peering_token: { ...payload, signature },
          expected_fingerprint: PeeringEngine.publicKeyFingerprint(attackerPublic)
        });

      assert.strictEqual(res.status, 400);
    });

    it('rejects an expired token', async () => {
      const expired = await request(app)
        .post('/api/peering/accept')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          peering_token: { ...validPeeringToken, expires_at: new Date(Date.now() - 86400000).toISOString() },
          expected_fingerprint: PeeringEngine.publicKeyFingerprint(validPeeringToken.initiator_public_key)
        });

      // Altering expires_at also breaks the signature, which is the point: every
      // field the initiator committed to is covered.
      assert.ok([400, 422].includes(expired.status), `expected rejection, got ${expired.status}`);
    });

    it('refuses to federate until a fingerprint has been confirmed out of band', async () => {
      // A verified signature over a self-supplied key proves only that the sender
      // holds a key they chose. Without an out-of-band check, federation is open to
      // anyone who can reach the endpoint.
      const res = await request(app)
        .post('/api/peering/accept')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ peering_token: validPeeringToken });

      assert.strictEqual(res.status, 428);
      assert.ok(res.body.fingerprint, 'the response must show the fingerprint to confirm');
    });

    it('rejects a mismatched fingerprint', async () => {
      const res = await request(app).post('/api/peering/accept').set('Authorization', `Bearer ${adminToken}`).send({
        peering_token: validPeeringToken,
        expected_fingerprint: 'DEAD-BEEF-DEAD-BEEF-DEAD-BEEF-DEAD-BEEF'
      });

      assert.strictEqual(res.status, 400);
    });

    it('accepts a valid token once its fingerprint is confirmed', async () => {
      const acceptRes = await request(app)
        .post('/api/peering/accept')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          peering_token: validPeeringToken,
          expected_fingerprint: PeeringEngine.publicKeyFingerprint(validPeeringToken.initiator_public_key)
        });

      assert.strictEqual(acceptRes.status, 200, JSON.stringify(acceptRes.body));
      assert.strictEqual(acceptRes.body.success, true);
      assert.strictEqual(acceptRes.body.peering_agreement.status, 'active');

      const nodesRes = await request(app).get('/api/peering/nodes').set('Authorization', `Bearer ${tenantAToken}`);

      assert.strictEqual(nodesRes.status, 200);
      assert.ok(nodesRes.body.peered_nodes.length >= 1);
      assert.strictEqual(nodesRes.body.peered_nodes[0].is_peered, true);
    });

    it('should retrieve peering agreement by ID via /api/peering/:id and /api/peering/agreements/:id', async () => {
      const getRes1 = await request(app)
        .get(`/api/peering/${createdPeeringId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(getRes1.status, 200);
      assert.strictEqual(getRes1.body.peering_agreement.peering_id, createdPeeringId);

      const getRes2 = await request(app)
        .get(`/api/peering/agreements/${createdPeeringId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(getRes2.status, 200);
      assert.strictEqual(getRes2.body.peering_agreement.peering_id, createdPeeringId);

      // Non-existent agreement returns 404
      const notFoundRes = await request(app)
        .get('/api/peering/agreements/peer-nonexistent-999')
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(notFoundRes.status, 404);
    });

    it('should support ALL and SPECIFIC_DEVICES scope modes and validate subnets properly', async () => {
      // 1. ALL scope mode
      const allScopeRes = await request(app)
        .post('/api/peering/request')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          initiator_endpoint: 'https://peer-all.darknero.com:8443',
          scope_mode: 'ALL'
        });
      assert.strictEqual(allScopeRes.status, 201);
      assert.strictEqual(allScopeRes.body.peering_agreement.scope_mode, 'ALL');

      // 2. SPECIFIC_DEVICES scope mode
      const devScopeRes = await request(app)
        .post('/api/peering/request')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          initiator_endpoint: 'https://peer-dev.darknero.com:8443',
          scope_mode: 'SPECIFIC_DEVICES',
          shared_device_ids: ['svrn-node-dev1', 'svrn-node-dev2']
        });
      assert.strictEqual(devScopeRes.status, 201);
      assert.strictEqual(devScopeRes.body.peering_agreement.scope_mode, 'SPECIFIC_DEVICES');
      assert.strictEqual(devScopeRes.body.peering_agreement.shared_device_ids.length, 2);

      // 3. Bad CIDRs (out-of-range octet > 255, mask > 32, negative mask)
      const badOctet = await request(app)
        .post('/api/peering/request')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ initiator_endpoint: 'https://bad.mesh.com', shared_subnets: ['300.64.0.0/16'] });
      assert.strictEqual(badOctet.status, 400);

      const badMask = await request(app)
        .post('/api/peering/request')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ initiator_endpoint: 'https://bad.mesh.com', shared_subnets: ['100.64.0.0/35'] });
      assert.strictEqual(badMask.status, 400);
    });

    it('should list all peering agreements and revoke agreement by ID', async () => {
      const listRes = await request(app).get('/api/peering/agreements').set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(listRes.status, 200);
      assert.ok(listRes.body.peering_agreements.some((a) => a.peering_id === createdPeeringId));

      const revokeRes = await request(app)
        .delete(`/api/peering/agreements/${createdPeeringId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(revokeRes.status, 200);
      assert.strictEqual(revokeRes.body.success, true);

      // Revoking non-existent agreement returns 404
      const notFoundRes = await request(app)
        .delete('/api/peering/agreements/peer-nonexistent-999')
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(notFoundRes.status, 404);
    });
  });

  // ===========================================================================
  // 4. Sovereign Cloud PC (WebRTC Native / Selkies-GStreamer)
  // ===========================================================================
  describe('4. Sovereign Cloud PC (WebRTC Native / Selkies-GStreamer)', () => {
    let createdCpcId;
    let customDomainName;
    let registeredOtpSecret;

    // Cloud PC is frozen behind a flag and answers 404 without it. These tests
    // cover the feature as it behaves when an operator switches it on; the off
    // state is covered in feature_flags.test.js.
    let previousFlag;
    before(() => {
      previousFlag = process.env.SOVEREIGN_FEATURE_CLOUD_PC;
      process.env.SOVEREIGN_FEATURE_CLOUD_PC = 'true';
    });
    after(() => {
      if (previousFlag === undefined) delete process.env.SOVEREIGN_FEATURE_CLOUD_PC;
      else process.env.SOVEREIGN_FEATURE_CLOUD_PC = previousFlag;
    });

    it('should reject Cloud PC provisioning with missing required fields (400)', async () => {
      const badReq = await request(app)
        .post('/api/cloud-pc')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ name: 'OnlyNameProvided' });
      assert.strictEqual(badReq.status, 400);
    });

    it('should provision a new Cloud PC instance linked to a device', async () => {
      const provRes = await request(app)
        .post('/api/cloud-pc')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({
          name: 'Alpha Developer Workstation',
          device_id: testNodeId,
          specs: { vcpus: 8, ram_gb: 32, gpu: 'NVIDIA RTX A6000' },
          custom_domain: 'desktop.alpha.internal'
        });

      assert.strictEqual(provRes.status, 201);
      assert.ok(provRes.body.cloud_pc.id);
      assert.strictEqual(provRes.body.cloud_pc.name, 'Alpha Developer Workstation');
      assert.strictEqual(provRes.body.cloud_pc.specs.vcpus, 8);
      createdCpcId = provRes.body.cloud_pc.id;
    });

    it('should generate WebRTC projection tokens, session IDs, and ICE credentials', async () => {
      // 1. Tenant A projects their own instance
      const projRes = await request(app)
        .post(`/api/cloud-pc/${createdCpcId}/project`)
        .set('Authorization', `Bearer ${tenantAToken}`);

      assert.strictEqual(projRes.status, 200);
      assert.ok(projRes.body.session_id.startsWith('webrtc_sess_'));
      assert.ok(projRes.body.stream_token.startsWith('stok_'));
      assert.ok(projRes.body.signaling_url.includes('selkies'));
      assert.ok(Array.isArray(projRes.body.ice_servers));
      assert.ok(projRes.body.ice_servers.some((s) => s.urls.includes('stun:')));
      assert.ok(projRes.body.ice_servers.some((s) => s.urls.includes('turn:')));

      // 2. Cross-tenant access is forbidden (403)
      const hijackRes = await request(app)
        .post(`/api/cloud-pc/${createdCpcId}/project`)
        .set('Authorization', `Bearer ${tenantBToken}`);
      assert.strictEqual(hijackRes.status, 403);

      // 3. Non-existent instance (404)
      const notFoundRes = await request(app)
        .post('/api/cloud-pc/cpc-nonexistent-999/project')
        .set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(notFoundRes.status, 404);
    });

    it('should register custom domain with FQDN validation and prevent duplicate registration', async () => {
      customDomainName = `cloud-${crypto.randomBytes(4).toString('hex')}.corp.darknero.com`;

      // Bad FQDN
      const badFqdn = await request(app)
        .post('/api/cloud-pc/custom-domains')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ domain: 'invalidfqdn', cloud_pc_id: createdCpcId });
      assert.strictEqual(badFqdn.status, 400);

      // Valid Registration
      const regRes = await request(app)
        .post('/api/cloud-pc/custom-domains')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ domain: customDomainName, cloud_pc_id: createdCpcId });
      assert.strictEqual(regRes.status, 201);
      assert.strictEqual(regRes.body.custom_domain.domain, customDomainName);

      // The OTP secret is issued per domain and returned once, at registration.
      registeredOtpSecret = regRes.body.custom_domain.otp_secret;
      assert.ok(registeredOtpSecret, 'registration must issue an OTP secret');
      assert.notStrictEqual(registeredOtpSecret, 'OTP123456', 'the shared literal secret is back');
      assert.ok(registeredOtpSecret.length >= 16, 'OTP secret is too short to be meaningful');

      // Duplicate Registration Conflict (409)
      const dupRes = await request(app)
        .post('/api/cloud-pc/custom-domains')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ domain: customDomainName, cloud_pc_id: createdCpcId });
      assert.strictEqual(dupRes.status, 409);
    });

    it('should authenticate via custom domain SSO/OTP gateway before releasing WebRTC stream', async () => {
      // 1. Invalid OTP (401)
      const badOtp = await request(app)
        .post(`/api/cloud-pc/custom-domains/${customDomainName}/auth-gateway`)
        .send({ otp_code: '000000' });
      assert.strictEqual(badOtp.status, 401);

      // 2. Non-existent domain (404)
      const badDomain = await request(app)
        .post('/api/cloud-pc/custom-domains/nonexistent.domain.com/auth-gateway')
        .send({ otp_code: '000000' });
      assert.strictEqual(badDomain.status, 404);

      // 3. The former master OTP must no longer open any gateway. It was accepted
      //    for every domain regardless of the stored secret, which made every custom
      //    domain gateway bypassable by anyone who knew the domain name.
      const backdoor = await request(app)
        .post(`/api/cloud-pc/custom-domains/${customDomainName}/auth-gateway`)
        .send({ otp_code: '123456' });
      assert.strictEqual(backdoor.status, 401, 'the hardcoded master OTP still authenticates');

      // 4. Valid OTP (200), using the secret issued when the domain was registered
      const authRes = await request(app)
        .post(`/api/cloud-pc/custom-domains/${customDomainName}/auth-gateway`)
        .send({ otp_code: registeredOtpSecret });
      assert.strictEqual(authRes.status, 200);
      assert.strictEqual(authRes.body.authenticated, true);
      assert.ok(authRes.body.stream_token.startsWith('stream_auth_'));
      assert.strictEqual(authRes.body.cloud_pc_id, createdCpcId);
    });

    it('should list Cloud PC instances and custom domains with tenant isolation', async () => {
      // 1. List Cloud PC instances
      const listCpcRes = await request(app).get('/api/cloud-pc').set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(listCpcRes.status, 200);
      assert.ok(Array.isArray(listCpcRes.body.cloud_pcs));
      assert.ok(listCpcRes.body.cloud_pcs.some((c) => c.id === createdCpcId));

      // 2. List Custom Domains
      const listDomRes = await request(app)
        .get('/api/cloud-pc/custom-domains')
        .set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(listDomRes.status, 200);
      assert.ok(Array.isArray(listDomRes.body.custom_domains));
      assert.ok(listDomRes.body.custom_domains.some((d) => d.domain_name === customDomainName));
    });

    it('should teardown WebRTC session on demand and handle non-existent teardown', async () => {
      const tearRes = await request(app)
        .post(`/api/cloud-pc/${createdCpcId}/teardown`)
        .set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(tearRes.status, 200);
      assert.strictEqual(tearRes.body.success, true);

      // Non-existent teardown (404)
      const notFoundTear = await request(app)
        .post('/api/cloud-pc/cpc-nonexistent-999/teardown')
        .set('Authorization', `Bearer ${tenantAToken}`);
      assert.strictEqual(notFoundTear.status, 404);
    });
  });
});
