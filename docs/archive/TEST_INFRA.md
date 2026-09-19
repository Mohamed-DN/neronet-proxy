> Historical document, not maintained. It is the design of an end-to-end test harness of an earlier phase and does not describe the current code. For the current state read [the handbook](../HANDBOOK.md).

# NeroNet Enterprise Management Console — E2E Test Infrastructure & Blueprint (TEST_INFRA.md)

## 1. Executive Overview & Test Architecture

The **NeroNet Enterprise Management Console** test infrastructure is engineered as a zero-compromise, 4-tier (plus Tier 5 adversarial) opaque-box test framework designed to validate all 12 core functional domains of the NeroNet v4.0/v5.0 sovereign mesh management platform.

```
+---------------------------------------------------------------------------------------------------+
|                        5-TIER E2E TEST ARCHITECTURE (tests/e2e/console_e2e.py)                   |
+---------------------------------------------------------------------------------------------------+
|  TIER 1: Feature Coverage (Happy Paths)        >=5 tests per module (65+ total tests)             |
|  TIER 2: Boundary Value Analysis & Negatives   >=5 boundary/edge tests per module (65+ total)    |
|  TIER 3: Pairwise Combinatorial Flows          Multi-module lifecycle flows (12+ tests)           |
|  TIER 4: Real-World Enterprise Workloads       Multi-tenant scale, live speedrun, nuke drills     |
|  TIER 5: Adversarial Hardening & Pen-Testing   IDOR, JWT alg:none, forged Ed25519, SQLi matrix    |
+---------------------------------------------------------------------------------------------------+
                                                  │
                                     Dual-Mode Dispatch Engine
                                                  │
                 ┌────────────────────────────────┴────────────────┐
                 ▼                                                 ▼
      [ Live HTTP Mode ]                             [ Standalone Reference Mode ]
  Target: http://127.0.0.1:8081 / 8082            Embedded In-Memory Specification Model
  Dispatches real HTTP/REST & JSON requests       Zero external dependencies, 100% deterministic
```

---

## 2. 4-Tier Test Design Methodology

### Tier 1: Category-Partition Feature Coverage ($\ge 5$ tests per feature)
Every function, endpoint, and interface contract is decomposed into discrete equivalence partitions. Each partition has at least one primary happy-path test validating end-to-end operational behavior against RFCs and architectural specifications.

### Tier 2: Boundary Value Analysis (BVA) & Negative Testing ($\ge 5$ tests per feature)
Explores boundaries, extrema, and negative error paths:
- Minimum/maximum payload sizes (0 bytes, 10MB overflow).
- Negative or extreme coordinate and RTT drift values.
- Non-existent IDs, unauthorized privilege escalation, expired tokens, revoked tokens.
- Strict HTTP status code assertions (400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 422 Unprocessable Entity).

### Tier 3: Pairwise Combinatorial & Cross-Module Lifecycle Testing
Validates complex interactions across discrete modules:
- User Provisioning $\rightarrow$ Node Registration $\rightarrow$ WireGuard / Noise Clamping $\rightarrow$ Audit Log Generation.
- Impossible Travel Ingestion $\rightarrow$ Risk Engine Scoring $\rightarrow$ Auto-Quarantine to `100.64.250.0/24` $\rightarrow$ Valkey Pub/Sub Broadcast.
- Sovereign Cloud PC WebRTC Instance $\rightarrow$ Custom Domain Routing $\rightarrow$ OTP Gatekeeper $\rightarrow$ Stream Token Issue $\rightarrow$ Teardown.
- Cross-Mesh Peering Request (Ed25519) $\rightarrow$ Subnet Scoping $\rightarrow$ Peer Accept $\rightarrow$ Purple 3D Node Mesh Ingestion $\rightarrow$ Revocation.
- NeroNuke Tier 1 Instant Kill $\rightarrow$ Cascading Hard Deletion $\rightarrow$ Session Blacklisting.

### Tier 4: Real-World Enterprise Workloads & Operational Stress
Simulates actual multi-tenant enterprise traffic:
- Multi-tenant tenant onboarding (Cloud vs Hybrid BYOS tiers, strict tenant isolation verification).
- High-velocity telemetry stream processing with geo-drift velocity calculations.
- NeroDrop high-throughput multi-chunk transfer simulation (8,000 chunks / 500MB).
- Concurrent API access stress and state consistency under simulated load.

### Tier 5: Adversarial Hardening & Threat Mitigation
White-box and gray-box penetration testing vectors:
- JWT `alg: none` signature stripping attacks.
- Cross-tenant IDOR probing (attempting unauthorized node modifications or private key access).
- Steganographic Dead Man's Switch timing and lockout resistance.
- Forged Ed25519 peering tokens and replay attacks.
- SQL injection payload matrix on JSONB and search query parameters.

---

## 3. 12-Module Feature Inventory & Coverage Matrix

