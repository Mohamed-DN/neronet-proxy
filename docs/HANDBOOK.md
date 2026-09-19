# NeroNet engineering handbook

What NeroNet is, how the parts fit together, what runs, what does not, and what to do
next. It is written for an engineer with no prior context.

Every statement about the code was checked by reading the code on `main`. A component
described as tested is not necessarily running: where the two differ this document says
which is which. Decisions are recorded in [`docs/adr/`](adr/).

Last updated 2026-09-20.

---

## 1. What NeroNet is

An overlay mesh network with a management console. Two halves:

- **Nodes**, written in Go. A node enrols with the control plane, reports its state and
  runs a local proxy. The overlay network between nodes (the data plane) is a spike that
  is off by default; see section 2.
- **Control plane**, written in Node.js. It enrols nodes, holds state, serves the API and
  the web console.

### 1.1 Positioning

The mesh VPN market is crowded: Tailscale, NetBird, Netmaker, ZeroTier, Nebula. On the
features they have in common NeroNet is behind, with fewer resources.

The target buyers are banks and public administration
([ADR 0006](adr/0006-target-market-banks-and-public-administration.md)). What they need
from the product, in order of priority:

- single sign-on, a role model with an auditor role, and an audit trail that survives an
  attacker with database access;
- high availability and backup with restore that is proven by a test;
- an Italian and English console that meets WCAG 2.1 AA
  ([ADR 0013](adr/0013-frontend-typescript-i18n-accessibility.md));
- destruction of an organisation's data by destroying its encryption key, with two people
  approving and with a legal hold (NeroNuke, reworked; see section 6.1);
- a transport that can be reviewed: WireGuard for the tunnel
  ([ADR 0008](adr/0008-wireguard-data-plane-transport.md)) and an onion layer above it,
  which is the part that needs external review.

Features that other products in this market do not offer, and that the code contains:

- **Onion routing** per node, inside the same mesh. Implemented in `pkg/routing`, not
  used by any running node (section 2.2).
- **Warrant canary**, Ed25519-signed and published automatically.
- **Cross-mesh federation** with signed agreements and an out-of-band fingerprint check.
- **NeroNuke**, three tiers of destruction: scheduled, personal dead man's switch, and
  owner global cascade.

NeroNuke, the plausible-deniability passwords, the personal dead man's switch and onion
routing are active by default. An organisation that cannot hold them, such as a bank with
retention duties, switches them off with the `regulated` profile (ADR 0015). The
per-organisation profile does not exist yet: on `main` the features are active for
everyone.

In this market being *verifiable* matters more than being *fast*. The goal is that a
reviewer can read the critical path in an afternoon and believe it.

---

## 2. Architecture

### 2.0 Current state

**There is no data plane in the default configuration.** Nodes do not build tunnels to
each other. What runs:

- Nodes enrol, get an overlay address from `100.64.0.0/10`, send a heartbeat every 15
  seconds, and pick up ACL and subnet-route changes by epoch.
- The node runs a SOCKS5 and an HTTP CONNECT proxy. Both dial the destination directly
  from the node's own network stack, after a DNS-over-HTTPS lookup and a check against
  private address ranges and a list of abuse ports.
- The control plane ranks exit bridges (`/v4/control/discover`) and selects a three-hop
  path (`/v4/control/circuit`). No node builds a circuit from it.
- The console shows the values nodes report, and shows a value a node did not measure as
  unknown.

What does not run:

- The overlay address is not configured on any interface.
- The ACL policy a node downloads is loaded into an in-memory filter, and no traffic
  passes through the filter.
- Onion cells are never sealed or peeled by a node. NAT traversal is never attempted by
  a node. No node connects to a DERP relay.

What exists behind a flag: `pkg/dataplane` runs WireGuard through `wireguard-go` in
`netstack` mode (userspace, no privileges) or `tun` mode (kernel interface), applies the
ACL filter to the packets in both directions, and lets the proxies dial overlay
addresses through it. It starts when the node runs with `-dataplane netstack` or
`-dataplane tun`. The default is `off`, the compose stack does not enable it, and peers
come from a local file, not from the control plane. The record of the design and the
measurements is [ADR 0020](adr/0020-data-plane.md).

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

