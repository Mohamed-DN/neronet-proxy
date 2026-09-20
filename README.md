# NeroNet

NeroNet is an overlay mesh VPN with a web management console. It has two halves: Go
nodes (`cmd/sovereign-node`, `pkg/*`) and a Node.js control plane with a React console
(`console/backend`, `console/frontend`), backed by PostgreSQL 16 and Valkey 7. The
target users are banks and public administration
([ADR 0006](docs/adr/0006-target-market-banks-and-public-administration.md)). The
licence is AGPL-3.0.

The project is not finished. Read the next section before deciding what to build on.

## Current state

Running today:

- **Control plane.** Nodes enrol, receive an overlay address from `100.64.0.0/10`, send a
  heartbeat every 15 seconds, and receive ACL and subnet-route updates by epoch. The
  console shows the values the nodes report.
- **Node proxy.** A node runs a local SOCKS5 and HTTP CONNECT proxy. The proxy dials the
  destination directly from the node, after resolving the name over DNS-over-HTTPS and
  refusing private address ranges and a list of abuse ports.
- **Exit bridge discovery and circuit path selection.** The control plane ranks exit
  bridges by country and selects a three-hop path with a report of how independent the
  hops are. `sovereign-cli peers` and `sovereign-cli circuit` show both.
- **DERP relay and STUN server** (`cmd/sovereign-derp-relay`). The compose stack starts
  two. No node connects to them.

There is no data plane in the default configuration. Traffic from a node's proxy does
not enter a tunnel. The overlay address the control plane assigns is not configured on
any interface, and the ACL policy a node downloads is not applied to any traffic.

A spike of the data plane exists: `pkg/dataplane` runs WireGuard through `wireguard-go`
in a userspace or kernel mode, applies the ACL filter to the packets, and lets the node's
proxies dial overlay addresses through it. It starts only when the node is run with
`-dataplane netstack` or `-dataplane tun`. It is off by default, the compose stack does
not enable it, and it reads its peers from a local file, not from the control plane. The
design and the measurements are in [ADR 0020](docs/adr/0020-data-plane.md).

Implemented and tested, but not used by any running node:

- Onion cell sealing and peeling (`pkg/routing`).
- The Noise handshake, session ratchet, replay window and binary wire framing in
  `pkg/crypto`. WireGuard replaces this transport
  ([ADR 0008](docs/adr/0008-wireguard-data-plane-transport.md)).
- NAT traversal: STUN, ICE candidates, hole punching (`pkg/nat`). Only `sovereign-cli
  stun-ping` calls it. It has not been run against real NATs.
- The DERP client and framing (`pkg/derp`).
- The active-defence daemon (`cmd/sovereign-security-daemon`). It is a separate Go
  module. The compose stack does not run it.

Not implemented: kernel packet acceleration (an earlier simulation was removed), a
post-quantum handshake, per-node credentials with proof of key possession, single
sign-on, tamper-evident audit, cryptographic erasure, mobile clients, and any release
signing. `docs/HANDBOOK.md` states the state of each part with more detail.

## Quickstart

The stack and the tests run in containers, with Podman or Docker. On Windows, run the
scripts from Git Bash.

```sh
git clone https://github.com/Mohamed-DN/neronet-proxy.git
cd neronet-proxy

sh scripts/dev/gen-env.sh        # writes .env with fresh random secrets; never overwrites
sh scripts/dev/stack.sh up       # postgres, valkey, backend, console on http://127.0.0.1:8443
sh scripts/dev/stack.sh nodes    # two DERP relays and six Go nodes
sh scripts/dev/stack.sh status   # health, and nodes with a heartbeat in the last 60 s
```

Sign in to the console as `admin` with the password `SOVEREIGN_ADMIN_PASS` from `.env`.

The backend runs with `NODE_ENV=production` and refuses to start without the secrets
that `gen-env.sh` writes, and refuses any value that has appeared in a committed file.
Several stacks can run side by side; see [DEVELOPER_SETUP.md](DEVELOPER_SETUP.md),
sections 3 and 5.

To try the command line tool against the running stack (needs Go on the host):

```sh
set -a && . ./.env && set +a
go run ./cmd/sovereign-cli peers DE --control-url http://127.0.0.1:8443
go run ./cmd/sovereign-cli circuit US --control-url http://127.0.0.1:8443
```

## Command line tool

| Command | What it does |
|---|---|
| `status` | Counts the exit bridges the control plane lists. |
| `peers [COUNTRY]` | Lists exit bridges, filtered by country, with their score. |
| `circuit [COUNTRY]` | Asks the control plane for a three-hop path and prints it. No circuit is established. |
| `keygen` | Generates a Curve25519 keypair and a node id. |
| `stun-ping <host:port>` | Sends a STUN binding request and prints the mapped address and round trip. |

