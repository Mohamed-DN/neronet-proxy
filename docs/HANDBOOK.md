# NeroNet engineering handbook

Everything needed to pick this project up: what it is, how the parts fit, what works,
what does not, and what to do next.

Written to be handed to an engineer with no prior context. Claims here are verified
against a running deployment; where something is unverified it says so.

Last updated 2026-09-13.

---

## 1. What NeroNet is

An overlay mesh network with a management console. Two halves:

- **Data plane** — Go. Nodes that form the overlay, route traffic, and enforce policy.
- **Control plane** — Node.js. Enrols nodes, holds state, serves the web console.

### 1.1 Positioning

The mesh VPN market is crowded: Tailscale, NetBird, Netmaker, ZeroTier, Nebula. On
features common to all of them NeroNet is behind, with fewer resources.

What no competitor has, and none will build, because they sell to corporate IT
departments and these features are unsellable there:

- **NeroNuke** — three-tier destruction: scheduled, personal dead man's switch, owner
  global cascade.
- **Plausible deniability passwords** — one password opens the system, another wipes
  it, another wipes it while appearing to open it.
- **Warrant canary** — Ed25519-signed, automatically published.
- **Per-node onion routing** inside the same mesh that carries normal traffic.
- **Cross-mesh federation** with device-level sharing scopes.

Together these are not "a VPN with extras". They are a different category:
infrastructure that assumes the adversary may reach the hardware or the operator.
The audience is journalists, legal practices, researchers — not corporate IT.

**This changes the technical priority.** In that category being *verifiable* matters
more than being *fast*. Competitors win on throughput. The win available here is a
reviewer being able to read the critical path in an afternoon and believe it.

---

## 2. Architecture

### 2.1 Components

```
   Go nodes (cmd/sovereign-node)
        │  /v4/control/*
        ▼
   nginx (console/frontend)  ──►  Node.js API (console/backend)
        │                              │            │
        │  /api/*                      ▼            ▼
        ▼                         PostgreSQL     Valkey
   React console                  durable        hot state
```

`docker-compose.yml` starts four services: `postgres`, `valkey`, `backend`,
`frontend`. Go nodes run separately (`docker-compose.nodes.yml`) and reach the
control plane through nginx.

### 2.2 Go packages

| Package | Lines | Purpose | State |
|---|---:|---|---|
| `pkg/crypto` | 1,574 | Noise handshake, ChaCha20-Poly1305, session ratchet, anti-replay | Correct. Reviewed 2026-09-12. |
| `pkg/routing` | 1,591 | Onion circuits, multipath, scoring | Rewritten 2026-09-12 after a nonce reuse defect. |
| `pkg/control` | 1,725 | **Protocol structs + client (used)**, server implementation (**not deployed**) | See § 4.1 |
| `pkg/acl` | 1,757 | Zero-trust policy compilation and netstack enforcement | Engine works; receives no policy. See § 4.2 |
| `pkg/nat` | 1,730 | STUN, ICE, NAT classification, hole punching | Untested against real NAT |
| `pkg/config` | 2,588 | Flag/env binding, schema validation | Works |
| `pkg/derp` | 768 | Relay fallback, traffic camouflage | Not exercised |
| `pkg/ebpf` | 1,039 | XDP-style packet classification, flow table | Simulation, not real eBPF |
| `pkg/management` | 1,230 | Metrics, events | Prometheus endpoint exists |
| `pkg/posture` | 749 | Device attestation | Works; consumed by heartbeat |
| `pkg/bridge` | 1,020 | SOCKS5, HTTP CONNECT, DoH, sandbox | Works locally |
| `pkg/routes` | 929 | Subnet route management | Never delivered to nodes |

### 2.3 Backend services