`docker-compose.yml` starts four services: `postgres`, `valkey`, `backend`, `frontend`.
The Go nodes and two DERP relays are in the same file under the `nodes` profile. The
nodes reach the control plane through nginx. The edge serves plain HTTP; TLS is not
configured in the stack.

### 2.2 Go packages

Line counts include tests.

| Package | Lines | Purpose | Runs in a node? |
|---|---:|---|---|
| `pkg/crypto` | 1,574 | X25519 keys (the node identity), ChaCha20-Poly1305 and XChaCha20-Poly1305, Noise handshake, session ratchet, replay window, wire framing | Keys and AEAD: yes. Noise, ratchet, replay, wire: no. WireGuard replaces them ([ADR 0008](adr/0008-wireguard-data-plane-transport.md)) |
| `pkg/routing` | 1,590 | Onion circuits: sealing and peeling of cells, multipath, scoring | No. Imported only by the Go control plane server and by tests |
| `pkg/control` | 1,928 | Protocol structs and client (used); server implementation (not deployed) | Client: yes. See section 4.1 |
| `pkg/acl` | 1,757 | Policy compilation and packet filter | Policy is loaded; the filter sees packets only with the data plane on |
| `pkg/dataplane` | 2,508 | WireGuard device, netstack and TUN modes, ACL filter on packets | Only with `-dataplane`; spike |
| `pkg/nat` | 1,734 | STUN, ICE candidates, NAT classification, hole punching | No. `sovereign-cli stun-ping` and the relay's STUN server use it. Not tested against real NATs |
| `pkg/derp` | 768 | Relay server and client, decoy web page | The relay binary runs in the compose stack. No node uses the client |
| `pkg/config` | 2,586 | Flag and environment binding, schema validation | Yes |
| `pkg/management` | 1,230 | Metrics and events for the Go control plane server | No. Imported by the server half of `pkg/control` only |
| `pkg/posture` | 984 | Posture attestation structure | Yes. The heartbeat carries it |
| `pkg/bridge` | 1,241 | SOCKS5, HTTP CONNECT, DoH resolver, egress sandbox, overlay dialing | Yes |
| `pkg/routes` | 929 | Subnet route types | Types only, used by the client and the server half |

`cmd/sovereign-security-daemon` is a separate Go module: a honeypot listener, a threat
scorer and firewall drivers (`ipset`, `nftables`, `ufw`). It has tests. Nothing in the
compose stack starts it; `docker/Dockerfile` packages it with the legacy scripts.

### 2.3 Backend services

Line counts include everything in the file.

| Service | Lines | Purpose | State |
|---|---:|---|---|
| `NukeEngine` | 1,100 | Destruction, dead man's switches, steganographic unlock | Deletes rows. See section 6.1 |
| `PeeringEngine` | 703 | Cross-mesh federation, Ed25519 tokens | Signature and fingerprint verified. Imports fixed placeholder nodes; see the roadmap, section 4 |
| `RiskEngine` | 478 | Behavioural risk scoring, impossible travel | Runs on the data nodes report |
| `WebRtcSignalingEngine` | 456 | Cloud PC signalling | Rows only, no streaming. Behind a feature flag |
| `CanaryService` | 302 | Warrant canary signing and publication | Runs |
| `HeartbeatBuffer` | 347 | Heartbeat aggregation in Valkey | Runs |
| `AclEngine` | 256 | Rule compilation and epochs | Runs; output is delivered and not enforced |
| `PolicyEngine` | 266 | Country geofencing policies | Used by the geofencing routes |
| `CircuitEngine` | 240 | Selection of a three-hop path with a diversity report | Runs |
| `RouteEngine` | 214 | Subnet routes per node | Runs |
| `RevocationEngine` | 143 | Revoked key window carried in heartbeat responses | Runs |
| `TopologySync` | 43 | Live topology broadcast | Runs |

### 2.4 API surface

