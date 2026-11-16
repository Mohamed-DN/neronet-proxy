# ADR 0033: NeroDrop, end-to-end encrypted files between members of one organisation (phase 0)

**Status:** Accepted (phase 0)
**Date:** 2026-11-16
**Deciders:** owner, lead engineer
**Related:** [ADR 0029](0029-device-apps-and-profile-gateway.md) (profile gateway),
[ADR 0030](0030-iam-permissions-roles-grants.md) (IAM), [ADR 0032](0032-exit-nodes-for-profile-devices.md)
(exits), migration 051 (several gateways per organisation)

## Context

The owner wants to send a file from one device or person to another inside the network, like
Tailscale's Taildrop, without the file ever sitting on the console. A design draft (12 November)
proposed two modes (a mailbox on a node, and direct transfer between our apps) and fourteen
acceptance tests. Facts that shape phase 0:

- Most phones run the stock WireGuard app (ADR 0029). It cannot listen or run code; the phone
  can only open a web page. A received file therefore has to wait somewhere until the
  recipient fetches it.
- The profile gateway decrypts a profile device's WireGuard packets and encrypts them again
  towards the mesh (`pkg/dataplane/forward.go`). WireGuard is not end to end for these devices;
  confidentiality against the gateway has to come from the application.
- WebCrypto (`crypto.subtle`) exists only in a secure context. A page on `http://100.64.x.x` is
  not one; the console's https origin is, and every phone that joined already reaches it.
- An organisation may have several profile gateways, one of them the default (migration 051,
  `ProfileGatewayService`). The gateway of a single-host installation runs next to the console
  on the same compose network (`docker-compose.gateway.yml`).

## Decision

### 1. The page is on the console origin

`/drop` in the portal, for every signed-in member (and in the console's sidebar under "you").
It needs no new certificate and no overlay name, and it works on any phone that can sign in.
The cost, stated in the page and here: the ciphertext passes through the console's reverse
proxy (nginx). It is never stored there and never reaches the backend.

### 2. End-to-end encryption in the browser

- A fresh random 256-bit key per transfer (`crypto.getRandomValues`), never sent to a server.
- AES-256-GCM in 1 MiB chunks. Nonce: four zero bytes and the piece index as a 64-bit
  big-endian number (manifest 0, chunk *i* is *i* + 1). Associated data:
  `nerodrop/v1/<transfer id>/<index>/<final 0|1>`. Reordering, truncation, trailing bytes, a
  piece from another transfer and any changed byte fail authentication; an empty file has one
  empty final chunk, so cutting a file at a chunk boundary is detected too.
- The file name, type and size travel in a sealed manifest of fixed size (1024 bytes plus the
  tag) at the start. The servers see the transfer id, the ciphertext length (which gives the
  size to within 16 bytes per MiB), sender, recipient and expiry; never the name or content.
- The key reaches the recipient in the fragment of the share link,
  `https://<console>/drop#r=<id>.<key>`, shown as text, as a QR code, and with an
  8-character code (`7F3A-09C2`) that the recipient sees next to the file in their inbox. The
  fragment is never sent to a server or written to an access log; the page reads it and removes
  it from the address bar.
- Nothing is offered to save until every chunk has authenticated.
- Implementation: `console/frontend/src/drop/dropCrypto.ts`; the end-to-end test runs the same
  module in Node.

### 3. Ciphertext on the default profile gateway

`pkg/drop` inside `sovereign-node` is a small mailbox: `PUT` and `GET /drop-blob/<id>` on a
listener on the container network (`-drop-listen`, `:8788` in `docker-compose.gateway.yml`),
storing on its own volume (`/var/lib/neronet-drop`). It enforces the exact size a ticket names,
a per-transfer limit (256 MiB), a quota for all transfers (2 GiB, counted again at start), a
lifetime cap (168 h, `-drop-max-age`), deletion after the first complete download of a one-time
transfer, and a sweep every minute of expired transfers and abandoned uploads. A node running it
reports the capability `drop-v1`; the console offers NeroDrop only when the organisation's
default gateway reports it and is not quarantined.

nginx forwards `/drop-blob/` to `NERONET_DROP_UPSTREAM` (`gateway:8788`), streaming in both
directions, with cookies stripped and `Cache-Control: no-store`. The listener is not published
on the host.

### 4. Tickets, not sessions, at the gateway

The console signs short-lived tickets; the gateway verifies them offline.

- Key: HKDF-SHA-256 over X25519(control plane key, gateway identity key), info
  `neronet/v4/drop-ticket`. Both sides already hold their half (ADR 0017 proof of possession),
  so no secret is configured, and a ticket for one gateway is void on another. A shared test
  vector in `pkg/drop/ticket_test.go` and `console/backend/tests/drop.test.js` pins the
  derivation on both sides.
- Ticket: `base64url(JSON).base64url(HMAC-SHA-256(key, "nerodrop-ticket-v1." + payload))`
  with `{v, op: put|get, id, gw, n, exp, del, once}`. Upload tickets live 15 minutes and name
  the exact ciphertext size, the deletion time and the one-time flag; download tickets live 5
  minutes and go to the recipient only.
- A request without a valid ticket for this gateway, transfer and operation gets 401 before the
  store is looked at, so it cannot learn whether a transfer exists.

### 5. Who may send to whom

- Members of the same organisation (`users.organization_id` or a membership), active accounts
  only. A recipient in another organisation, a suspended one and an unknown id all answer 404.
- Auditors receive but do not send (their role is read-only).
- `organizations.drop_enabled` (migration 052), on by default, is the switch an administrator
  turns off from the page; off stops new transfers and downloads of existing ones.
- `DropService.mayDrop` is the one IAM hook; ADR 0030's grant check
  `can(actor, 'device.drop', recipient)` replaces its body. At most 20 open transfers per sender.

### 6. Metadata and audit

`drop_transfers` holds id, organisation, sender, recipient, gateway, ciphertext length,
one-time flag, status (pending, sent, received) and times. A test pins this column list and
checks that a file name sent along with the request reaches neither the table nor the audit.
Audit events (`DROP_CREATED`, `DROP_SENT`, `DROP_DOWNLOAD_TICKET`, `DROP_RECEIVED`,
`DROP_POLICY_SET`) carry ids, sizes, flags and expiry: no file name, type, hash, key, link or
ticket. Expired metadata is deleted when the next transfer is created.

### 7. Lifetime

One-time (default): deleted from the gateway after the first complete download, at the latest
after 24 hours. 24 hours: downloadable again until it expires. The gateway's cap (168 h by
default) is above the console's 24 h; a gateway configured below it deletes earlier, and the
page then says the file has expired.