## Repository layout

| Path | Content |
|---|---|
| `cmd/sovereign-node` | The node: proxies, enrolment, heartbeat, ACL and route sync, optional data plane |
| `cmd/sovereign-cli` | The command line tool above |
| `cmd/sovereign-derp-relay` | DERP relay with a STUN server |
| `cmd/sovereign-control-plane` | The Go control plane. Not the control plane to run; scheduled for removal ([ADR 0007](docs/adr/0007-remove-go-control-plane-server.md)) |
| `cmd/sovereign-security-daemon` | Active-defence daemon (separate module, not deployed) |
| `pkg/` | Go packages; see the handbook, section 2.2 |
| `console/backend` | The control plane: REST API, WebSocket, `/v4/control` for nodes |
| `console/frontend` | The React console and its nginx |
| `docker-compose.yml`, `scripts/dev` | The development stack and the test scripts |
| `docs/` | Handbook, roadmap, decision records (`docs/adr`), archive |
| `charts/`, `k8s/`, `terraform/` | Deployment manifests. They have never been applied to a real cluster or account ([ADR 0012](docs/adr/0012-deployment-target-vm-first.md)) |

## Tests

```sh
sh scripts/dev/test-go.sh        # gofmt, go vet, go test -race
sh scripts/dev/test-backend.sh   # backend suite against a throw-away Valkey
sh scripts/dev/test-frontend.sh  # production build and unit tests
```

CI runs the same suites, the compose stack with six nodes, linters, image builds,
secret scanning, CodeQL and dependency audits (`.github/workflows/ci.yml`,
`security-scan.yml`).

## Security status

In place, and checked by tests or by the CI jobs:

- No secret in any committed file. The backend refuses to start in production on a
  missing secret or on a value that has ever been committed. `gitleaks` scans the full
  history in CI.
- The backend container runs as an unprivileged user with a read-only root filesystem,
  no Linux capabilities and `no-new-privileges`.
- Rate limits, shared across instances through Valkey, on sign-in, registration, node
  enrolment, and the endpoints that verify a secret.
- Security headers: a content security policy for the console document from nginx,
  and the API's own headers. The API sends HSTS in production. The edge nginx of the
  compose stack serves plain HTTP; TLS is not configured there.
- Tenant isolation through one ownership middleware, with a test that probes every
  node-addressed route as the wrong tenant.
- Federation requires a verified Ed25519 signature and a key fingerprint confirmed by the
  operator through another channel.
- Nodes authenticate to the control plane with a shared enrolment token. Registration
  does not overwrite the role, IP class or country of an existing node.
- Node posture is stored as measured: a check the node did not measure is unknown, and a
  node whose required checks are unknown is shown as unverified.

Known gaps:

- The shared enrolment token is one credential for the whole fleet. Per-node credentials
  and proof of key possession are not implemented.
- The node does not measure disk encryption or firewall state, so every node is
  unverified.
- `pkg/crypto` and `pkg/routing` have had no external review. A nonce-reuse defect was
  found and fixed in the onion layer in September 2026.
- The tunnel and the per-hop onion key exchange are classical X25519. The Go control
  plane client offers the hybrid X25519MLKEM768 group by default and a test checks that;
  the compose stack does not serve the control plane over TLS.
- NeroNuke removes rows and does not provide cryptographic erasure.
- The audit log is an ordinary table with no tamper evidence.
- Cloud PC is switched off by default (`SOVEREIGN_FEATURE_CLOUD_PC`) and cannot stream.
  NeroDrop and App Bundles were removed.

## Documentation

- [Engineering handbook](docs/HANDBOOK.md): what the system is and does, verified against
  the code. Start here.
- [Roadmap](docs/ROADMAP.md): measured load ceilings, high availability, federation,
  competitor parity, post-quantum status, code rules.
- [Decision records](docs/adr/): each architectural decision, with its context and
  consequences.
- [Developer setup](DEVELOPER_SETUP.md): environments, compose stack, tests, configuration.
- [Auto-scaling design](docs/AUTOSCALING.md): a design that has not been applied.
- [High availability design](docs/HA_ARCHITECTURE.md) and
  [console architecture](docs/CONSOLE_ARCHITECTURE.md): design documents; the handbook is
  authoritative where they differ.
- [Private-cloud design study](BUSINESS_AND_ROADMAP.md): not implemented.
- [Environment template](.env.example).
- [Contributing](CONTRIBUTING.md).
- [Archive](docs/archive/): plans and reports of earlier phases, not maintained.

## Licence

AGPL-3.0. See [LICENSE](LICENSE).
