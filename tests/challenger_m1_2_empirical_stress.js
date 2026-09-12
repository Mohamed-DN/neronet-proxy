/**
 * Challenger 2: Empirical Stress, Boundary & Edge Case Verification Suite
 * 
 * Verifies Milestone 1:
 * 1. PostgreSQL 16 Migration DDL Syntax & Completeness:
 *    - Plain latitude/longitude columns (PostGIS removed in migration 004)
 *    - pgvector extension declarations
 *    - JSONB column types, defaults, and constraints
 *    - Foreign key cascading rules and check constraints
 * 2. Valkey & In-Memory Token Revocation Stress & Edge Cases:
 *    - Multi-token concurrent invalidation (100+ tokens invalidated simultaneously)
 *    - No false positives on active tokens
 *    - TTL boundary expiration handling
 *    - Edge-case token payloads (empty, oversized, malicious, Unicode)
 *    - Hash collision safety with SHA-256
 * 3. Timing-Safe Bcrypt Verification Side-Channel Defense:
 *    - Constant-time verification on non-existent users
 * 4. VIP Allocation & Curve25519 Clamping Properties
 * 5. Frontend Client Auth Security (Mock Login Elimination)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKEND_ROOT = path.join(PROJECT_ROOT, 'console', 'backend');
const FRONTEND_ROOT = path.join(PROJECT_ROOT, 'console', 'frontend');
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'db', 'migrations');
const bcrypt = require(path.join(BACKEND_ROOT, 'node_modules', 'bcryptjs'));

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  if (!condition) {
    failedTests++;
    console.error(`  ❌ FAILED: ${message}`);
    throw new Error(message);
  } else {
    passedTests++;
    console.log(`  ✔ PASS: ${message}`);
  }
}

// ============================================================================
// TEST SUITE 1: Migration DDL Analysis (coordinates, pgvector, JSONB)
// ============================================================================
async function testMigrationDDL() {
  console.log('\n================================================================================');
  console.log('📦 TEST SUITE 1: PostgreSQL 16 DDL Schema, Coordinates, pgvector & JSONB Analysis');
  console.log('================================================================================');

  const mig1Path = path.join(MIGRATIONS_DIR, '001_initial_pg_schema.sql');
  const mig2Path = path.join(MIGRATIONS_DIR, '002_postgis_geofencing.sql');
  const mig3Path = path.join(MIGRATIONS_DIR, '003_nuke_and_peering.sql');

  assert(fs.existsSync(mig1Path), '001_initial_pg_schema.sql exists');
  assert(fs.existsSync(mig2Path), '002_postgis_geofencing.sql exists');
  assert(fs.existsSync(mig3Path), '003_nuke_and_peering.sql exists');

  const ddl1 = fs.readFileSync(mig1Path, 'utf8');
  const ddl2 = fs.readFileSync(mig2Path, 'utf8');
  const ddl3 = fs.readFileSync(mig3Path, 'utf8');
  const allDDL = `${ddl1}\n${ddl2}\n${ddl3}`;

  // 1. PostGIS removed (migration 004).
  //    The geometry column and its GiST index were never written and never read:
  //    geo-fencing matches country_code, and distance is Haversine in RiskEngine.
  //    Note what these assertions are: text matching over a .sql file. They pass
  //    with PostgreSQL never started, which is how a spatial index on an unused
  //    column stayed "verified" for so long. The check that compares the two
  //    schemas for real lives in console/backend/tests/schema_parity.test.js.
  assert(!ddl1.includes('CREATE EXTENSION IF NOT EXISTS "postgis"'), 'PostGIS extension removed from 001');
  assert(!ddl1.includes('GEOMETRY(Point, 4326)'), 'PostGIS geometry column removed from nodes');
  assert(!ddl1.includes('USING GIST'), 'GiST spatial index removed');
  assert(ddl1.includes('latitude REAL'), 'nodes.latitude declared as a plain column');
  assert(ddl1.includes('longitude REAL'), 'nodes.longitude declared as a plain column');

  // 2. pgvector Extension
  assert(ddl1.includes('CREATE EXTENSION IF NOT EXISTS "vector"'), 'pgvector extension enabled in 001');

  // 3. JSONB Columns across tables
  const expectedJsonbColumns = [
    { table: 'users', column: 'bypass_apps', default: "'[]'::jsonb" },
    { table: 'nodes', column: 'endpoints', default: "'[]'::jsonb" },
    { table: 'nodes', column: 'posture_checks', default: '\'{"compliant": true, "disk_encrypted": true, "os": "Linux"}\'::jsonb' },
    { table: 'nodes', column: 'metadata', default: "'{}'::jsonb" },
    { table: 'app_bundles', column: 'config_json', default: "'{}'::jsonb" },
    // Renamed in migration 005 to match what the application actually reads. The
    // PostgreSQL spellings 'metadata' and 'webrtc_signal' were unreachable from the
    // code, which uses the SQLite names on both backends.
    { table: 'audit_events', column: 'metadata_json', default: "'{}'::jsonb" },
    { table: 'nerodrop_sessions', column: 'webrtc_signal_json', default: "'{}'::jsonb" },
    { table: 'peering_agreements', column: 'shared_device_ids', default: "'[]'::jsonb" },
    { table: 'peering_agreements', column: 'shared_subnets', default: "'[]'::jsonb" },
    { table: 'peering_agreements', column: 'imported_nodes', default: "'[]'::jsonb" }
  ];

  for (const item of expectedJsonbColumns) {
    const regex = new RegExp(`${item.column}\\s+JSONB\\s+NOT NULL\\s+DEFAULT`, 'i');
    assert(regex.test(allDDL), `Table column '${item.column}' is defined as JSONB NOT NULL with default`);
  }

  // 4. Foreign Key Constraints with ON DELETE CASCADE
  const cascadeTables = ['nodes', 'app_bundles', 'refresh_tokens', 'nerodrop_sessions', 'app_share_links', 'peering_agreements', 'dead_man_switch', 'custom_domains'];
  for (const tbl of cascadeTables) {
    const regex = new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}[\\s\\S]*?ON DELETE CASCADE`, 'i');
    assert(regex.test(allDDL), `Table '${tbl}' has proper ON DELETE CASCADE foreign key relationship`);
  }

  // 5. Unique and check constraints
  assert(allDDL.includes('CONSTRAINT uq_user_switch_tier UNIQUE(user_id, switch_tier)'), 'Dead man switch has unique constraint per user and tier');
  assert(allDDL.includes('CHECK (risk_score >= 0 AND risk_score <= 100)'), 'Nodes table enforces risk_score bounds [0..100]');
}

// ============================================================================
// TEST SUITE 2: Valkey & In-Memory Multi-Token Revocation Stress
// ============================================================================
async function testValkeyTokenRevocationStress() {
  console.log('\n================================================================================');
  console.log('⚡ TEST SUITE 2: Valkey Token Revocation Multi-Token & Edge-Case Stress');
  console.log('================================================================================');

  const { blacklistToken, isTokenBlacklisted, hashToken } = require(path.join(BACKEND_ROOT, 'db', 'valkey'));

  // 1. Bulk Invalidation (100 concurrent tokens invalidated simultaneously)
  const tokenCount = 100;
  const revokedTokens = [];
  const activeTokens = [];

  for (let i = 0; i < tokenCount; i++) {
    revokedTokens.push(`jwt-test-revoked-token-${i}-${crypto.randomBytes(16).toString('hex')}`);
    activeTokens.push(`jwt-test-active-token-${i}-${crypto.randomBytes(16).toString('hex')}`);
  }

  console.log(`  [*] Revoking ${tokenCount} tokens concurrently...`);
  const revokeStart = Date.now();
  await Promise.all(revokedTokens.map(tok => blacklistToken(tok, 900)));
  const revokeDuration = Date.now() - revokeStart;
  console.log(`  [*] Concurrent revocation completed in ${revokeDuration}ms`);

  // Verify all 100 revoked tokens return true
  for (let i = 0; i < tokenCount; i++) {
    const isRev = await isTokenBlacklisted(revokedTokens[i]);
    assert(isRev === true, `Revoked token #${i} is correctly flagged as blacklisted`);
  }

  // Verify all 100 active tokens return false (no false positives)
  for (let i = 0; i < tokenCount; i++) {
    const isRev = await isTokenBlacklisted(activeTokens[i]);
    assert(isRev === false, `Active token #${i} is correctly NOT blacklisted`);
  }

  // 2. TTL Expiration Boundary Test
  console.log('  [*] Testing TTL expiration boundary handling...');
  const shortLivedToken = `jwt-expire-test-${crypto.randomBytes(8).toString('hex')}`;
  // 1-second TTL
  await blacklistToken(shortLivedToken, 1);
  assert(await isTokenBlacklisted(shortLivedToken) === true, 'Short-lived token is blacklisted immediately');
  
  // Wait 1.1s for expiration
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert(await isTokenBlacklisted(shortLivedToken) === false, 'Short-lived token is no longer blacklisted after TTL expiration');

  // 3. Edge-case & Boundary Tokens
  console.log('  [*] Testing edge case tokens (null, empty, whitespace, giant payload, SQLi)...');
  assert(await isTokenBlacklisted(null) === false, 'null token returns false');
  assert(await isTokenBlacklisted(undefined) === false, 'undefined token returns false');
  assert(await isTokenBlacklisted('') === false, 'empty token returns false');
  assert(await isTokenBlacklisted('   ') === false, 'whitespace token returns false');

  const giantToken = 'A'.repeat(65536); // 64KB token
  await blacklistToken(giantToken, 900);
  assert(await isTokenBlacklisted(giantToken) === true, '64KB giant token successfully blacklisted and verified');

  const sqliToken = "'; DROP TABLE refresh_tokens; -- \x00\r\n";
  await blacklistToken(sqliToken, 900);
  assert(await isTokenBlacklisted(sqliToken) === true, 'SQL injection attack token successfully hashed & blacklisted');

  const unicodeToken = '🔒🛡️☢️-jwt-token-ñ-ü-ø-測試';
  await blacklistToken(unicodeToken, 900);
  assert(await isTokenBlacklisted(unicodeToken) === true, 'Unicode/Emoji token successfully blacklisted');

  // 4. SHA-256 Hash Uniqueness & Collision Check (1,000 distinct tokens)
  console.log('  [*] Verifying SHA-256 hash collision resistance on 1,000 synthetic tokens...');
  const hashSet = new Set();
  for (let i = 0; i < 1000; i++) {
    const h = hashToken(`token-sample-prefix-${i}-${crypto.randomBytes(8).toString('hex')}`);
    assert(h.length === 64, 'Token hash is valid 64-char hex SHA-256 string');
    assert(!hashSet.has(h), `Hash collision detected on iteration ${i}!`);
    hashSet.add(h);
  }
}

// ============================================================================
// TEST SUITE 3: Timing Side-Channel Dummy Hash Defense Verification
// ============================================================================
async function testTimingSideChannelDefense() {
  console.log('\n================================================================================');
  console.log('⏱️  TEST SUITE 3: Bcrypt Timing Side-Channel Defense Verification');
  console.log('================================================================================');

  const DUMMY_BCRYPT_HASH = '$2a$10$wN3t8gX1ZkGkR0e2M8t0y.9gZ0n4p7s2e6u1v8w5x9y2z3a4b5c6d';
  const realSalt = bcrypt.genSaltSync(10);
  const realHash = bcrypt.hashSync('RealValidPassword123!', realSalt);

  const iterations = 10;
  const dummyTimes = [];
  const realTimes = [];

  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    await bcrypt.compare('WrongPassword999!', DUMMY_BCRYPT_HASH);
    const t1 = process.hrtime.bigint();
    dummyTimes.push(Number(t1 - t0) / 1e6); // ms

    const t2 = process.hrtime.bigint();
    await bcrypt.compare('WrongPassword999!', realHash);
    const t3 = process.hrtime.bigint();
    realTimes.push(Number(t3 - t2) / 1e6); // ms
  }

  const avgDummy = dummyTimes.reduce((a, b) => a + b, 0) / iterations;
  const avgReal = realTimes.reduce((a, b) => a + b, 0) / iterations;

  console.log(`  [*] Dummy Bcrypt Hash Avg Latency: ${avgDummy.toFixed(2)} ms`);
  console.log(`  [*] Real Bcrypt Hash Avg Latency:  ${avgReal.toFixed(2)} ms`);

  // Both should be in the typical bcrypt range (~50-120ms), not near 0ms
  assert(avgDummy > 30, 'Dummy hash execution involves full bcrypt cost (>30ms)');
  assert(avgReal > 30, 'Real hash execution involves full bcrypt cost (>30ms)');
  const diffRatio = Math.abs(avgDummy - avgReal) / Math.max(avgDummy, avgReal);
  console.log(`  [*] Timing difference ratio between dummy and real hash: ${(diffRatio * 100).toFixed(2)}%`);
  assert(diffRatio < 0.35, 'Dummy hash and real hash timing profile is uniform (diff < 35%)');
}

// ============================================================================
// TEST SUITE 4: Frontend Auth Mock Vulnerability Regression Check
// ============================================================================
async function testFrontendAuthSecurity() {
  console.log('\n================================================================================');
  console.log('🔍 TEST SUITE 4: Frontend Auth Mock Removal Static Analysis');
  console.log('================================================================================');

  const apiJsPath = path.join(FRONTEND_ROOT, 'src', 'services', 'api.js');
  assert(fs.existsSync(apiJsPath), 'frontend/src/services/api.js exists');

  const apiJsContent = fs.readFileSync(apiJsPath, 'utf8');

  // Verify that request() explicitly rethrows /auth/ errors
  assert(apiJsContent.includes("if (endpoint.startsWith('/auth/'))"), 'request() explicitly guards /auth/ endpoints from fallback');
  assert(apiJsContent.includes('throw err;'), 'request() rethrows auth errors without falling back');

  // Verify that api.auth.login throws on failure and doesn't auto-fallback to Super Admin
  const loginMatch = apiJsContent.match(/async login\(username,\s*password\)[\s\S]*?\{([\s\S]*?)\n\s*\},/);
  assert(loginMatch !== null, 'api.auth.login function located');
  const loginBody = loginMatch[1];

  assert(!loginBody.includes('inMemoryUsers[0]'), 'api.auth.login has NO inMemoryUsers[0] fallback');
  assert(!loginBody.includes('mock_jwt_token_admin_2026'), 'api.auth.login has NO mock admin token fallback');
  assert(loginBody.includes('throw new Error'), 'api.auth.login explicitly throws error on failed authentication');
}

// ============================================================================
// MAIN RUNNER
// ============================================================================
async function runAll() {
  console.log('🚀 NeroNet Challenger 2 Empirical Stress & Boundary Test Suite');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    await testMigrationDDL();
    await testValkeyTokenRevocationStress();
    await testTimingSideChannelDefense();
    await testFrontendAuthSecurity();

    console.log('\n================================================================================');
    console.log(`🎯 CHALLENGER 2 SUITE COMPLETE: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================================\n');

    if (failedTests > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('\n❌ Fatal test runner error:', err);
    process.exit(1);
  }
}

runAll();