88 route handlers in 14 route files. The `stats`, `risk` and canary routers are each
mounted at two paths. Console users authenticate with a JWT (HS256, 15 minute access
token) whose `jti` is checked against a revocation list in Valkey and in the database.
There are two roles: `super-admin` and `user`. Nodes do not use JWTs; see section 3.

---

## 3. The node protocol

Six endpoints under `/v4/control` serve the Go node. All of them are implemented in
`console/backend/routes/goBridge.js` and all of them require the enrolment token
(`SOVEREIGN_REGISTRATION_TOKEN`) in the `Authorization: Bearer` header. The token is one
value shared by the whole fleet. Per-node credentials and proof that a node holds its
private key are not implemented.

| Endpoint | Purpose |
|---|---|
| `/v4/control/register` | Enrolment and overlay address assignment. Registering a known key again keeps its stored role, IP class and country, and records an audit event when the request differs |
| `/v4/control/heartbeat` | Telemetry, posture attestation, quarantine signal, revoked keys, epochs |
| `/v4/control/discover` | Exit bridge discovery with ranking |
| `/v4/control/sync-acls` | Compiled ACL policy for the node, by epoch |
| `/v4/control/sync-routes` | Subnet routes for the node, by epoch |
| `/v4/control/circuit` | Selection of a three-hop path |
| `/v4/control/netmap` | The node's complete peer set, keys, endpoints, compiled policy, routes and revocations as one versioned document. See `docs/adr/0020-data-plane.md` section 4 |

What a real node does with them, verified with the node binary:

- **Discovery.** `sovereign-cli peers DE` returns ranked bridges.
- **ACL delivery.** The node logs `Zero Trust ACL policy loaded (epoch: N, outbound
  rules: M)` on enrolment, and `Updated ACL policy to epoch N+1` within one heartbeat of
  a rule changing. The policy is loaded into a filter that no traffic passes through,
  unless the data plane is on.
- **Subnet routes.** The node logs `Subnet routes synced (epoch: E, count: C)`. The
  routes are received and not installed anywhere.
- **Circuits.** `sovereign-cli circuit US` prints a three-hop path. It is a selection.
  No handshake runs and no cell is sent.

### 3.1 Two behaviours to know before changing anything here

**ACL delivery is allow-all with no rules, enforcement is default-deny.** `pkg/acl`
denies anything no rule permits, so an empty rule set delivered to a fleet would drop all
traffic. The control plane compiles allow-all when no rules exist: a mesh with no policy
written is open, and closes when the first rule is written. Changing that default
without changing the enforcement side takes the mesh down on deploy
([ADR 0005](adr/0005-acl-delivery-allow-all-enforcement-default-deny.md)).

**Epochs are the only channel that tells a running node its policy is stale.** They are
reported in the register and heartbeat responses. A constant there makes
`hbResp.PolicyEpoch > policyEpoch` permanently false, and policy delivery works once at
enrolment and never again. It looks correct in every direct test of the sync endpoint.

### 3.2 Circuit path selection

The security decision in onion routing is which relays are chosen, not how the cell is
sealed. A circuit whose hops share an operator or an autonomous system protects nothing
against that party: they observe entry and exit and correlate directly.

Selection prefers independent hops wherever the fleet can provide them, and the response
carries a `diversity` object stating what was achieved. It does not refuse a
non-diverse path: a self-hosted mesh has one operator by definition, and onion routing
still conceals traffic from network observers and from the destination, just not from the
operator, who is the user. What must never happen is a caller believing it has anonymity
it does not.

This matters for the fleet shape the product targets. An operator running a thousand
machines across many networks gets full network diversity and no operator diversity:
strong against an ISP or a destination, weak against anyone who can compel that one
operator. Operator diversity is what a single owner cannot provide for themselves, and is
the argument for third-party exit nodes.

---

## 4. Structural issues

### 4.1 Two control plane implementations

`pkg/control` contains a complete Go control plane: 1,021 lines across `server.go`,
`registry.go` and `vip.go`, plus `cmd/sovereign-control-plane`. No compose file starts
it. What serves `/v4/control/*` is `console/backend/routes/goBridge.js` (692 lines),
reached through nginx.