| Service | Lines | Purpose | State |
|---|---:|---|---|
| `NukeEngine` | 994 | Destruction, dead man's switches, steganographic unlock | Real. Deletes rows. See § 6.1 |
| `PeeringEngine` | 689 | Cross-mesh federation, Ed25519 tokens | Signature verification added 2026-09-12 |
| `RiskEngine` | 466 | Behavioural risk scoring, impossible travel | Works |
| `WebRtcSignalingEngine` | 448 | Cloud PC signalling | Rows only, no streaming |
| `CanaryService` | 288 | Warrant canary signing and publication | Works |
| `HeartbeatBuffer` | 277 | Heartbeat aggregation in Valkey | Added 2026-09-13 |
| `PolicyEngine` | 240 | ACL evaluation | Works; output never delivered |
| `TopologySync` | 43 | Live topology broadcast | Works |

### 2.4 API surface

102 endpoints across 14 routers. Authentication is JWT (HS256) with a Valkey-backed
revocation list keyed on `jti`. Two roles: `super-admin` and `user`.

---

## 3. The critical gap

**Four of the six control plane endpoints the Go node calls return 404.**

| Endpoint | Purpose | Status |
|---|---|---|
| `/v4/control/register` | Enrolment, overlay address assignment | Implemented |
| `/v4/control/heartbeat` | Telemetry, quarantine signal | Implemented |
| `/v4/control/discover` | **Peer and bridge discovery** | **404** |
| `/v4/control/circuit` | **Onion circuit construction** | **404** |
| `/v4/control/sync-acls` | **Zero-trust policy delivery** | **404** |
| `/v4/control/sync-routes` | **Subnet route delivery** | **404** |

Verified by request against the running backend.

### 3.1 What this means

A node enrols, receives an overlay address, and sends heartbeats. It then does
nothing else:

- **It never learns about other nodes.** There is no mesh, only a list of registrants.
- **It never receives ACL policy.** `pkg/acl` compiles and enforces policy correctly,
  and is handed nothing. Every zero-trust rule configured in the console has no
  effect on any node.
- **It never builds an onion circuit.** The differentiating feature is unreachable
  from a deployed node.
- **It never receives subnet routes.**

The console displays a mesh topology. What it displays is the registration table.

### 3.2 Why it looks finished

The Go implementations of all four are in `pkg/control/server.go`, and the client
calls are in `pkg/control/client.go`. Reading either file, the feature appears
complete. What is missing is the server half in the control plane that actually
runs — the Node.js bridge, which implements two endpoints out of six.

**This is the first thing to fix.** Nothing else about the mesh is meaningful until a
node can discover a peer.

---

## 4. Structural issues

### 4.1 Two control plane implementations

`pkg/control` contains a complete Go control plane: 1,021 lines across `server.go`,
`registry.go`, `vip.go`, plus `cmd/sovereign-control-plane`. **No compose file starts
it.**

What serves `/v4/control/*` is `console/backend/routes/goBridge.js`, 327 lines,
reached through nginx.

The Go server half has no persistence (in-memory maps), no authentication, and no
tenancy. The client and protocol structs in the same package **are** used, by
`cmd/sovereign-node` and `cmd/sovereign-cli`. The struct tags define the wire
contract.

Decision required: complete the Go server, or delete it and keep the package as
protocol definition and client. Until then, changes to the server half do not reach
production. See `pkg/control/README.md`.

### 4.2 Policy is computed and discarded

`PolicyEngine` evaluates ACLs. `pkg/acl` enforces them. Nothing connects the two,
because `/v4/control/sync-acls` does not exist. This is § 3 restated from the policy
side, and it is worth stating separately: the security control the product advertises
is computed correctly and thrown away.

### 4.3 Application layer is interface without implementation

| Feature | Claimed | Actual |
|---|---|---|
| NeroDrop | P2P encrypted transfer, 64 KB chunks, BLAKE3 | `routes/nerodrop.js:68` returns a fabricated SDP string. No `RTCPeerConnection` in the frontend. |
| Cloud PC | Selkies WebRTC, multi-monitor, USB/IP | Rows pointing at `wss://signal.internal.darknero.com`, which does not resolve. |
| App Bundles | Nextcloud, Immich, Seafile, Guacamole provisioning | CRUD on `app_bundles`. No container orchestration. |

