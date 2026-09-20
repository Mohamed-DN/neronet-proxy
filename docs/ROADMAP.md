# NeroNet engineering roadmap

Working document. Figures are measured against a running deployment; the methods are
reproducible from the commands in each section.

Last updated 2026-09-20. Decisions taken since are recorded in [`docs/adr/`](adr/).

---

## 1. High availability

This section comes first because the constraint shapes everything else.

### 1.1 Architecture decision: no multi-master PostgreSQL

Recorded as [ADR 0001](adr/0001-no-multi-master-postgresql.md).

Multi-master replication (BDR, Bucardo, bidirectional streaming) does not remove
split-brain. It converts it into write conflict resolution, and for network state
those conflicts have no correct answer:

- Two control planes assign the same overlay address to different nodes.
- A node is quarantined on one side and cleared on the other.

The decision is: **stateless control-plane instances over a single
consensus-backed source of truth.**

```
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ control  │  │ control  │  │ control  │   no local state
        │ plane 1  │  │ plane 2  │  │ plane 3  │   all active
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             └─────────────┼─────────────┘
                           │
                  ┌────────┴────────┐
                  │  PostgreSQL     │  exactly one primary,
                  │  primary        │  decided by quorum
                  └────────┬────────┘
                           │ synchronous replication
                  ┌────────┴────────┐
                  │  standby ×2     │
                  └─────────────────┘
                           │
              ┌────────────┴────────────┐
              │  etcd ×3 (or ×5)        │  quorum and leader key
              └─────────────────────────┘
```

Every control-plane instance is equal and active. None holds state in memory, so any
instance can serve any request. That is the property worth having — not database
multi-master.

### 1.2 Rules

1. **Odd number of voters.** Three tolerates one loss, five tolerates two. Four gains
   nothing over three and adds failure surface.

2. **Quorum lives outside the database.** etcd is a Raft cluster. The leader key has a
   TTL, and a primary that cannot renew it demotes itself without needing to reach
   anyone else.

3. **Fencing, not just demotion.** Patroni demotes a primary that loses the leader
   key, but a stalled process may never execute the demotion. A watchdog
   (`/dev/watchdog`) must reset the machine if Patroni stops responding.

4. **Never two sites alone.** Two data centres cannot form a quorum that survives
   losing one: the survivor holds 50%, not a majority. A third voter elsewhere is
   required. It can be a minimal VPS that does nothing but vote.

### 1.3 State that must leave process memory

| State | Current location | Target | Status |
|---|---|---|---|
| VIP allocator (Node) | database sequence | database sequence | done — `71cb108` |
| VIP allocator (Go) | in-memory map | removed with the Go server ([ADR 0007](adr/0007-remove-go-control-plane-server.md)) | open |
| Node registry (Go) | in-memory map + mutex | removed with the Go server | open |
| Token blacklist | Valkey | Valkey | done |
| Rate limit counters | Valkey | Valkey | done — `71cb108` |
| Heartbeat state | Valkey, flushed in batches | Valkey | done |
| Topology broadcast | Valkey pub/sub | Valkey pub/sub | done |

### 1.4 Verification

Each scenario must be executed and recorded. An untested runbook is documentation,
not resilience.

- Kill the primary: automatic promotion, no acknowledged write lost.
- Partition the network (`iptables DROP`): the isolated primary must stop accepting
  writes before another is promoted.
- Freeze the primary (`SIGSTOP`): the watchdog must fire.
- Lose one voter of three: the cluster continues. Lose two: it stops, which is
  correct.

---

## 2. Two control plane implementations

`pkg/control` contains a Go control plane — 1,021 lines across `server.go`,
`registry.go` and `vip.go`, plus `cmd/sovereign-control-plane`. No compose file
starts it.

What serves `/v4/control/register` and `/v4/control/heartbeat` is
`console/backend/routes/goBridge.js`, reached through nginx. Go nodes point at
`http://frontend:8443`; nginx proxies `/v4/` to `backend:8081`.

The Go server half has no persistence, no authentication and no tenancy. The client
and the protocol structs in the same package **are** used, by `cmd/sovereign-node`
and `cmd/sovereign-cli`, and the struct tags define the wire contract.