The Go server half keeps nodes in memory, has no authentication that it checks and no
tenancy. The client and the protocol structs in the same package are used by
`cmd/sovereign-node` and `cmd/sovereign-cli`, and their struct tags define the wire
contract.

Decision: the server half is removed, the types and the client stay, and the contract
becomes a JSON Schema generated from the Go structs
([ADR 0007](adr/0007-remove-go-control-plane-server.md)). The removal is not done. Until
it is, changes to the server half do not reach any deployment. See
[`pkg/control/README.md`](../pkg/control/README.md).

### 4.2 Policy is computed and delivered, and not enforced by default

`AclEngine` compiles the rules. `/v4/control/sync-acls` delivers the compiled policy to
each node and the node loads it into `pkg/acl`. Nothing applies it to traffic, because
without the data plane no traffic goes through a node's filter. With `-dataplane` on, the
filter is applied to the packets, and it is off unless the spike configuration turns
enforcement on ([ADR 0020](adr/0020-data-plane.md)). This is the gap between what the
console configures and what the network does.

### 4.3 The application layer

| Feature | State |
|---|---|
| NeroDrop | Deleted ([ADR 0003](adr/0003-remove-nerodrop.md)) |
| App Bundles | Deleted ([ADR 0014](adr/0014-confirm-earlier-decisions.md)) |
| Cloud PC | Frozen behind `SOVEREIGN_FEATURE_CLOUD_PC`, off by default. The registry and custom-domain records work as database records; there is no streaming ([ADR 0010](adr/0010-freeze-cloud-pc.md)) |

---

## 5. What was fixed, and how it works now

The defects below were found and fixed between 2026-09-12 and 2026-09-20. Each was
reproduced before it was fixed. Commit hashes refer to the repository history.

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

**Data race** in `pkg/ebpf`, found by running `go test -race` for the first time. The
package was a simulation that no code used, and has since been removed.
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
empty database were indistinguishable. An empty successful response is now returned
as-is, and the fixtures, which were opt-in behind `VITE_ALLOW_MOCK_DATA` for a time,
are gone: `services/mockData.js` and `services/dataSource.js` were deleted in
WP-402 and no fixture module is in the production bundle. The banner that named the
data source is now a connection indicator that says whether the control plane is
answering and whether live updates are arriving.

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

### 5.9 Node and console hardening

- **Heartbeat authentication.** `/v4/control/heartbeat` was the only node endpoint that
  required no credential. It now requires the enrolment token before it touches the
  database, so the answer does not depend on whether a node id exists.
- **Re-registration.** Registering a key that is already known keeps the stored role, IP
  class and country. A request that asks for different values is answered normally and
  recorded as a `node.reregister_mismatch` audit event.
- **Secret-verifying endpoints.** The personal dead man's switch unlock has a limit of 5
  attempts per 15 minutes per account, and the custom-domain gateway has limits per domain
  and per address. Both fail closed if Valkey is unavailable. The nuke router is no
  longer mounted at the root of the origin; only the three warrant canary paths are.
- **Dead man's switch unlock.** The personal switch opens with the credential the user
  stored and with nothing else, in every mode. The console does not decide it locally
  when the server cannot be reached; the switch stays locked.
- **Document headers.** nginx sets a content security policy and the other security
  headers on the console document, and the proxied locations pass the backend's headers
  through, so each header arrives once.
- **Posture.** The schema default that marked every node compliant and disk-encrypted is
  gone (migration `012`). The node reports the checks it measured and leaves the others
  null. The console shows `verified_compliant`, `unverified` or `non_compliant`; a node
  whose required checks are unknown is `unverified`.

---

## 6. Readiness for regulated buyers

The target is banks and public administration
([ADR 0006](adr/0006-target-market-banks-and-public-administration.md)). This section is
the distance to that.

### 6.1 NeroNuke does not destroy data

`executeInstantUserDestruction` scrambles the password hash and email, then issues
`DELETE` across the user's tables. That removes rows. It does not remove data.

After a `DELETE`, the rows remain in:

- the PostgreSQL write-ahead log, until it rotates
- every base backup and every WAL archive
- unvacuumed heap pages
- streaming replicas, until they apply and vacuum