**Decision: NeroDrop is deferred.** File transfer over a mesh is solved (Syncthing,
Magic Wormhole, scp over the overlay). It does not differentiate.

Cloud PC and App Bundles: under evaluation. All three must be labelled in the console
as not implemented until they are.

---

## 5. What was fixed, and how it works now

Nine commits, 2026-09-12 to 2026-09-13. Each defect was reproduced before being
fixed.

### 5.1 Cryptography — `5c8bf07`

**Onion nonce reuse.** Hop keys were derived once per circuit and every cell was
sealed with `ConstructNonce(0)`. Under ChaCha20-Poly1305 that repeats the keystream
(`C₁ ⊕ C₂ = P₁ ⊕ P₂` against headers at known offsets) and exposes the Poly1305 key,
so cells could be forged, not only read. Proven: two identical plaintexts produced
byte-identical ciphertext.

Now XChaCha20-Poly1305 with a fresh 24-byte random nonce per layer. The extended
nonce is what makes random generation safe; a shared counter would have reintroduced
a correlator.

**Hop linkability.** One client ephemeral key travelled the whole circuit, re-prefixed
at each peel, so entry and exit observed the same 32 bytes. Now one ephemeral per
hop: entry sees `{eph[0], eph[1]}`, exit sees `{eph[2]}` — disjoint.

**Key derivation.** Raw X25519 output was used directly as an AEAD key. Now HKDF-SHA256
with a hop-position info string.

**Remote panic.** `PeelLayer` sliced on attacker-supplied length fields. Proven:
`slice bounds out of range [:65538] with capacity 7`. All fields bounds-checked.

**Data race** in `pkg/ebpf`, found by running `go test -race` for the first time.
`FlowTable.Get` returns a pointer into the map; `LastSeen` was a multi-word
`time.Time` written without synchronisation while `Get` read it. Now an atomic
Unix-nanosecond field.

### 5.2 Secrets — `e09c601`

Every security-critical setting resolved as `process.env.X || '<hardcoded>'` with no
`NODE_ENV` check. Both compose files passed the published JWT secret inline alongside
`NODE_ENV=production`, and `console/.env.example` shipped with working values — so
requiring variables to be *set* would not have helped.

Now: fatal in production if unset, **and** rejected if the value matches the SHA-256
of any default ever committed here. Hashes are stored, not the literals.

`PGSSL` and certificate verification are separate switches. Previously enabling "SSL"
produced `rejectUnauthorized: false` — encryption without authentication, weaker than
plaintext on a trusted socket while appearing stronger.

### 5.3 Data honesty — `7dd62d4`, `57fc7c5`

`request()` collapsed every failure into `return null`, and nineteen endpoints
answered that null with demo fixtures. A crashed backend, a network error and an
empty database were indistinguishable. Now an empty successful response is returned
as-is, fixtures are opt-in (`VITE_ALLOW_MOCK_DATA`), and a banner names the state.

The control plane wrote `latency_ms = floor(random() * 50 + 10)` on every heartbeat.
The node sent `cpu=5, mem=32, battery=100` constants. Both removed; memory is now
measured and CPU reports 0, which means unknown.

### 5.4 The Go bridge — `57fc7c5`

Eight independent contract breaks, each returning HTTP 200. Field names mismatched on
both sides of both endpoints; `overlay_ipv6` was hardcoded to `fd00::1` on a UNIQUE
column so only one Go node could ever exist; heartbeats were discarded by
`if (!NodeID) return res.json({Status:"ok"})`. Result: 47 node rows, 7 telemetry rows.

Now speaks the contract from `pkg/control/server.go`. Verified with two real nodes
taking `100.64.0.47` and `100.64.0.48` and heartbeating.

### 5.5 Scale — `71cb108`, `d2d3fcd`