Decision: remove the server half and keep the package as protocol definition and
client; the contract becomes a JSON Schema generated from the Go structs
([ADR 0007](adr/0007-remove-go-control-plane-server.md)). The removal is not done. Until
it is, changes to the server half are changes to unused code. See
`pkg/control/README.md`.

---

## 3. Measured load ceilings

### 3.1 VIP allocation — resolved

Allocation read the whole nodes table and scanned offsets in JavaScript.

| Fleet | Before | After |
|---|---|---|
| 1,000 | 0.8 ms | 0.054 ms |
| 10,000 | 6.7 ms | 0.023 ms |
| 100,000 | 71 ms | 0.024 ms |

The old path was linear in fleet size and blocking on a single-threaded runtime: 71 ms
per registration meant roughly 14 registrations per second, with the whole API stalled
during each. It was also racy — two concurrent callers read the same used set and
picked the same address, against two UNIQUE columns.

Now a database counter plus one indexed probe. Constant time.

### 3.2 List endpoints — resolved

A node row serialises to 805 bytes. Unbounded `SELECT *` meant 77 MB per dashboard
request at 100,000 nodes. Pages are now capped at 500 with `total` and `has_more`.

### 3.3 Heartbeat write volume — resolved

Every node writes every 15 seconds. At 100,000 nodes that is 6,667 UPDATEs per second
through a pool of 20 connections, against a table with 11 indexes, each creating a row
version for autovacuum to reclaim.

Heartbeats now land in Valkey and flush in batches every 30 seconds — roughly 100
database writes per second for the same fleet. List endpoints merge the buffered
values over stored rows, so reads stay current.

Trade-off: up to one flush interval of telemetry is lost if Valkey goes down. Counters
and a last-seen timestamp can absorb that. Registration and quarantine remain direct
writes.

### 3.4 Fill factor — resolved

No column the heartbeat updates is indexed, so PostgreSQL can use HOT updates and skip
index maintenance, but only with free space in the page, and the default fillfactor is
100. Migration `010` sets the `nodes` fillfactor to 70.

---

## 4. Federation

`peering_agreements` and `PeeringEngine` implement cross-mesh peering.

### 4.1 Trust model

Signature verification alone is not the boundary. The token carries the initiator's
own public key, so a valid signature proves only that the sender holds a key they
chose. Acceptance therefore requires the operator to supply the key fingerprint,
obtained through a separate channel. A first attempt returns 428 with the fingerprint
to confirm.

The mesh identity is persisted at `$SOVEREIGN_DATA_DIR/peering_identity.pem`, mode
0600, on a named volume.

### 4.2 Sharing scopes

| Scope | Schema | Enforcement |
|---|---|---|
| Whole network (`scope_mode: ALL`) | present | not implemented |
| Specific subnets | present | not implemented |
| Individual devices (`shared_device_ids`) | present | not implemented |
| Shared exit nodes | missing | missing |

`acceptPeeringAgreement` fabricates two peered nodes with fixed addresses instead of
importing the peer's real ones. A node exchange protocol between control planes is
required.

### 4.3 Exit nodes offered to third parties

Operator diversity is the one property a single owner cannot provide for themselves.
A fleet of a thousand machines across many networks has full network diversity and
none of operator diversity: strong against an ISP or a destination, weak against
anyone able to compel that operator. Third-party exit nodes are the only source of
the missing property, which makes them a security feature rather than a capacity one.

Three things need designing before offering them:

- **Abuse handling.** Whoever runs an exit node receives the complaints for traffic
  leaving through it. This is the daily reality of Tor exit operators and the reason
  most people will not run one. An operator must be able to choose what exits through
  their node — port and destination policy — and that choice must be enforced at the
  exit rather than requested politely.
- **Per-exit rate limits**, so one node cannot be used to saturate another's link.
- **Accountability without deanonymisation.** An exit operator needs enough to answer
  a complaint without being able to identify the originating user, which is the same
  constraint Tor operates under.

### 4.4 Revocation — required, not implemented

The network owner must be able to withdraw a device they shared. Three cases, none of
which currently drop anything:

1. **Owner revokes one shared device.** The peer's sessions to that device must close,
   and its route must be withdrawn from the peer's mesh. Removing the row is not
   enough — an established tunnel survives it.
2. **Peer deletes their own devices, or triggers NeroNuke.** Their side of the
   agreement disappears. The local side must detect this and tear down, rather than
   holding routes to devices that no longer exist.
3. **Agreement expires or is revoked entirely.** All imported nodes, routes and
   sessions go.

This needs, in order:

- Revocation propagated to data-plane nodes, not only recorded in the database. The
  control plane returns `revoked_keys` in `HeartbeatResponse` for a retention window
  (24 hours by default), and a node that receives a new key re-syncs its policy. Revoking
  an agreement and destroying a user put keys in the window. Withdrawing one shared
  device does not yet. Without a data plane in use there is no tunnel to close.
- A peer liveness check, so a peer that stops responding is treated as gone after a
  defined interval rather than indefinitely.
- Cascade from NeroNuke into peering agreements: a wipe on either side must revoke
  outward.

---

## 5. Application layer

| Feature | Claimed | Actual |
|---|---|---|
| NeroDrop | P2P encrypted transfer, 64 KB chunks, BLAKE3 | `routes/nerodrop.js:68` emits a fabricated SDP string. No `RTCPeerConnection` in the frontend. |
| Cloud PC | Selkies WebRTC streaming, multi-monitor, USB/IP | Rows pointing at `wss://signal.internal.darknero.com`, a host that does not exist. |
| App Bundles | Provisioning for Nextcloud, Immich, Seafile, Guacamole | CRUD on `app_bundles`. No container orchestration. |

Interface without implementation. The console presents all three as active.

A fourth belongs on that list, and it is the one the product is named for. Onion
routing is implemented in `pkg/routing` — per-hop ephemeral keys, XChaCha20 with a
random nonce per layer, fixed 1420-byte cells, bounds-checked peeling — and covered
by tests including a regression suite. Nothing runs it. The package is imported by
`pkg/control`, the Go control plane no compose file deploys, and by its own tests;
`cmd/sovereign-node` does not import it. The console's per-device toggle writes
`onion_routing_enabled` and `onion_hops` to the control plane, and `HeartbeatResponse`
carries no onion field, so no node is told and no node would act on it.

Closing this is three pieces: carry the setting on the heartbeat the way revoked keys
are carried, have the node build a circuit through `/v4/control/circuit`, which is
implemented and answering, and put the data path through it. The first two are small.
The third is the product.

**Decision: NeroDrop is deferred.** File transfer over a mesh is a solved problem
(Syncthing, Magic Wormhole, or scp over the overlay). It does not differentiate.
Effort belongs in NeroNuke, the warrant canary and onion routing, where nothing
comparable exists.

NeroDrop is deleted (D8, [ADR 0003](adr/0003-remove-nerodrop.md)). Its routes were never ported off SQLite, so on a PostgreSQL
deployment, the production configuration, the page answered 500 and the client
substituted fixture transfers, presenting a history of transfers that had never
occurred. The component, the routes, the client methods and the fixtures are removed;
the `nerodrop_sessions` table is dropped in WP-104.

App Bundles is deleted (D8, [ADR 0014](adr/0014-confirm-earlier-decisions.md)). `routes/apps.js` was SQLite-only and `api.apps` in the
frontend had no callers. It claimed more than it did: `POST /apps/:id/start` set
`status = 'running'` in a table and started no container, then answered success. The
routes, the client methods, the fixtures and the seeded rows are removed; the
`app_bundles` and `app_share_links` tables are dropped in WP-104. The menu entry
labelled "Sovereign Cloud PC" rendered `components/AppBundles.jsx`, which despite its
filename calls `/cloud-pc`; that component is Cloud PC and is handled separately.

Cloud PC is frozen (D4, [ADR 0010](adr/0010-freeze-cloud-pc.md)). Its instances still point at `wss://signal.internal.
darknero.com`, which does not resolve, so streaming cannot connect: the listing and
the custom-domain management are real, the session is not. The code stays behind the
server-side flag `SOVEREIGN_FEATURE_CLOUD_PC`, off by default. With the flag off every
`/api/cloud-pc` path answers 404, including the public custom-domain gateway, and the
console hides the menu entry because `/api/features` reports it off. The component is
`components/CloudPc.jsx`.

