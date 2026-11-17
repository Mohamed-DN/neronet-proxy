# ADR 0034: Mesh names for profile devices, phases 1 to 3

**Status:** Accepted (phases 1, 2 and 3 delivered; see Phase 3 for what remains)
**Date:** 2026-11-16
**Deciders:** owner, lead engineer

## Context

`pkg/dns` holds a working MagicDNS server, but no binary started it, and a device that joins
through the profile gateway (ADR 0029) with the stock WireGuard app has no resolver for mesh
names at all. The only thing answered at `100.100.100.100` was the exit resolver (ADR 0032),
and only for devices that have an exit. The goal is the Tailscale experience: `ping laptop`
from a phone, with no client of ours on it.

The gateway already sees every profile device's packets decrypted in its userspace stack, and
the console already sends it each device's name in the netmap.

## Decision

- **D1. One address.** The mesh resolver is `100.100.100.100`, port 53, UDP and TCP, in the
  profile gateway's userspace stack, for all profile devices, exit or not. The allocator never
  hands the address out, and a device's non-exit `AllowedIPs` (`100.64.0.0/10`) contain it.
  Nothing listens on the host network: the packet is taken in the tun wrapper after
  wireguard-go authenticated the sending device, and only if its source is in the forwarding
  table (a profile device). The DNS path needs no ACL rule.
- **D2. Mesh names come from the netmap.** A query for a name under the organisation's search
  domain, or for a single-label name, is answered from the netmap with the device's overlay
  IPv4 as `A` (and `AAAA` for an overlay IPv6). An unknown mesh name is NXDOMAIN and is never
  forwarded upstream.
- **D3. Everything else.** A device with an exit keeps today's behaviour: its query goes to the
  exit's resolver path. A device without one is forwarded to the gateway's upstream resolver
  (`SOVEREIGN_EXIT_DNS` if set, else the host resolver). With no upstream the device gets
  SERVFAIL.
- **D4. Scope.** The gateway answers the names of the devices and nodes in its own
  organisation, from the netmap it already receives. Revoked peers are left out.