| Path | Before | After |
|---|---|---|
| VIP allocation at 100k nodes | 71 ms blocking, ~14 registrations/s | 0.024 ms, constant time |
| `GET /api/nodes` at 100k nodes | 77 MB per request | ≤ 400 KB (500-row cap) |
| Heartbeat writes at 100k nodes | 6,667/s | ~100/s |

VIP allocation used a full table scan plus a JavaScript loop, and was racy. Now a
database counter (PostgreSQL sequence, single-row table in SQLite) plus one indexed
probe.

Heartbeats buffer in Valkey and flush every 30 s. Byte counters use `HINCRBY` so beats
between flushes add; `SPOP` plus `MULTI` prevents losing a beat arriving mid-flush.
List endpoints merge buffered values over stored rows, so reads stay current. Up to
one flush interval of telemetry is lost if Valkey fails; registration and quarantine
stay direct writes.

### 5.6 Authorisation — `460eb6f`

**Federation accepted forged tokens.** `acceptPeeringAgreement` never called
`crypto.verify`. It checked that the signature was not the literal string
`'INVALID_SIGNATURE'` and the expiry was not `'EXPIRED'` — the exact values the tests
passed. Proven live: a token with an invented signature federated a hostile network
with `0.0.0.0/0` shared subnets, response 200.

Now real verification, **plus** an out-of-band fingerprint check. A signature over a
self-supplied public key proves only that the sender holds a key they chose. First
attempt returns 428 with the fingerprint to confirm.

**Cross-tenant access.** Any authenticated user could read any node's name, risk score
and quarantine reason, and POST telemetry to any node id. Now one ownership
middleware returning 404 rather than 403 — 403 confirms existence and turns the
endpoint into an enumeration oracle.

### 5.7 Valkey — `d2d3fcd`

**The cache was never connected.** `lazyConnect: true` meant ioredis did not dial
until the first command, so `isConnected` stayed false and every caller took the
in-memory fallback. The fallback works, so nothing errored. Token revocation,
topology events and rate limits were all per-process.

Fixing it exposed duplicate delivery: events were emitted to the in-memory bus *and*
published to Valkey while subscribers listened on both.

### 5.8 Schema — `d0037a1`

PostGIS declared an extension, a `GEOMETRY` column and a GiST index. The column was
written on every insert and heartbeat and never read — no `SELECT`, no spatial
predicate. It had created a 34-table `tiger` geocoding schema. Removed; coordinates
are plain columns.

Three schema drifts found by a new parity test: `audit_events.metadata` vs
`metadata_json`, `nerodrop_sessions.webrtc_signal` vs `webrtc_signal_json`,
`custom_domains.device_id` PostgreSQL-only. The code used the SQLite names on both
backends, so those PostgreSQL columns were unreachable.

An authentication bypass: `authenticateGateway` accepted the literal `123456` for any
custom domain, unconditionally.

---

## 6. Enterprise readiness

The stated target is regulated buyers — banks, government. This section is the honest
distance to that.

### 6.1 NeroNuke does not destroy data

`executeInstantUserDestruction` scrambles the password hash and email, then issues
`DELETE` across the user's tables. That removes rows. It does not remove data.

After a `DELETE`, the rows remain in:

- the PostgreSQL write-ahead log, until it rotates
- every base backup and every WAL archive
- unvacuumed heap pages
- streaming replicas, until they apply and vacuum

For a product whose premise is destruction under coercion, this is the central gap.
The designed answer is in `BUSINESS_AND_ROADMAP.md`: per-tenant encryption keys, with
destruction meaning key destruction. **Not implemented anywhere.**

Crypto-shredding also has a trap worth stating: wrapping a symmetric tenant key
(already post-quantum safe) with X25519 or RSA makes it post-quantum vulnerable.
Whoever captures the backup today opens it later, and the shredding achieved nothing.
Derive the wrapping key from a passphrase with Argon2id, or use hybrid
X25519 + ML-KEM-1024.

### 6.2 The audit log is not tamper-evident