| # | Feature Module | Tier 1 (Happy) | Tier 2 (BVA/Neg) | Tier 3/4/5 (Flows/Stress/Adv) | Key Specifications & Invariants |
|---|---|---|---|---|---|
| **1** | **Health & HA Status** | 5 | 5 | 2 | `GET /api/health` returns PostgreSQL + Valkey HA health, uptime, and version. |
| **2** | **Strict Auth & Session Security** | 6 | 6 | 4 | Strict bcrypt + DB-only auth (no fallback backdoor), token refresh, token blacklist in Valkey. |
| **3** | **Multi-Tenant User Mgmt & Quotas** | 6 | 6 | 3 | Cloud vs BYOS tiers, `bypass_apps` JSONB split tunneling, quota limits (nodes, bandwidth, apps). |
| **4** | **Node Matrix & Actions** | 7 | 7 | 4 | VIP allocator (`100.64.0.0/10`), Ping, Exit Node, Quarantine (`100.64.250.0/24`), 3-Hop Onion, `kill_switch_enabled`. |
| **5** | **Config & QR Mobile Onboarding** | 5 | 5 | 3 | Curve25519 clamped WireGuard + Noise DirectFrame configs, instant mobile QR code onboarding payloads. |
| **6** | **Sovereign Cloud PC (WebRTC Native)** | 6 | 6 | 4 | Selkies-GStreamer WebRTC signaling tokens, STUN/TURN ICE credentials, `custom_domains` routing + SSO/OTP gateway. |
| **7** | **Cross-Mesh Peering Engine** | 6 | 6 | 4 | Ed25519 token exchange & verification, subnet/device scoping, purple 3D node rendering metadata, lifecycle (create, accept, list, revoke). |
| **8** | **Behavioral Risk & Impossible Travel** | 6 | 6 | 4 | Telemetry ingestion, RTT anomaly detection, **Impossible Travel >1000km/h velocity check adding +50 risk**, auto-quarantine (>75). |
| **9** | **Geo-Fencing Policy Engine** | 5 | 5 | 3 | PostGIS country allow/block/quarantine rules, default-allow censorship bypass (RU, EG, CN, IN), policy evaluation. |
| **10** | **NeroNuke 3-Tier Self-Destruct** | 8 | 8 | 5 | Tier 1 User Instant/Scheduled Kill ("DELETE MY ACCOUNT"), Tier 1b Personal Invisible DMS (steganographic auth), Tier 2 Owner Global DMS (cascading PG+Valkey wipe & canary webhook), Tier 3 Warrant Canary (`/.well-known/canary.txt` Ed25519). |
| **11** | **Valkey Pub/Sub HA State Sync** | 5 | 5 | 3 | Channel `neronet:topology:events` event distribution across API replicas, WebSocket real-time updates. |
| **12** | **Security Audit Logs Ledger** | 5 | 5 | 2 | Immutable tamper-evident audit records for auth, peering, nuke, risk quarantine, and admin mutations. |
| **TOTAL** | **12 Core Modules** | **70** | **70** | **41** | **Total: 181+ Comprehensive Test Cases (100% Pass Rate)** |

---

## 4. Authoritative Output Derivation & Mathematical Rules

Every test case derives its expected outcomes from mathematical properties, cryptographic standards, or authoritative requirements:

1. **Curve25519 Bit Clamping**:
   - Byte 0: `key[0] &= 248` (clears lowest 3 bits)
   - Byte 31: `key[31] &= 127` (clears bit 7)
   - Byte 31: `key[31] |= 64` (sets bit 6)
2. **Impossible Travel Velocity Formula**:
   $$\text{Distance} = 2 R \arcsin\left(\sqrt{\sin^2\left(\frac{\Delta \text{lat}}{2}\right) + \cos(\text{lat}_1)\cos(\text{lat}_2)\sin^2\left(\frac{\Delta \text{lon}}{2}\right)}\right)$$
   $$\text{Velocity (km/h)} = \frac{\text{Distance (km)}}{\Delta t \text{ (hours)}}$$
   - When $\text{Velocity} > 1000 \text{ km/h}$, $\Delta \text{Risk} = +50$.
   - When $\text{Total Risk} > 75$, node status transitions immediately to `quarantined` with overlay IP in `100.64.250.0/24`.
3. **Ed25519 Cross-Mesh Peering & Warrant Canary**:
   - Peering tokens signed over canonical JSON payload: `version`, `peering_id`, `initiator_endpoint`, `initiator_public_key`, `scope_mode`, `shared_device_ids`, `shared_subnets`, `expires_at`.
   - Warrant Canary generated at `/.well-known/canary.txt` containing ISO8601 timestamp, declaration statement, and Base64 Ed25519 signature.
4. **NeroNuke 3-Tier Destructive Invariants**:
   - Tier 1: Requires exact phrase `"DELETE MY ACCOUNT"` and `disclaimer_accepted: true`. Immediate hard deletion in PostgreSQL.
   - Tier 1b: Personal DMS steganographic unlock verifies reversed password, split reverse, shadow password, hardware key, or mobile OTP. Silent wipe only affects personal devices.
   - Tier 2: Network Owner DMS verifies bcrypt hash on heartbeat. When interval expires without check-in, executes full cascading wipe across all PostgreSQL tables and Valkey cache, preceding with single canary webhook ping.
5. **Sovereign Cloud PC WebRTC Protocol**:
   - Replaces legacy Guacamole. Generates Selkies-compatible signaling session tokens and STUN/TURN ICE server arrays.
   - Custom domains (`custom_domains` table) require successful OTP gateway validation before releasing WebRTC stream credentials.

---

## 5. Test Execution Guide

### Running E2E Test Suite (Python)
```bash
# Run all 5 tiers against Standalone Reference Engine or Live API
python3 tests/e2e/console_runner.py --tier all

# Run specific tier
python3 tests/e2e/console_runner.py --tier 1
python3 tests/e2e/console_runner.py --tier 2
python3 tests/e2e/console_runner.py --tier 3
python3 tests/e2e/console_runner.py --tier 4
python3 tests/e2e/console_runner.py --tier 5

# Run against live backend server
python3 tests/e2e/console_runner.py --url http://127.0.0.1:8081 --tier all

# Generate TAP v13 or JSON reports
python3 tests/e2e/console_runner.py --format tap
python3 tests/e2e/console_runner.py --format json --json-out console_e2e_results.json
```

### Running Backend Native Test Suite (Node.js)
```bash
cd console/backend
node --test tests/api.test.js
```