The designed answer is per-organisation encryption keys, with destruction meaning key
destruction. It is not implemented. Organisation-wide destruction
requires two people and respects a legal hold. The tiers that act without an
administrator (the personal switch) are available in the default profile and switched off
in the `regulated` one (ADR 0015).

Crypto-shredding has a trap worth stating: wrapping a symmetric organisation key
(already post-quantum safe) with X25519 or RSA makes it post-quantum vulnerable.
Whoever captures the backup today opens it later, and the shredding achieved nothing.
Derive the wrapping key from a passphrase with Argon2id, or use hybrid
X25519 + ML-KEM-1024.

The personal dead man's switch unlock accepts the credential the user stored, and no
other. The global wipe requires an explicit confirmation.

### 6.2 The audit log is not tamper-evident

`audit_events` is an ordinary table. There is no hash chain, no signature and no
append-only constraint. Anyone with database access can edit or delete entries,
including the entries that record it.

Regulated buyers require an audit trail that survives an attacker with database access.
Minimum: each row carries the hash of its predecessor, the chain head is signed
periodically, and the signature is published somewhere the database cannot reach. The
warrant canary already has the signing machinery.

### 6.3 Remaining gaps

| Requirement | State |
|---|---|
| Data plane | A spike behind a flag; not the default ([ADR 0020](adr/0020-data-plane.md)) |
| Per-node credentials, proof of key possession | Not implemented. One enrolment token serves the fleet |
| Posture measurement on the node | Not implemented. Disk encryption and firewall state are not measured, so every node is `unverified` |
| External cryptographic audit | None. A nonce reuse defect was found in-house in the onion layer in September 2026 |
| Reproducible builds, signed artefacts, SBOM | Not implemented |
| SSO / OIDC | Not implemented. Blocks any organisational deployment |
| Role model with an auditor role | Not implemented. Two roles exist |
| Written threat model | None |
| Key rotation procedure | None |
| High availability | Designed ([ADR 0001](adr/0001-no-multi-master-postgresql.md)), not built |
| Backup and restore procedure | None documented or tested |
| Penetration test | None |
| Accessibility check (WCAG 2.1 AA) | None automated. Console is English only |
| Mobile clients | None |

### 6.4 What is in place

- No secret in any committed file. A test checks the tree, and `gitleaks` scans the full
  history in CI. In production the backend refuses to start on a missing secret or on a
  value that has ever been committed.
- Backend container unprivileged: uid 10001, read-only root filesystem, all
  capabilities dropped, `no-new-privileges`.
- Rate limits shared across instances through Valkey on sign-in, registration, node
  enrolment, the personal dead man's switch unlock (per account) and the custom-domain
  gateway (per domain and per address).
- Security headers. nginx gives the console document a content security policy with
  `frame-ancestors 'none'`. The API sets its own headers, and sends HSTS when
  `NODE_ENV=production`. The nginx edge of the compose stack does not send HSTS, because
  it serves plain HTTP.
- Tenant isolation enforced centrally and probed by a test that enumerates
  node-addressed routes as the wrong tenant.
- JWT revocation with `jti` and a shared blacklist.
- Federation requires signature verification and out-of-band fingerprint confirmation.
- The node heartbeat requires the enrolment token, like the other five node endpoints.
- Posture stored as measured; unknown stays unknown (section 5.9).
- A test asserts that Go's default TLS configuration negotiates the hybrid
  `X25519MLKEM768` group, and fails if a change turns it off. No component of the
  compose stack terminates TLS yet.

---

## 7. Data model

19 tables in 12 migrations. Core entities:

- `users`: identity and role (`super-admin` or `user`). The tier and quota columns were
  dropped by migration `011`.
- `nodes`: mesh members, overlay addresses, telemetry, posture, risk.
- `acl_rules`, `mesh_epochs`, `network_routes`, `revoked_keys`: policy, routes and
  revocation as delivered to nodes.