`audit_events` is an ordinary table. No hash chain, no signatures, no append-only
constraint. Anyone with database access can edit or delete entries, including the
entries recording that they did.

Regulated buyers require an audit trail that survives an attacker with database
access. Minimum: each row carries the hash of its predecessor, the chain head is
signed periodically, and the signature is published somewhere the database cannot
reach. The warrant canary already has the signing machinery.

### 6.3 Remaining gaps

| Requirement | State |
|---|---|
| External cryptographic audit | None. A nonce reuse defect was found in-house this week. |
| Reproducible builds, signed artefacts, SBOM | None. |
| SSO / OIDC | None. Blocks any organisational deployment. |
| Written threat model | None. |
| Key rotation procedure | None. |
| High availability | Designed, not built. See `ROADMAP.md` § 1. |
| Backup and restore procedure | None documented or tested. |
| Penetration test | None. |
| Mobile clients | None. |

### 6.4 What is in place

- No usable secret in any committed file, enforced by a test.
- Backend unprivileged: uid 10001, read-only root filesystem, all capabilities
  dropped, `no-new-privileges`.
- Rate limiting on sign-in, registration and enrolment, shared across instances.
- CSP with `frame-ancestors 'none'`, HSTS in production.
- Tenant isolation enforced centrally and probed by a test that enumerates routes.
- Hybrid post-quantum TLS on the control plane, with tests that fail if it is
  silently disabled.
- JWT revocation with `jti` and a shared blacklist.
- Federation requires signature verification and out-of-band fingerprint confirmation.

---

## 7. Data model

18 tables. Core entities:

- `users` — identity, role, tier (tier to be removed, see `ROADMAP.md` § 9)
- `nodes` — mesh members, overlay addresses, telemetry, posture, risk
- `peering_agreements` — cross-mesh federation
- `dead_man_switch` — NeroNuke timers, two tiers
- `warrant_canaries` — signed statements
- `audit_events` — security events (see § 6.2)
- `node_telemetry_history` — position history for impossible-travel detection
- `app_bundles`, `cloud_pcs`, `custom_domains`, `nerodrop_sessions` — application
  layer (see § 4.3)

Two schemas are maintained by hand: SQLite DDL in `db/migrator.js`, PostgreSQL in
`db/migrations/*.sql`. `tests/schema_parity.test.js` compares them; they had already
drifted three times before it existed.

Six migrations. `004` and `005` remove PostGIS and align names; `006` adds the VIP
sequence.

---

## 8. Running it

### 8.1 Local

```bash
cp .env.example .env && chmod 600 .env

for key in SOVEREIGN_JWT_SECRET SOVEREIGN_REFRESH_SECRET SOVEREIGN_ADMIN_PASS POSTGRES_PASSWORD; do
  printf '%s=%s\n' "$key" "$(openssl rand -base64 48)"
done >> .env
printf 'SOVEREIGN_REGISTRATION_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env

docker compose up -d
```

The API refuses to start without those secrets. That is intentional.

Run a node against it:

```bash
set -a && . ./.env && set +a
go run ./cmd/sovereign-node -control-url http://127.0.0.1:8081 -country IT
```

### 8.2 Configuration that matters

| Variable | Effect if wrong |
|---|---|
| `SOVEREIGN_TRUST_PROXY_HOPS` | Too low: every request reports the proxy address, so rate limiting buckets the whole world together. Too high: a client forges `X-Forwarded-For` and bypasses the limiter. |
| `SOVEREIGN_REGISTRATION_TOKEN` | Unset in production: no node can enrol. |
| `SOVEREIGN_VALKEY_NAMESPACE` | Unset with a shared Valkey: deployments cross-talk. `{pid}` is substituted. |
| `SOVEREIGN_DATA_DIR` | Wrong: the federation identity lands outside the volume and is destroyed on container recreation. |
| `PGSSL_INSECURE` | Refused in production. |

### 8.3 Known operational traps

