# NeroNet v4: administrator guide

What an operator does day to day, with the endpoints as they exist. The handbook
([`docs/HANDBOOK.md`](../HANDBOOK.md)) explains how each part works; this page is the
short version.

For internal CA certificates, ACME issuance and renewal, see
[Console and node certificates](tls-certificates.md).

## Access

| What | Where |
|---|---|
| Console | `https://127.0.0.1:8443` in the compose stack, TLS only. The development stack uses a CA from `scripts/dev/gen-certs.sh`; a deployment mounts its own certificate, key and CA under the same compose secret names (`console_tls_cert`, `console_tls_key`, `control_plane_ca`) |
| API | `http://127.0.0.1:8081`, also under `/api` through the console. The contract is [`api/openapi.yaml`](../../api/openapi.yaml); the server does not publish interactive documentation |
| First account | `admin`, password from `SOVEREIGN_ADMIN_PASS` in `.env` |
| Sign-in | `POST /api/auth/login`. Access tokens last 15 minutes; the refresh token is an HttpOnly cookie |

With `SOVEREIGN_MFA_MANDATORY=admins` (the production default) the platform
super-admin and every organisation owner and admin sign in with a TOTP code. An account
without an authenticator is taken through enrolment at its next sign-in, and shown its
recovery codes once.

## Nodes

### Enrolling a node

A node proves it holds its private key on every registration (ADR 0017). What
authorises a new key is one of:

- a pre-auth key from the console (`POST /api/preauth-keys`), given to the node as
  `SOVEREIGN_ENROLMENT_KEY` (`nnk1:<key>:<fingerprint>`, which also pins the control
  plane key); single-use keys are spent at first enrolment;
- the fleet token `SOVEREIGN_REGISTRATION_TOKEN`, for automated fleets.

An enrolled node re-registers with its key alone. Each node gets an overlay address
from `100.64.0.0/10` and its own credential for everything after registration.

### Quarantine and revocation

| Action | Request | Effect |
|---|---|---|
| Quarantine | `POST /api/nodes/{id}/action` `{"action":"quarantine","reason":"..."}` | The node leaves every peer set within a heartbeat, and its credential stops working |
| Lift quarantine | `POST /api/nodes/{id}/action` `{"action":"lift_quarantine"}` | It comes back |
| Revoke | `DELETE /api/nodes/{id}` | The key is revoked and delivered to every node; the node cannot register again with it |

`scripts/dev/scenarios/overlay.sh quarantine` and `revoke` show both on a running
stack with real traffic.

## Access policy

Nodes of one organisation only ever peer with each other. Within an organisation, ACL
rules (`/api/acl/rules`) decide, first match wins; with no rule, the organisation's
`default_policy` decides (`open` or `deny`). A change reaches the nodes within one
heartbeat, 15 seconds by default.

## Transports

The overlay is WireGuard (wireguard-go, userspace by default). The pre-shared key of
each pair rotates every two minutes; it is classical cryptography, not post-quantum.
Nodes use DERP relays for inbound traffic only: there is no relayed fallback for a
pair that cannot reach each other directly yet. AmneziaWG-style obfuscation exists in
the code and is not switched on by the node. There is no OpenVPN or VLESS transport.

## Availability and backups

The standard stack is one instance of each service. `docker/docker-compose.ha.yml`
describes a three-node Patroni cluster with HAProxy and two control plane instances;
it has not been exercised as a cluster, and Valkey in it is a single instance.
Periodic jobs run on the elected leader only.

The optional restic service takes encrypted backups every six hours and copies them
to a configured secondary repository. See [backup and restore](backup-restore.md)
for verification, recovery secrets, retention and the destructive test drill.
