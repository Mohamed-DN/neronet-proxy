# Developer guide

How to run the development stack, run the tests, and work on the code. For what the
system is and does, read [the handbook](docs/HANDBOOK.md) first.

---

## Table of Contents
1. [Architecture overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Local development environment](#3-local-development-environment)
4. [Configuration](#4-configuration)
5. [Compose stack reference](#5-compose-stack-reference)
6. [Cloud provisioning](#6-cloud-provisioning)
7. [Kubernetes and Helm](#7-kubernetes-and-helm)
8. [Testing and diagnostics](#8-testing-and-diagnostics)
9. [Hardening notes](#9-hardening-notes)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Architecture overview

```
   Go nodes (cmd/sovereign-node)  ── HTTP, /v4/control/* ──►  nginx (console/frontend)
        │  local SOCKS5 and HTTP proxy                            │  /api, /ws, /v4
        │  dials destinations directly                            ▼
        │                                                    Node.js API (console/backend)
   DERP relays + STUN (cmd/sovereign-derp-relay)                  │             │
   started by the compose stack, used by no node               PostgreSQL     Valkey
```

There is no data plane in the default configuration: nodes do not tunnel to each other.
A spike of one exists behind the node's `-dataplane` flag; see
[ADR 0020](docs/adr/0020-data-plane.md).

### Components

| Component | Path | What it is |
|---|---|---|
| Control plane | `console/backend` | REST API, WebSocket, and `/v4/control` for nodes. Node enrolment, overlay addresses, ACL and route delivery, posture, revocation |
| Console | `console/frontend` | React single-page application, served by nginx, which also proxies `/api` and `/v4` |
| Node | `cmd/sovereign-node` | Enrols, sends heartbeats, syncs ACLs and routes, runs a local SOCKS5 (`127.0.0.1:1080`) and HTTP CONNECT (`127.0.0.1:8080`) proxy |
| DERP relay | `cmd/sovereign-derp-relay` | Relay server and STUN server. Started by the compose stack; no node connects to it |
| Operator CLI | `cmd/sovereign-cli` | `status`, `peers`, `circuit`, `keygen`, `stun-ping` |
| Go control plane | `cmd/sovereign-control-plane` | Not the control plane to run. Scheduled for removal ([ADR 0007](docs/adr/0007-remove-go-control-plane-server.md)) |
| Security daemon | `cmd/sovereign-security-daemon` | Honeypot listener, threat scorer and firewall drivers. Separate Go module, has tests, not started by the compose stack |
| Configuration | `pkg/config` | Flag and environment binding for the Go binaries |

---

## 2. Prerequisites

- **Container engine with Compose v2**: Podman 5+ or Docker Engine 24+
  (`podman compose version` / `docker compose version`). The scripts in `scripts/dev/`
  use Podman when it is installed and Docker otherwise. Go and Node.js on the host are
  optional: the stack and the test suites run in containers.
- **Windows 11**: Git for Windows (Git Bash). Run the scripts from Git Bash, not from
  PowerShell or cmd.
- **Go 1.25 or later** (`go version`), only to build or run the binaries on the host.
- **Python 3**, only for `scripts/dev/check-links.py` and the legacy tool tests.
- `curl`, `git`, `make`, `openssl`.
- OpenTofu or Terraform, Helm and kubectl are needed only for the deployment manifests,
  which are unsupported (sections 6 and 7).

---

## 3. Local development environment

The development stack and the test suites are driven by scripts in `scripts/dev/`.
They are POSIX `sh` and run everything in containers.

| Script | Purpose |
|---|---|
| `gen-env.sh` | Writes `.env` with fresh random secrets. Refuses to overwrite an existing file. Never prints the values. |
| `stack.sh up` | Builds and starts PostgreSQL, Valkey, the backend and the console. Waits until they are healthy. |
| `stack.sh nodes` | Starts two DERP relays and six Go nodes that enrol through the console. |
| `stack.sh status` | Service health, and how many nodes sent a heartbeat in the last 60 seconds. |
| `stack.sh logs [service]` | Last 200 log lines of all services or of one. Add `-f` to follow. |
| `stack.sh down [-v]` | Removes the containers and the network. `-v` also removes the volumes (database, node identities). |
| `test-go.sh` | `gofmt -l`, `go vet`, `go test ./... -race` and the tests of `cmd/sovereign-security-daemon`. |
| `test-backend.sh` | Backend suite against a Valkey created for the run and removed afterwards. |
| `test-frontend.sh` | `npm ci`, production build and unit tests of the console. |

### Windows 11 (Git Bash and Podman)

1. Install Git for Windows and Podman. Start the machine: `podman machine start`.
   `podman compose` needs a Compose v2 provider on `PATH`; the `docker-compose`
   binary that ships with Docker Desktop works, and Docker Desktop itself can stay stopped.
2. Open Git Bash and clone. `.gitattributes` makes the checkout LF even with
   `core.autocrlf=true`; shell scripts and nginx configs break inside Linux images if
   they are CRLF.

```bash
git clone https://github.com/Mohamed-DN/neronet-proxy.git
cd neronet-proxy
sh scripts/dev/gen-env.sh
sh scripts/dev/stack.sh up
sh scripts/dev/stack.sh nodes
sh scripts/dev/stack.sh status
```

`engine.sh`, sourced by every script, sets `MSYS_NO_PATHCONV=1` and converts the
repository path with `pwd -W`. Without that, Git Bash rewrites `-v ...:/src` into a
Windows path and the mount fails.

### Linux and macOS (Docker or Podman)

Same commands. Install Docker Engine with the Compose plugin, or Podman with a Compose
provider. On macOS use Docker Desktop or `podman machine`.

```bash
git clone https://github.com/Mohamed-DN/neronet-proxy.git
cd neronet-proxy
sh scripts/dev/gen-env.sh
sh scripts/dev/stack.sh up
sh scripts/dev/stack.sh nodes
sh scripts/dev/stack.sh status
```

### Using the stack

- Console: `http://127.0.0.1:8443`. User `admin`; the password is `SOVEREIGN_ADMIN_PASS`
  in `.env`.
- API: `http://127.0.0.1:8081/api/health`.
- `status` should report 6 of 6 nodes within about a minute of `nodes` finishing.
- PostgreSQL and Valkey are not published to the host. To reach them, start the stack
  with `NERONET_DEBUG_PORTS=1 sh scripts/dev/stack.sh up`; they listen on
  `127.0.0.1:5432` and `127.0.0.1:6379`.

### Running more than one stack

Every stack needs its own project name and its own host ports. `NERONET_PORT_OFFSET`
shifts all default ports at once:

```bash
COMPOSE_PROJECT_NAME=featx NERONET_PORT_OFFSET=100 sh scripts/dev/stack.sh up
COMPOSE_PROJECT_NAME=featx NERONET_PORT_OFFSET=100 sh scripts/dev/stack.sh nodes
COMPOSE_PROJECT_NAME=featx NERONET_PORT_OFFSET=100 sh scripts/dev/stack.sh status
COMPOSE_PROJECT_NAME=featx NERONET_PORT_OFFSET=100 sh scripts/dev/stack.sh down -v
```

Use the same two variables on every call for a given stack. Each stack has its own
database, Valkey and node identities, so nodes enrol only in their own stack.
Individual ports can be set instead of an offset; see section 5.

### Running the tests

```bash
sh scripts/dev/test-go.sh
sh scripts/dev/test-backend.sh
sh scripts/dev/test-frontend.sh
```

Two `test-backend.sh` runs can overlap. Each creates its own network and Valkey, and
keeps the SQLite files the tests create in a tmpfs. Do not point the backend tests at
the Valkey of a running stack: the tests key their data by process id, and ids collide
across containers.

### Running a node on the host

This needs Go on the host and is not required for working on the console. Start the
stack first, then:

```bash
set -a && . ./.env && set +a
SOVEREIGN_NODE_KEY_PATH=./node_identity.key \
  go run ./cmd/sovereign-node -control-url http://127.0.0.1:8443 -country IT
```

The node reads `SOVEREIGN_REGISTRATION_TOKEN` from the environment. Without a writable
`SOVEREIGN_NODE_KEY_PATH` it stops, because an identity that changes on every start is
not an identity. The console lists the node once it enrols.

The command line tool talks to the same address:

```bash
go run ./cmd/sovereign-cli peers DE --control-url http://127.0.0.1:8443
go run ./cmd/sovereign-cli circuit US --control-url http://127.0.0.1:8443
go run ./cmd/sovereign-cli keygen
go run ./cmd/sovereign-cli stun-ping 127.0.0.1:3478   # needs the nodes profile
```

`make build` writes `bin/sovereign-node`, `bin/sovereign-cli`,
`bin/sovereign-derp-relay` and `bin/sovereign-control-plane`. The last is not to be run.

To try the data plane spike, see `scripts/dev/dataplane-spike-lab.sh` and
[ADR 0020](docs/adr/0020-data-plane.md).

---

## 4. Configuration

The Go binaries read a command-line flag first, then the environment (a `.env` file in
the working directory is loaded), then a built-in default. The backend reads the
environment. `.env.example` also lists variables of the legacy scripts under
`scripts/legacy_refactor` and of a configuration engine that no component of the compose
stack uses; only the variables below matter to the running stack.

### Go node

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `SOVEREIGN_CONTROL_PLANE_URL` | `-control-url` | `http://127.0.0.1:8443` | Where to enrol. In the stack: `http://frontend:8443` |
| `SOVEREIGN_REGISTRATION_TOKEN` | none | none | Enrolment token, sent as a bearer credential. The same value for the whole fleet |
| `SOVEREIGN_NODE_KEY_PATH` | `-identity` | `/var/lib/neronet/node_identity.key` | Persistent identity key, created on first start |
| `SOVEREIGN_COUNTRY_CODE` | `-country` | `US` | Self-declared country. Not measured |
| `SOVEREIGN_ENABLE_EXIT_BRIDGE` | `-enable-exit` | `false` | Register as an exit bridge |
| `SOVEREIGN_MAX_BANDWIDTH_KBPS` | `-max-bandwidth-kbps` | `0` | Self-declared capacity; 0 means not declared |
| `SOVEREIGN_SOCKS5_LISTEN_ADDR` | `-socks-addr` | `127.0.0.1:1080` | SOCKS5 proxy |
| `SOVEREIGN_HTTP_LISTEN_ADDR` | `-http-addr` | `127.0.0.1:8080` | HTTP CONNECT proxy |
| `SOVEREIGN_DATAPLANE` | `-dataplane` | `off` | `off`, `netstack` or `tun` |
| `SOVEREIGN_SPIKE_PEERS` | `-spike-peers` | none | Peers document for the data plane spike |

### DERP relay

`SOVEREIGN_RELAY_LISTEN_ADDR` (`-listen-addr`), `SOVEREIGN_STUN_LISTEN_ADDR`
(`-stun-addr`), `SOVEREIGN_RELAY_REGION` (`-region`), `SOVEREIGN_DECOY_TITLE`
(`-decoy-title`).

### Backend

`.env.example`, section 0, documents the variables the backend reads. The ones that
matter:

| Variable | Meaning |
|---|---|
| `NODE_ENV` | `production` in the stack. Turns on the secret checks and HSTS |
| `SOVEREIGN_JWT_SECRET`, `SOVEREIGN_REFRESH_SECRET` | Signing keys. Required in production, and a value that has ever been committed is refused |
| `SOVEREIGN_ADMIN_PASS` | Password of the `admin` account created at first start |
| `SOVEREIGN_REGISTRATION_TOKEN` | Enrolment token that nodes present |
| `DATABASE_URL`, `POSTGRES_*` | PostgreSQL connection |
| `VALKEY_URL` | Valkey connection |
| `SOVEREIGN_DATA_DIR` | Writable directory for the federation identity |
| `SOVEREIGN_FEATURE_CLOUD_PC` | Off by default; the feature cannot stream and is frozen |
| `SOVEREIGN_TRUST_PROXY_HOPS` | Number of proxies in front of the API. See the handbook, section 8.2 |
| `CORS_ORIGIN` | Browser origins allowed to call the API |

---

## 5. Compose stack reference

`docker-compose.yml` is the only compose file for development. It sets no
`container_name` and no subnet, so several stacks can share a host.

### Services and profiles

| Service | Profile | Purpose |
|---|---|---|
| `postgres`, `valkey` | always | Durable state and hot state. Not published to the host. |
| `backend` | always | Node.js control plane API. |
| `frontend` | always | nginx: the console SPA, and the entry point Go nodes enrol through. |
| `derp-eu`, `derp-us` | `nodes` | DERP relays; each also answers STUN on UDP. |
| `relay-de`, `relay-fr`, `relay-us`, `relay-nl`, `client-it`, `client-es` | `nodes` | Go nodes. Each keeps its identity key in its own volume. |
| `postgres-debug`, `valkey-debug` | `debug-ports` | Loopback forwarders to PostgreSQL and Valkey. |

`nodes` builds `docker/Dockerfile.node` once; all eight services use that image.

### Host ports

All ports are bound to `127.0.0.1`.

| Variable | Default | Service |
|---|---:|---|
| `NERONET_CONSOLE_PORT` | 8443 | `frontend` |
| `NERONET_API_PORT` | 8081 | `backend` |
| `NERONET_DERP_EU_PORT` | 8444 | `derp-eu` (TCP) |
| `NERONET_DERP_US_PORT` | 8445 | `derp-us` (TCP) |
| `NERONET_STUN_EU_PORT` | 3478 | `derp-eu` (UDP) |
| `NERONET_STUN_US_PORT` | 3479 | `derp-us` (UDP) |
| `NERONET_POSTGRES_PORT` | 5432 | `postgres-debug` |
| `NERONET_VALKEY_PORT` | 6379 | `valkey-debug` |

`CORS_ORIGIN` of the backend is built from `NERONET_CONSOLE_PORT` and
`NERONET_API_PORT`.

### Data and project names

Volume names derive from the Compose project name: `<project>_postgres_data`,
`<project>_identity-relay-de` and so on. The default project name is the checkout
folder name. Changing the name, or running from a folder with another name, starts
with empty volumes. `stack.sh down` keeps the volumes; `stack.sh down -v` deletes them,
which makes every node enrol again as a new device.

---

## 6. Cloud provisioning

`terraform/` holds modules for six cloud providers, and `scripts/tools/export_tfvars.go`
generates variable files from `configs/mesh-cluster.yaml`. They have never been applied
to a real account and are not supported. The decision is to deploy on virtual machines
first ([ADR 0012](docs/adr/0012-deployment-target-vm-first.md)), and the modules are to be
removed until a customer asks for them.

---

## 7. Kubernetes and Helm

`charts/sovereign-mesh` and `k8s/` have never been applied to a real cluster and are not
supported ([ADR 0012](docs/adr/0012-deployment-target-vm-first.md)). The chart is to be
proven on `kind` in CI after the virtual-machine deployment. `helm lint` and `helm
template` catch syntax errors and nothing else.

---

## 8. Testing and diagnostics

### The suites

```bash
sh scripts/dev/test-go.sh        # gofmt, go vet, go test -race, and the daemon module
sh scripts/dev/test-backend.sh   # backend suite against a throw-away Valkey
sh scripts/dev/test-frontend.sh  # production build and unit tests
```

With Go on the host: `make test` runs `go test -v -race ./pkg/...` and `make lint` runs
`go vet ./...`.

CI (`.github/workflows/ci.yml`) runs the Go suite, the backend suite three times, the
frontend build and tests, the compose stack with six nodes and a smoke check
(`scripts/dev/smoke.sh`), the console security headers check, linters, the legacy tool
tests and the image builds. Secret scanning, CodeQL and dependency audits run from
`security-scan.yml`.

### Documentation links

```bash
python3 scripts/dev/check-links.py
```

Fails, with one line per link, if a relative link in a tracked Markdown file points at a
path that does not exist. CI runs it in the `lint` job. It does not check anchors.

### Diagnostic commands

```bash
sh scripts/dev/stack.sh status                   # service health and live node count
sh scripts/dev/stack.sh logs backend             # last 200 lines of one service
sh scripts/dev/smoke.sh 6 180                    # wait for 6 nodes, check /api/health
sh scripts/dev/check-console-headers.sh http://127.0.0.1:8443
```

---

## 9. Hardening notes

1. **Secrets.** Keep `.env` at mode 600. `gen-env.sh` writes random values and does not
   overwrite an existing file. In production containers mount secrets as files or
   environment from a secret store, not from a committed file.
2. **Enrolment token.** One value authenticates every node. Rotate it by changing the
   backend and all nodes together. Per-node credentials are not implemented.
3. **Containers.** The backend runs as uid 10001 with a read-only root filesystem, no
   capabilities and `no-new-privileges`. Keep that when changing the compose file.
4. **Egress from a node.** The node's proxy refuses private address ranges and a list of
   abuse ports before it dials. The dial itself is an ordinary operating-system
   connection.
5. **TLS.** The edge nginx of the compose stack serves plain HTTP. Put TLS in front of it
   for anything beyond a workstation; native TLS termination is not configured yet.

---

## 10. Troubleshooting

### `bind: permission denied` on port 443 or 80
Non-root processes cannot bind privileged ports on Linux. Grant the binary
`CAP_NET_BIND_SERVICE` or publish a high port and map it:
```bash
sudo setcap 'cap_net_bind_service=+ep' bin/sovereign-derp-relay
```

### STUN reflection fails or reports a symmetric NAT
UDP port 3478 is blocked by a firewall or the network is behind a symmetric NAT. Allow
UDP 3478 inbound to the relay. No node uses STUN today; only `sovereign-cli stun-ping`
does.

### A node logs `Initial control plane registration failed`
The node keeps running in standalone mode. Check that `SOVEREIGN_REGISTRATION_TOKEN`
matches the backend's, that `-control-url` reaches nginx (`http://frontend:8443` inside
the stack), and the backend logs: with `NODE_ENV=production` and no token set, every
node endpoint answers 503.

### A node logs `WARNING: Node is QUARANTINED`
The control plane has quarantined the node. The reason is in the log line and in the
console. Quarantine is set by an administrator or by the risk engine.

### Every node shows as unverified
Correct. Nodes do not measure disk encryption or firewall state yet, so no node can be
verified compliant.

### `stack.sh nodes` finishes and `status` shows fewer than 6 nodes
Wait about a minute for the first heartbeats. If a node is still missing, read its log
with `sh scripts/dev/stack.sh logs relay-de`.

---

*Decisions are recorded in [`docs/adr/`](docs/adr/). For vulnerability reports and
architecture questions use the repository issue tracker.*