- `peering_agreements`: cross-mesh federation.
- `dead_man_switch`: NeroNuke timers.
- `warrant_canaries`: signed statements.
- `audit_events`: security events (see section 6.2).
- `node_telemetry_history`: position history for impossible-travel detection.
- `geofencing_policies`, `system_metrics`, `refresh_tokens`.
- `cloud_pcs`, `custom_domains`: Cloud PC, frozen.
- `app_bundles`, `app_share_links`, `nerodrop_sessions`: tables of deleted features,
  still present in the PostgreSQL schema until the database consolidation
  ([ADR 0009](adr/0009-postgresql-only.md)).

Two schemas are maintained by hand: SQLite DDL in `db/migrator.js`, PostgreSQL in
`db/migrations/*.sql`. `tests/schema_parity.test.js` compares them. The decision is to
keep PostgreSQL only ([ADR 0009](adr/0009-postgresql-only.md)); until that lands the
backend suite runs on SQLite.

Migrations of note: `004` and `005` remove PostGIS and align column names; `006` adds the
VIP sequence; `007` to `009` add ACL rules, routes and revoked keys; `010` sets the
`nodes` fill factor; `011` removes tiering; `012` removes the fabricated posture default.

---

## 8. Running it

### 8.1 Local

```bash
sh scripts/dev/gen-env.sh        # writes .env with fresh secrets, never overwrites
sh scripts/dev/stack.sh up       # postgres, valkey, backend, console
sh scripts/dev/stack.sh nodes    # two DERP relays and six Go nodes
sh scripts/dev/stack.sh status   # health, and nodes with a heartbeat under 60 s
```

The API refuses to start without those secrets. That is intentional. On Windows, run the
scripts from Git Bash. The console is on `http://127.0.0.1:8443`.

A second stack on the same host needs its own project name and ports:
`COMPOSE_PROJECT_NAME=other NERONET_PORT_OFFSET=100 sh scripts/dev/stack.sh up`.
PostgreSQL and Valkey are not published unless `NERONET_DEBUG_PORTS=1` is set.
Details: `DEVELOPER_SETUP.md` sections 3 and 5.

To run a node outside the stack against it:

```bash
set -a && . ./.env && set +a
go run ./cmd/sovereign-node -control-url http://127.0.0.1:8443 -country IT
```

The identity key is written to `SOVEREIGN_NODE_KEY_PATH`, which defaults to
`/var/lib/neronet/node_identity.key`; set it to a writable path when running outside a
container. To try the data plane spike, see `scripts/dev/dataplane-spike-lab.sh` and
[ADR 0020](adr/0020-data-plane.md).

### 8.2 Configuration that matters

| Variable | Effect if wrong |
|---|---|
| `SOVEREIGN_TRUST_PROXY_HOPS` | Too low: every request reports the proxy address, so rate limiting buckets the whole world together. Too high: a client forges `X-Forwarded-For` and bypasses the limiter |
| `SOVEREIGN_REGISTRATION_TOKEN` | Unset in production: no node can enrol, and no node endpoint answers. Every node needs the same value |
| `SOVEREIGN_VALKEY_NAMESPACE` | Unset with a shared Valkey: deployments cross-talk. `{pid}` is substituted |
| `SOVEREIGN_DATA_DIR` | Wrong: the federation identity lands outside the volume and is destroyed on container recreation |
| `SOVEREIGN_FEATURE_CLOUD_PC` | Off by default. Turning it on exposes a feature that cannot stream and is not supported |
| `PGSSL_INSECURE` | Refused in production |

### 8.3 Known operational traps

- The PostgreSQL password is written into the volume at first initialisation. Changing
  the environment variable does not rotate it; use `ALTER USER`.
- Migrating from a root container to the unprivileged image leaves volume files owned by
  root. Once: `docker run --rm -v <volume>:/data alpine chown -R 10001:10001 /data`
- `charts/`, `k8s/` and `terraform/` have never been applied to a real cluster or cloud
  account.

---

## 9. Testing

Counts on `main` on 2026-09-20:

| Suite | Count | Command |
|---|---:|---|
| Backend | 352 | `sh scripts/dev/test-backend.sh` (`npm --prefix console/backend test`) |
| Frontend | 19 | `sh scripts/dev/test-frontend.sh` (`npm --prefix console/frontend test`) |
| Go | 14 packages with tests in the root module, and 1 in `cmd/sovereign-security-daemon` (own module); all with `-race` | `sh scripts/dev/test-go.sh` |