---

## 6. Messaging

**Decision: no message broker for now** ([ADR 0002](adr/0002-no-message-broker.md)).

Valkey pub/sub covers topology events. A broker would add durable queues and retries,
which nothing currently needs. The cost is a second consensus system to keep from
partitioning, which conflicts directly with the high-availability design in section 1.

When durable messaging is required — container orchestration is the likely trigger —
the choice is NATS JetStream: a single Go binary with Raft-based clustering that
composes with the etcd quorum, rather than RabbitMQ's Erlang runtime and its own
partition handling.

---

## 7. Competitor feature parity

All referenced projects are open source. Study their solutions, reimplement within
this model, respect their licences.

| Feature | Reference | Effort | Benefit | Decision |
|---|---|---|---|---|
| SSO / OIDC | NetBird, Headscale | medium | Unblocks organisational adoption | Take |
| Rosenpass for tunnel PQ | NetBird | low | Post-quantum without writing crypto | Take |
| DERP-style relay fallback | Tailscale | medium | Connectivity where P2P fails | Take — partial in `pkg/derp` |
| Internal DNS | Tailscale | medium | Names over addresses | Take |
| Declarative ACL language | Tailscale (HuJSON) | medium | Reviewable, version-controlled policy | Take, adapt |
| Certificate identity | Nebula | low | Simpler model to audit | Study |
| Kernel WireGuard | Netmaker | high | Near-native throughput | See 7.1 |
| Mobile client | NetBird, Tailscale | very high | Covers half of real devices | Take — one platform |
| Posture checks | NetBird, Tailscale | low | Already in `pkg/posture` | Complete |

### 7.1 Transport: WireGuard or the in-house Noise stack

A nonce reuse defect was found in the onion layer on 2026-09-12 that removed both
confidentiality and integrity. The Noise implementation in `pkg/crypto` is correct.
Same codebase, same week, opposite outcomes.

**Decision: WireGuard as transport, Rosenpass for post-quantum**
([ADR 0008](adr/0008-wireguard-data-plane-transport.md); design and measurements in
[ADR 0020](adr/0020-data-plane.md)). Gains:
existing formal audits, kernel performance, and the ability to state that the
transport is WireGuard rather than asking for trust in an unaudited implementation.

Onion routing is not expressible in plain WireGuard and remains a layer above. That is
where the differentiation is, and where external audit effort belongs.

---

## 8. Post-quantum status

| Layer | Status | Next |
|---|---|---|
| Node to control plane TLS | Go's defaults negotiate hybrid X25519MLKEM768 (`949e441`) and a test guards it. The compose stack serves the control plane over plain HTTP, so no node negotiates it yet | TLS at the edge |
| nginx edge | `ssl_ecdh_curve` set | Requires OpenSSL 3.5+ |
| Data at rest | ChaCha20-Poly1305 / AES-256 | None. Grover halves 256 to 128 effective bits |
| Tunnel KEX | X25519 only | Rosenpass via PSK |
| Per-hop onion KEX | X25519 only | Hybrid, after external audit |
| Tenant key wrapping | not designed | Argon2id-derived KEK, no public key |
| Client-side E2EE | not designed | PQXDH structure |
| JWT / node signatures | Ed25519 | Low priority — a 2040 forgery does not break a 2026 session |
| Internal CA signatures | Ed25519 | Medium-high — keys live 10+ years |

**Hybrid only, never pure PQ.** ML-KEM is young. Concatenating the classical and
post-quantum secrets in the HKDF keeps the session protected if either holds. Chrome,
Cloudflare, OpenSSH and Go all do this.

Crypto-shredding trap: wrapping a symmetric tenant key (already PQ-safe) with X25519
or RSA makes it PQ-vulnerable. Whoever captures the backup today opens it later and
the shredding achieved nothing.

---

## 9. Removing monetisation