- The PostgreSQL password is written into the volume at first initialisation.
  Changing the environment variable does not rotate it — use `ALTER USER`.
- Migrating from a root container to the unprivileged image leaves volume files owned
  by root. Once:
  `docker run --rm -v <volume>:/data alpine chown -R 10001:10001 /data`
- `charts/` and `k8s/` exist and have never been applied to a real cluster.

---

## 9. Testing

| Suite | Count | Command |
|---|---:|---|
| Backend | 203 | `npm --prefix console/backend test` |
| Frontend | 11 | `npm --prefix console/frontend test` |
| Go | 13 packages | `go test -race ./...` |

### 9.1 Test rules

**Tests execute the system; they do not read its source.** The suite reported 140
passing and an independent "victory confirmed" verdict while missing nonce reuse, a
data race, an authentication bypass and a federation endpoint accepting forged
tokens. The cause was assertions of the form
`assert(ddl.includes('CREATE INDEX ... USING GIST'))`, which pass with PostgreSQL
never started.

**Reproduce the defect before fixing it.** Every fix starts from a check that fails
against current code.

**Never swallow an error before an irreversible step.** Migration 004 caught a failed
coordinate copy with a log notice and dropped the column anyway: 46 coordinates
destroyed.

### 9.2 Flakiness

The suite was intermittently failing until 2026-09-13. Every test process shared one
Valkey namespace, so a topology event published by one file reached a subscriber in
another. Namespaces are now per process (`test-{pid}`). Eight consecutive clean runs
with Valkey connected.

Flaky tests are worse than failing ones: they train everyone to re-run until green.
CI must run the backend suite three times.

---

## 10. What to do next, in order

### 10.1 Implement the four missing control plane endpoints

Nothing about the mesh works until this is done. In order of dependency:

1. `/v4/control/discover` — peer and bridge discovery. Without it there is no mesh.
2. `/v4/control/sync-acls` — policy delivery. The enforcement engine already exists
   and receives nothing.
3. `/v4/control/sync-routes` — subnet routes.
4. `/v4/control/circuit` — onion circuits.

The Go implementations in `pkg/control/server.go` are the reference for behaviour and
the struct tags are the contract. Decide § 4.1 first: implementing these in the Node
bridge is the third implementation of the same logic otherwise.

### 10.2 Federation revocation

Three cases, none of which currently drop anything:

1. Owner withdraws a shared device — the peer's sessions must close and the route be
   withdrawn. Removing the database row does not close an established tunnel.
2. The peer wipes their devices or triggers NeroNuke — the local side must detect this
   and tear down rather than holding routes to devices that no longer exist.
3. The agreement expires or is revoked — all imported nodes, routes and sessions go.

`HeartbeatResponse.revoked_keys` exists in the contract and is always empty. That is
the delivery channel for case 1. Cases 2 and 3 need peer liveness checks and a
cascade from NeroNuke outward.

### 10.3 Crypto-shredding

§ 6.1. This is what makes NeroNuke mean what it claims.

### 10.4 Tamper-evident audit log

§ 6.2. Prerequisite for any regulated buyer.

### 10.5 Then

`ALTER TABLE nodes SET (fillfactor = 70)`; remove monetisation (`ROADMAP.md` § 9);
Rosenpass for tunnel post-quantum; OIDC; high availability (`ROADMAP.md` § 1).

---

## 11. Reading order for a new engineer

1. This document.
2. `docs/ROADMAP.md` — phases, decisions, competitor parity.
3. `pkg/control/README.md` — why half that package is not deployed.
4. `pkg/crypto/noise.go` — the handshake. It is correct and worth reading as the model.
5. `pkg/routing/onion.go` — the circuit layer, and `onion_regression_test.go` beside
   it, which documents four defects by reproducing them.
6. `console/backend/routes/goBridge.js` — the control plane that actually runs.
7. `console/backend/services/NukeEngine.js` — the differentiating feature.

Do not start from `.agents/`. It contains 487 files of generated progress reports
asserting completion of work that was not complete.