## Options considered

### A. Store on the console

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Console disk and bandwidth |
| Scalability | Central bottleneck |
| Team familiarity | High |

**Pros:** one place, no new listener. **Cons:** the owner's rule is that files never sit on the
console; a console breach would hold every file's ciphertext. Rejected.

### B. A page served by the gateway on an overlay name (the draft's phase 0)

| Dimension | Assessment |
|---|---|
| Complexity | High (a certificate for an overlay-only name, a second web bundle) |
| Cost | DNS-01 issuance and renewal per gateway |
| Scalability | Good |
| Team familiarity | Low |

**Pros:** the bytes never cross the console's proxy. **Cons:** blocked on a public name and
certificate decision (the draft's OQ-1) and on a way for a browser without a console session to
get a ticket (OQ-2). Deferred, not rejected.

### C. Console page, ciphertext on the gateway through the console's proxy (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Gateway disk within a quota and a lifetime |
| Scalability | One mailbox per organisation's default gateway |
| Team familiarity | High (nginx, Express, Go HTTP) |

**Pros:** works today on every phone that can sign in, iOS included; uses the existing session
and the existing control plane keys; the console stores nothing. **Cons:** ciphertext passes the
console's proxy; the gateway must be reachable from the console's nginx.

### D. Direct transfer between our apps

No data at rest, but a stock-WireGuard phone cannot receive. Kept for phase 2.

## Trade-off analysis

Option C buys reach and a short path to a working feature with one honest concession: the
console's reverse proxy carries the ciphertext. Because the key never leaves the two browsers,
the proxy and the gateway learn only what the metadata already tells the console (who, to whom,
how big, until when). The capability link is a sealed envelope: whoever holds it and signs in as
the recipient can open the file until it expires. The console still hands the ciphertext only to
that recipient, so a leaked link alone is not enough.

## Consequences

- Easier: any member can send a file to any colleague from any phone, with the file unreadable
  to the console, its proxy and the gateway.
- Harder: the gateway now keeps data (bounded by quota and lifetime) and needs its volume
  backed by enough disk; the mailbox listener is one more surface, guarded by tickets only.
- Limits of phase 0, stated in the page: one request per transfer, no resume, at most 256 MiB,
  the received file assembled in memory (iOS Safari has no streaming save), no notification,
  no plaintext hash shown on both screens (integrity comes from the authenticated encryption).
- Topology: the default gateway must be reachable from the console's nginx at
  `NERONET_DROP_UPSTREAM`. In the single-host installation that is the compose service
  `gateway`; an organisation whose default gateway is on another host needs that address set
  (or waits for phase 1, below). Tickets name the gateway, so a misrouted request fails closed.
- The Helm chart and Kubernetes manifests do not run the mailbox yet.

## Acceptance tests (draft numbering) and where phase 0 stands

| # | Status in phase 0 | Evidence |
|---|---|---|
| AT-1 | Covered on the development stack, not yet with two phones | `scripts/dev/scenarios/nerodrop-e2e.mjs`: 5 MiB random file, member to member, SHA-256 equal |
| AT-5 | Done on the development stack | Volume holds `.blob` and `.json` only; marker and file name not found on the volume, in the database dump or in the console logs; stored blob SHA-256 equals the sender's ciphertext |
| AT-6 | Done | One-time deleted on download; unread and reusable transfers swept at the lifetime cap (Go tests and e2e) |
| AT-8 | Done in unit tests | Flipped byte, swapped chunks, truncation at and inside a boundary, trailing bytes, other transfer id: all refused |
| AT-10, AT-12 | Done for phase 0's rule | Cross-organisation, suspended and unknown recipients 404; sender cannot fetch; auditor cannot send |
| AT-13 | Done | Audit rows carry no name, type, hash, key, link or ticket |
| AT-14 | Done in unit tests | Same file twice: different ciphertexts, same plaintext |
| AT-2, AT-3, AT-4, AT-7, AT-9, AT-11 | Open | Large files, iOS memory ceiling, resume, capture at the gateway, Android share sheet, revocation mid-transfer |

## Action items

1. [x] Phase 0: `pkg/drop`, migration 052, `/api/drop`, `/drop` page (Italian and English), nginx
   route, compose wiring, tests and the end-to-end scenario.
2. [ ] Run AT-1 and AT-3 with two real phones (stock WireGuard app) against the owner's gateway.
3. [ ] Phase 1: chunked, resumable upload and download (`PUT /drop-blob/<id>/<n>`), streaming
   save through a Service Worker, larger limits, a visible plaintext hash, the Android share
   sheet, device drop keys, and bytes over the overlay for gateways on another host.
4. [ ] Replace `DropService.mayDrop` with ADR 0030's `device.drop` grant; revocation epoch in
   tickets.
5. [ ] Phase 2: direct transfer between our apps.