Decision: no paid features, no tiers, no quotas
([ADR 0004](adr/0004-remove-monetisation.md)). Done: the columns, the quota checks and the
frontend components are removed (migration `011_remove_tiering`), and so are the business
chapters of `BUSINESS_AND_ROADMAP.md`. What was removed:

- `users.tier` and the values `cloud_managed`, `managed_cloud`, `hybrid_byos`,
  `free_core`.
- `bandwidth_quota_gb`, `max_nodes`, and the quota checks in `routes/nodes.js`.
- `app_bundles.tier`.
- `BUSINESS_AND_ROADMAP.md` chapter 6 (subscription matrix, unit economics, Stripe
  and BTCPay, billing lifecycle) and § 5.5 (Ed25519 licensing).
- Frontend components displaying tier and quota.

Keep:

- `users.role`. Authorisation is not monetisation.
- Technical limits: rate limiting, page size, VIP pool. Infrastructure protection, not
  commercial gating.

The migration was written after every code reference was removed, not before.

---

## 10. Phases

| Phase | Duration | Content | Status |
|---|---|---|---|
| 0 | 2–3 weeks | Rate limiting, security headers, bounded lists, O(1) VIP allocation | done — `71cb108` |
| 0b | — | Peering signature verification, tenant isolation, unprivileged containers | done — `460eb6f`, `e71296b` |
| 0c | — | The four missing control plane endpoints: discovery, ACL delivery, subnet routes, onion circuits | done — `9a13e20`, `9228211`, `8bc7870`, `0b9315c` |
| 1 | 1–2 months | State out of process, HA with quorum and fencing, one database backend | in progress |
| 2 | 2–3 months | Rosenpass, external audit, reproducible builds, threat model | open |
| 3 | 3–4 months | OIDC, one-command install, one mobile client, internal DNS, federation revocation | open |
| 4 | ongoing | Governance, release cadence, security policy | open |

Monetisation removal and the application-layer decision run in parallel.

---

## 11. Code rules

Three. A formatter settles the rest.

### 11.1 Tests execute the system; they do not read its source

The suite reported 140 passing tests and an independent "victory confirmed" verdict
while missing a nonce reuse defect that removed all cryptographic protection, a data
race, an authentication bypass on every custom domain gateway, and a federation
endpoint that accepted forged tokens.

The cause is assertions of this shape:

```js
assert(ddl.includes('CREATE INDEX ... USING GIST'));
```

That passes with PostgreSQL never started. String assertions over source files are not
evidence of behaviour and are not accepted as such.

### 11.2 Reproduce the defect before fixing it

Every fix starts from a check that fails against the current code. Not "this looks
wrong" — this command produces this wrong output.

### 11.3 Never swallow an error before an irreversible step

A `catch` that does not rethrow, in front of something irreversible, is a defect by
construction. Migration 004 caught a failed coordinate copy with a log notice and then
dropped the column: 46 coordinates destroyed.

### 11.4 CI

- `go test -race` across all packages. It found a real data race on first run.
- `gofmt -l`, failing on any output.
- Backend suite run three times. Flaky tests are worse than failing ones because they
  train everyone to re-run until green.
- The committed-secrets check, which already exists as a test.

---

## 12. Deployment beyond a workstation

The development stack runs on Podman or Docker. The order of deployment targets is in
[ADR 0012](adr/0012-deployment-target-vm-first.md). For bare metal, Proxmox or a VPS:

- Compose runs unchanged on Docker Engine. Review `127.0.0.1` bindings for services
  that must be reachable.
- On Proxmox: one VM for the control plane, one for PostgreSQL, and the third etcd
  voter **outside** the Proxmox cluster. Losing the host otherwise takes quorum and
  data together.
- `charts/`, `k8s/` and `terraform/` exist and have never been applied to a real cluster
  or account. Treat them as untested.
- The PostgreSQL password is written into the volume at first initialisation.
  Changing the environment variable does not rotate it; use `ALTER USER ... PASSWORD`.
- Migrating from a root container to the unprivileged image leaves volume files owned
  by root. Fix once:
  `docker run --rm -v <volume>:/data alpine chown -R 10001:10001 /data`