CI (`.github/workflows/ci.yml`) runs the Go suite, the backend suite three times, the
frontend build and tests, the compose stack with six nodes and a smoke check, linters,
the legacy tool tests, and the image builds. `security-scan.yml` runs secret scanning,
CodeQL and dependency audits.

### 9.1 Test rules

**Tests execute the system; they do not read its source.** An earlier suite reported 140
passing tests and an independent "victory confirmed" verdict while missing nonce reuse, a
data race, an authentication bypass and a federation endpoint accepting forged tokens.
The cause was assertions of the form
`assert(ddl.includes('CREATE INDEX ... USING GIST'))`, which pass with PostgreSQL never
started. Test suites that did not execute the product have been removed.

**Reproduce the defect before fixing it.** Every fix starts from a check that fails
against current code.

**Never swallow an error before an irreversible step.** Migration 004 caught a failed
coordinate copy with a log notice and dropped the column anyway: 46 coordinates
destroyed.

### 9.2 Flakiness

The backend suite failed intermittently until 2026-09-13. Every test process shared one
Valkey namespace, so a topology event published by one file reached a subscriber in
another. Namespaces are now per process (`test-{pid}`). Flaky tests are worse than
failing ones: they train everyone to re-run until green. CI runs the backend suite
three times in one job for that reason.

---

## 10. What to do next, in order

The order follows the decisions in [`docs/adr/`](adr/) and the roadmap.

### 10.1 A data plane that the fleet uses

The spike (`pkg/dataplane`) proves the transport. What remains: the control plane
delivers a versioned netmap per node instead of a local file, enforcement is on by
default with the organisation's `default_policy`, connectivity beyond direct endpoints
(STUN, DERP through a `conn.Bind`), and then the onion layer above the tunnel using the
path `/v4/control/circuit` already selects. The open questions are in
[ADR 0020](adr/0020-data-plane.md).

### 10.2 Federation revocation

Revoked keys travel in the heartbeat response for a retention window (24 hours by
default), and a node that receives a new one re-syncs its policy. Revoking a peering
agreement and destroying a user both put keys in the window. Three cases remain open:

1. The owner withdraws one shared device. The peer's sessions must close and the route
   be withdrawn. With no data plane in use there is no tunnel to close yet.
2. The peer wipes its devices or triggers NeroNuke. The local side must detect this and
   tear down, which needs a peer liveness check.
3. An agreement expires. No job expires an agreement or revokes its imported nodes when
   it lapses.

### 10.3 Crypto-shredding

Section 6.1. This is what makes NeroNuke mean what it claims.

### 10.4 Tamper-evident audit log

Section 6.2. A prerequisite for any regulated buyer.

### 10.5 Then

Per-node credentials with proof of key possession; posture measurement on the node;
removal of the Go control plane server ([ADR 0007](adr/0007-remove-go-control-plane-server.md));
PostgreSQL only ([ADR 0009](adr/0009-postgresql-only.md)); Rosenpass for the tunnel;
OIDC; high availability ([`ROADMAP.md`](ROADMAP.md) section 1).

---

## 11. Reading order for a new engineer

1. This document.
2. [`docs/adr/`](adr/): the decisions, starting with 0006 (market), 0008 and 0020 (data
   plane) and 0007 (control plane).
3. [`docs/ROADMAP.md`](ROADMAP.md): high availability, measured load ceilings,
   federation, competitor parity, code rules.
4. [`pkg/control/README.md`](../pkg/control/README.md): why half that package is not
   deployed.
5. `pkg/routing/onion.go`: the circuit layer, and `onion_regression_test.go` beside it,
   which documents four defects by reproducing them.
6. `console/backend/routes/goBridge.js`: the control plane that actually runs.
7. `pkg/dataplane` and `cmd/sovereign-node/main.go`: what a node does.
8. `console/backend/services/NukeEngine.js`: destruction and the dead man's switches.