- **D5. Names.** The console computes `dns_name` for profile entries in `NetmapService.js` with
  the same `computeDNSName` as for mesh peers (an explicit `dns_name` wins, else the slug of
  the name plus the organisation's `search_domain`), so the gateway does not slug anything.
  When two entries end up with the same name, the gateway answers with exactly one address: the
  gateway itself first, then the lowest node id. This is deterministic across documents and
  does not depend on their order. `pkg/dns` gets `Config.SingleAnswer` for it; without it the
  server still appends every address, as before.
- **D6. Switch.** `SOVEREIGN_MESH_DNS` is on by default for a node that serves profile devices;
  `off` (also `false`, `0`, `no`) removes the resolver and restores the exit-only behaviour
  exactly: a non-exit device's packet to `100.100.100.100` meets the forwarding policy and is
  dropped.

### Code

- `console/backend/services/NetmapService.js`: `dns_name` on the gateway's profile entries.
- `pkg/dns`: `Server.Answer` (the query logic without a socket) and `Config.SingleAnswer`.
- `pkg/dataplane/meshdns.go`: `Device.SetMeshDNS`, the stack-side UDP and TCP handlers, the
  upstream relay, a bound of 256 queries in flight.
- `cmd/sovereign-node/meshdns.go`: builds the resolver from each applied document, removes it
  when the node serves no profile device, when a revocation or fail-closed empties the peer set,
  or when the switch is off.

## Consequences

- A stock WireGuard device with `DNS = 100.100.100.100` and the search domain resolves mesh
  names, and, being forwarded, other names too. Neither needs a client of ours.
- Names are unique per organisation from phase 2 (migration 053). The gateway's lowest-node-id
  tiebreak stays as a safety net for documents that predate it.
- Phases 1 and 2 left every name of the organisation visible to every profile device on the
  gateway: a device that may not reach a node could still learn that its name exists and its
  address. Phase 3 closes that.
- Queries are not logged and not rate limited per device beyond the in-flight bound.

## Phase 2 (delivered)

- **P2.1. A DNS line in every profile.** `POST /api/devices/profile` answers
  `dns: ["100.100.100.100"]` for every profile, exit or not. The address is one constant
  (`utils/meshNames.js`, which `ExitService.EXIT_DNS` re-exports). `SOVEREIGN_MESH_DNS=off` on the
  console restores the old answer (only exit profiles carry it), so a profile never names a
  resolver the gateway has switched off; set it to the same value on the console and the gateways.
- **P2.2. Search domain in the profile.** The response also has `search_domain` (the organisation's,
  else `<slug>.neronet`, else `mesh`: the same helper NetmapService uses). The frontend writes
  `DNS = 100.100.100.100, <search domain>`, which the stock WireGuard apps on iOS and Android use as a
  search domain, so `phone` resolves. `pkg/profile` now accepts DNS names after the addresses into
  `Profile.SearchDomains` and still rejects anything that is neither an address nor a valid DNS name.
- **P2.3. Unique names.** Migration 053 renames existing duplicate `dns_name` values, backfills profile
  rows oldest first (`phone`, `phone-2`, `phone-3` by `created_at`, then id) and adds
  `UNIQUE (organization_id, dns_name) WHERE dns_name IS NOT NULL`. Registration stores the name in its
  transaction under a savepoint and retries with the next suffix on a unique violation, never a 500.
  The slug drops accents, caps the label at 63 characters and is shared by the migration and
  `computeDNSName`. The netmap keeps the stored label under the organisation's current search
  domain. `set_dns_name` on a node answers 409 `dns_name_in_use` on a clash. No rename route for
  profile devices exists yet; whoever adds one must recompute through `DeviceNameService`.
- **P2.4. Exit profiles resolve mesh names.** The gateway's resolver decides first for every profile
  device. For an exit on the gateway (UDP and TCP) and for a mesh exit (UDP only: the gateway reads
  the query before relaying it; TCP and the names it does not answer go to the exit unchanged) a mesh
  name never reaches the exit's resolver. Outside names from a device with an exit go to the exit's
  resolver and never to the gateway's own upstream; with no exit resolver the device gets SERVFAIL.
- **P2.5. Visible name.** The portal's device list shows `Reachable as <name>`.

## Phase 3 (delivered): per-device name visibility

- **P1. Same decision as forwarding.** A query from profile device S for a mesh name whose
  address is A is answered only if the gateway's policy would let S open a connection to A on at
  least one protocol and port: `ForwardTable.CanOpen(S, A)`, built on the same compiled rules
  `Decide` applies (S's outbound rules by first match, plus A's inbound rules when A is a profile
  device too). `NetstackFilter.CanOpenTo` and `CanBeOpenedBy` record no conntrack or answer state,
  so asking costs no flow. The check runs per query against the table installed at that moment.
- **Same bytes as a name that does not exist.** A hidden name takes the code path of an unknown
  one in `pkg/dns` (`Server.AnswerFor`): NXDOMAIN, authoritative, no answers, no authority, same
  TTL-less shape. Tests compare the header and section counts of a hidden name with a made-up one,
  over UDP and TCP, in single-label, search-domain and FQDN forms. A hidden name is never
  forwarded.
- **P2. Always answered.** S's own address and the gateway's own addresses, whatever the policy.
- **P3. Scope.** A and AAAA, and the reverse (PTR) lookup of a hidden address, which would
  otherwise name it. A name with several addresses lists only the visible ones and is hidden when
  none is. Names outside the mesh are unchanged.
- **P4. No stale answers.** `pkg/dns` has no answer cache and the dataplane keeps none: the filter
  is evaluated on every query, so a netmap that changes the policy changes the next answer.
- **P5. Exit devices.** The same filter applies to an exit on the gateway (UDP and TCP) and to a
  mesh exit (UDP, which the gateway answers locally; names it does not answer still go to the exit).
- **API.** `dns.Server.AnswerFor(query, visible func(netip.Addr) bool)` is `Answer` with a filter
  supplied per query, `nil` meaning everything; `pkg/dns` knows nothing about policies.
  `dataplane.MeshDNS.Answer` gained the same parameter and the dataplane fills it for the source
  device. With no policy source the stack fails closed (nothing visible).
- **Effect on existing setups.** A profile device whose policy has no rule towards a node no
  longer resolves that node's name, which is the point. A device with no policy loaded sees only
  its own name and the gateway's.

## Phase 3 follow-ups (open)

1. Mesh-exit TCP DNS (truncated answers) is not answered locally; a gateway-side relay to the exit
   would close it.
2. A rename route for profile devices, with the new name checked for uniqueness.
3. The check is by address: an IPv6 address is judged by rules for that IPv6 address. If the
   control plane compiles rules for the IPv4 overlay only, AAAA records are hidden and the name
   answers A only.
4. A device can still probe for a hidden host by connecting to guessed addresses; names are not
   the access control, the policy is.
