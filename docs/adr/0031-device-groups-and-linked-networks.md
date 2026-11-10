# ADR 0031: Device groups, exposure, and links between networks

**Status:** Proposed (design only; lower urgency than ADR 0030)
**Date:** 2026-11-10
**Deciders:** owner (Mohamed), lead engineer
**Depends on:** [ADR 0030](0030-iam-permissions-roles-grants.md) (permissions and scopes),
[ADR 0021](0021-sub-networks-and-drop-rules.md) (sub-networks as a reachability boundary),
[ADR 0029](0029-device-apps-and-profile-gateway.md) (profile gateway)

## Context

The owner's words (translated): connect my network to another network so devices can talk to each
other: single devices, the whole network, or groups; organise my devices into groups, expose some,
hide others; take the best features of competitors and add ideas they do not have.

What exists today (worktree `console-v2-nov09` at `21896a1`, re-read):

- **No groups or tags.** ACL rules match CIDRs only (`db/migrations/007_acl_rules.sql`); the compiler
  turns them into per-node peer lists (`services/AclEngine.js:286-313`, `compileFor`), which nodes
  enforce in `pkg/acl`. Sub-networks (compartments) are the only grouping, and a device is in exactly
  one (`nodes.compartment_id`, migration 019; ADR 0021).
- **Hidden means hidden in the console.** A hidden compartment is invisible below the root tier and
  cannot be peered (ADR 0021, `CompartmentService.js:48,77`). It says nothing about DNS.
- **Netmaps already contain only permitted peers.** `NetmapService` selects same-organisation
  candidates and keeps only those whose overlay address the compiled policy permits
  (`services/NetmapService.js:537,578`).
- **DNS.** Each node has a `dns_name` and the organisation a `search_domain` (migration 022); names
  reach nodes in the netmap.
- **Links between networks do nothing.** `peering_agreements` (migration 003) has no
  `organization_id`, is created and accepted by the platform super-admin only (`routes/peering.js`),
  and `imported_nodes` is always `[]`, so an accepted link changes no netmap and no policy. The Go
  node has no peering code. The signed token (`services/PeeringEngine.js`) carries the initiator's
  Ed25519 key, endpoint, scope and expiry; acceptance checks the signature and an out-of-band
  fingerprint.
- **Addresses.** One installation allocates every organisation's overlay addresses from one sequence
  over `100.64.0.0/10` (`db/migrations/006_vip_sequence.sql`, `utils/crypto.js:296`), and IPv6 as
  `fd7a:115c:a1e0::<offset>` (`utils/crypto.js:204`). Consequences: inside one installation two
  organisations never overlap; between two installations both start at offset 1, so their first
  devices have **the same addresses**. Overlap is certain, not merely possible. The IPv6 prefix is
  also a fixed constant shared by every installation (and it is the prefix Tailscale uses, so a device
  running both clients sees two overlays claiming one range).
- **Per-peer PSKs are pairwise.** `pkg/crypto/pskepoch` derives each peer's PSK from the X25519
  shared secret of the two static keys and the epoch: nothing organisation-specific, so a node can
  hold a peer from another organisation or installation without new key material, provided the two
  clocks agree on the epoch.

Research input: `piano/reports/RICERCA-RETI-COLLEGATE-NOV10.md` (capabilities of Tailscale, NetBird,
ZeroTier, Nebula, Netmaker, Headscale, Twingate, Cloudflare Access; eight questions; eight ideas).

## Approach (be-ambitious, field: inter-domain network federation and zero-trust segmentation)

1. **What a top network architect would do that was not asked.** Separate the three questions
   people blur: *who may label* (an IAM question), *who may reach* (a policy question, compiled), and
   *who may know it exists* (a disclosure question: netmap, DNS, console). Make every link an
   intersection of both sides' policies, so neither side can widen the other. Treat address overlap
   as certain between installations and design translation in from the start instead of discovering
   it at the first customer. Make cutting always unilateral and instant, and opening always bilateral.
2. **Rawest material.** `AclEngine.compileFor` and `NetmapService` peer selection (where groups and
   links must be compiled); the Go `pkg/acl` and `pkg/dataplane` (what a node can enforce today);
   `006_vip_sequence.sql` (why overlap is certain); `PeeringEngine.js` (what trust material exists);
   RFC 3022 (NAT), RFC 4193 (unique local IPv6), Tailscale's tags, sharing and subnet-router pages.
3. **Methods.** Compile-time expansion of groups to addresses (no data-plane change); bilateral
   export/import manifests signed by each side; 1:1 address translation at a link gateway for
   cross-installation links; the existing simulator extended to answer "can A reach B across the link"
   as the intersection of both compiled policies; hash-chained audit (ADR 0025) with per-link
   checkpoints exchanged between the two sides.
4. **What shows it is right.** The overlay test bed (`rule-deny`, `subnet` scenarios exist): a new
   `link` scenario on the Podman stack: two organisations, one shared device, traffic flows only on the
   shared port, stops within one heartbeat after either side revokes, and a third device never appears
   in the other side's netmap or DNS. For groups: a member's attempt to tag a device with a group they
   do not own is refused, and the compiled policy for a group rule is byte-identical to the equivalent
   CIDR rule.

## Decision

### 1. Device groups (tags) are first-class

- **Table** `device_groups (id, organization_id, key, name, description, kind 'manual'|'dynamic',
  exposure, created_by, created_at)`, `device_group_members (group_id, device_id, source 'manual'|
  'enrolment'|'dynamic', added_by, added_at)`. A device can be in many groups (unlike sub-networks).
- **Who may tag: group ownership.** Adding a device to a group needs the ADR 0030 action
  `device_group.apply` **on that group** (scope `device_group`) *and* `device.update` on the device.
  A member who holds `device_group.apply` on group "laptops" can tag their laptop "laptops"; nobody
  without `device_group.apply` on "servers" can tag anything "servers". This is Tailscale's
  `tagOwners`, expressed as an IAM grant instead of a policy-file section.
- **Pre-tagged enrolment.** An enrolment key may carry groups; creating it requires
  `device_group.apply` on each of them. Devices that join with the key are tagged at enrolment.
- **Dynamic groups (later).** Membership computed from facts: sub-network, owner's SSO group,
  device kind, OS (once posture exists). Never from a value the device itself claims unverified.
- **New ADR 0030 type** `device_group`: inspect `device_group.list`; read `device_group.read`; use
  `device_group.apply`; manage `device_group.create`, `device_group.update`, `device_group.delete`.
- **Groups are also an IAM scope** (ADR 0030 phase 3): "Anna operates devices in group *Kiosks*".

### 2. Access rules by group, CIDR rules unchanged

- `acl_rules` gains optional `src_group_id` and `dst_group_id`. A rule names a source as a CIDR *or* a
  group, and a destination likewise. Existing CIDR rules are untouched.
- **Compiled away.** `AclEngine.compileFor` expands a group to its members' overlay addresses at
  compile time, so the node receives the same address-based policy it enforces today. **No Go
  change.** Adding or removing a member advances the ACL epoch like moving a device between
  sub-networks does (ADR 0021).
- Groups refine inside the sub-network boundary; they do not cross it (ADR 0021 decision 1 stands).
- Policy tests (ADR 0028) may name groups; the guard expands them the same way.
- External check: a group rule and the equivalent CIDR rule compile to byte-identical policies.

### 3. Exposure: three levels, defined in netmap and DNS terms

| Level | Netmap of other devices | DNS name | Console (below root tier) |
|---|---|---|---|
| **Listed** (default) | appears to every peer the rules permit | resolves for every device of the organisation | visible to anyone with `device.list` |
| **Unlisted** | appears only to peers the rules permit (as today) | resolves **only** for devices permitted to reach it | visible to `device.list` holders |
| **Hidden** | as unlisted | as unlisted | invisible: only in a hidden sub-network, root tier only (ADR 0021 Ghost Vault) |

- "Expose" on its own (inside the organisation) means *Listed*; "hide" means *Unlisted*. The
  strongest form, *Hidden*, is not a per-device switch: it is membership of a hidden sub-network,
  because console secrecy needs the duress tier and its plausible-deniability rules.
- Exposure is set per device, defaulted per group (most restrictive wins when groups disagree).
- DNS work: the per-node DNS record set sent in the netmap is filtered by the same permitted-peer set
  for unlisted devices. Today every node receives every organisation name; that becomes the *Listed*
  behaviour.
- **Exposure across a link** is a separate, explicit act: nothing is visible to another organisation
  unless it is in a link's export set (§4).

### 4. Links between two organisations' networks

**Model.** A link is a bilateral agreement between organisation A and organisation B. Each side
publishes an **export set** (what it offers) and an **import policy** (what it accepts and who on its
side may use it). Traffic flows from a device a in A to a device b in B only if:
b is in B's export set ∧ a is permitted by B's inbound link rule ∧ a's side allows a to reach the
link (A's outbound rule) ∧ both sides have approved ∧ the link is not expired or cut.
Neither side can widen the other: the effective policy is the intersection.

**Scope of an export:** one device, a device group, a whole sub-network, or the whole network; with a
port list (TCP/UDP ports), which is the beta's "single service" (layer 4). Layer-7 service links
(idea 2) are not in the beta.

**Identity and trust.**

| | Same installation | Different installations |
|---|---|---|
| Who the other side is | an organisation id the control plane knows; shown by name and slug | an installation identity: an Ed25519 key per installation (the existing `PeeringEngine` key) plus the organisation id inside it |
| How trust starts | an invitation from A's administrator naming B's slug; B's administrator accepts | a signed invitation token (existing format, extended with organisation id and export manifest hash), exchanged out of band; the receiver checks the signature and compares a **fingerprint read aloud or by a second channel** (the token's own words cannot be trusted) |
| Ongoing channel | the shared database | control plane to control plane over mutual TLS pinned to the two installation keys; each side pulls the other's signed export manifest every heartbeat interval |

**Approval on both sides.** A link becomes active only when an administrator of each side holds and
uses `link.accept` (organisation scope, ADR 0030). A one-sided link is *pending* and carries no
traffic (Tailscale quarantines one-way shares similarly). Changing an export set to *add* anything
returns the link to *pending re-approval* for the other side; *removing* takes effect at once.

**What each side sees.**
- Of the other side's exported devices: a display name (the exporter chooses: real name or an alias),
  the address assigned *on the viewer's side* (§5), open ports, and the exporting organisation's
  name. Never owners, users, other devices, sub-network names, or rules.
- Before activation, both administrators see a **preview** (idea 4): "B will see these 3 devices, on
  these ports, under these names; these 12 devices of yours stay invisible."

**DNS.** Imported devices resolve under a per-link suffix on the importing side:
`<name>.<link-alias>.link.<search_domain>`. The exporter controls `<name>`, the importer controls
`<link-alias>`. Exporters may publish no names at all (address only).

**Expiry and re-approval.** Every link has `expires_at` (default 90 days, maximum 365). Fourteen and
three days before, both sides' owners and the link's approvers get a console notice; renewal is a
one-click re-approval by each side. On expiry, traffic stops at the next netmap; the link stays
visible as *expired* for its history.

**Revocation and emergency cut.**
- Either side revokes alone, instantly: the control plane removes the peers from its own nodes'
  netmaps at the next fetch and stops serving its export manifest. No approval from the other side
  (idea 8's dual control is rejected for cutting: a safety switch must never need a second person).
- **Emergency cut of all links** (idea 5), per organisation: one action (`link.revoke` at
  organisation scope) cuts every link. For nodes, the netmap carries a `links_epoch`; a node that
  cannot fetch a fresh netmap within the organisation's staleness window already fails closed
  (existing behaviour), which bounds how long an offline node keeps a cut link: at most
  `max_netmap_staleness_seconds` (default 300).
- Cross-installation: revoking also closes the federation channel; the other side's nodes lose the
  peers when their control plane notices the manifest is gone, or at staleness. A side cannot force
  the other side's nodes to forget faster than that; it can, however, drop the traffic at its own
  link gateway at once, which is what matters.

**Audit both sides can verify** (idea 3). Every link event (invite, approve, export change, renew,
revoke, cut) is written to each side's hash-chained audit log (ADR 0025) with the link id. For
cross-installation links, each side signs a checkpoint (sequence number, chain head hash, link id)
with its installation key at every link event and sends it over the federation channel; each side
stores the other's checkpoints. A dispute is settled by showing the other side's signed checkpoint.
Same installation: both organisations read the same chain, filtered to the link's events.

### 5. Addresses and overlap

- **Same installation:** no overlap (one sequence). Imported devices keep their real overlay
  addresses. No translation.
- **Different installations:** overlap is certain (§Context). The **importing side assigns each
  imported device a local alias address from its own sequence** (so it is unique there) and the
  **link gateway** performs 1:1 translation between alias and real address in both directions
  (RFC 3022 style, stateless 1:1). Overlap detection (idea 7) is therefore always on: the console shows
  "translated" next to every imported address.
- Longer term, a per-installation random IPv6 prefix (RFC 4193 Global ID) instead of the shared
  constant would make cross-installation IPv6 links translation-free. Changing a node's address needs
  re-enrolment, so this is a separate migration, not part of links v1.

### 6. Data plane: what nodes and gateways must do

- **Today:** nothing, because `imported_nodes` is empty and Go has no peering code.
- **Same installation (links v1):** no Go change. `NetmapService` adds, to a node's candidates, the
  devices of linked organisations that are in an active export set and permitted by the intersection
  policy; `AclEngine.compileFor` compiles the link rules into the same per-peer allow list. Pairwise
  PSKs already work across organisations (Context). Relays: an imported peer is reached through the
  relays of its own home, which nodes already learn from the netmap (`relay_homes`).
- **Different installations (links v2):** a designated **link gateway** node on each side
  (site-to-site, like the ADR 0029 profile gateway). Only the two gateways peer across installations;
  local devices reach imported ones through their own gateway, which routes, translates (§5) and
  enforces the link rules. New Go work: 1:1 address translation in `pkg/dataplane`, routing of alias
  ranges, and enforcement of link rules at the gateway. Gateways need reachable endpoints or a relay
  both sides trust; the epoch PSK needs both clocks within one epoch (2 minutes) of each other (NTP).

### 7. Permissions (ADR 0030 additions)

- `link` moves from platform scope to organisation scope: `link.list`, `link.read`, `link.create`
  (invite), `link.accept`, `link.update` (export set), `link.revoke`. Built-ins: owner and admin hold
  all; network_admin holds `link.list`, `link.read`, `link.update` for removals only (adding to an
  export needs `link.create`); auditor reads.
- Exporting a device or group requires, in addition, `device.read` on it (you cannot export what you
  cannot see) and the device must not be in a hidden sub-network (hidden things are never exportable).

### 8. Which of the eight ideas first, and why

| # | Idea | Decision | Why |
|---|---|---|---|
| 4 | "What the other side can see" preview | **First, with links v1** | Pure computation from the export set; prevents the most likely mistake (exporting too much). |
| 1 | Time-limited links with re-approval | **First, with links v1** | One column and one reminder; the banks and public administrations the product targets (ADR 0006) need audit windows. |
| 5 | Emergency cut of all links | **First (online part)** | Unilateral, one action; offline propagation is bounded by the existing staleness fail-closed. |
| 6 | Effective policy across both sides | **With links v1** | Same installation: both policies are local, so the simulator can intersect them exactly. Cross-installation: only one's own side plus the other's declared export, stated as such. |
| 7 | Overlap detection with automatic translation | **Links v2** | Not needed inside one installation; mandatory across installations. |
| 3 | Audit both sides can verify | **Links v2** (same installation gets it free) | Needs the federation channel and installation keys. |
| 2 | Service-level links | **Layer 4 in v1, layer 7 not in the beta** | Port-scoped exports give most of the benefit; protocol-aware proxying is a product of its own. |
| 8 | Dual-control revocation or break-glass across two organisations | **Rejected for cutting, adopted for opening** | Opening already needs both sides. Cutting must stay unilateral. |

## Options considered

### Option A: Groups compiled to addresses; links as intersected export/import, gateway-based across installations (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Groups: low. Links v1: medium. Links v2: high (translation, federation) |
| Cost | Groups and links v1: no Go change. Links v2: new Go data-plane code |
| Scalability | Groups expand at compile time; fine for thousands of devices per organisation |
| Team familiarity | High for v1 (same compiler and netmap paths); low for v2 translation |

**Pros:** v1 ships with the code paths that exist; neither side can widen the other; cutting is
instant. **Cons:** cross-installation needs a gateway per side and translation.

### Option B: Direct node-to-node peering across installations (Tailscale node sharing style)

**Pros:** no gateway hop. **Cons:** every exported node needs a reachable endpoint or a shared relay;
each side's control plane would inject foreign keys into many nodes; translation would have to run on
every node. Rejected for cross-installation; it is effectively what v1 does inside one installation,
where the control plane is shared.

### Option C: Certificate-carried groups (Nebula style)

**Pros:** groups travel with identity, verifiable offline. **Cons:** revocation needs reissue or CRLs;
NeroNet's control plane already distributes policy every heartbeat. Rejected.

### Option D: Tags as policy-file entries (Tailscale `tagOwners`)

**Pros:** familiar to Tailscale users. **Cons:** a second authorization language next to ADR 0030.
Rejected: tag ownership is an ADR 0030 grant on the group.

## Trade-off analysis

The design keeps the node simple for everything inside one installation (groups, exposure, links v1
all compile to the policy and netmap nodes already apply) and concentrates the genuinely new
data-plane work (translation, cross-installation routing) in one gateway per side. The cost is an
extra hop across installations, accepted because it gives each organisation one point to audit,
filter and cut, which is what regulated customers ask firewall teams for anyway.

## What is hard, said plainly

- **Cross-installation translation** touches return routing, DNS answers and ICMP errors; it is real
  data-plane engineering and must be measured on the overlay test bed before anyone relies on it.
- **Two trust roots.** Installation key custody, rotation and loss recovery have no answer in the code
  today; losing an installation key means re-establishing every cross-installation link.
- **Offline cut propagation** cannot be faster than the staleness window without a second channel.
- **Group sprawl.** Without naming rules, organisations create hundreds of overlapping groups and
  nobody can explain reachability. The explainer and the effective-policy view are the mitigation.
- **Clock agreement** across installations for the epoch PSK.

## Not built for the beta

Cross-installation links (v2), layer-7 service links, dynamic groups based on posture, inline traffic
copy (ZeroTier `tee`), session recording, exit-node use across links, per-installation IPv6 prefixes.
The beta gets: groups with ownership, group rules, three exposure levels, and same-installation links
with export sets, two-sided approval, preview, expiry, unilateral and emergency cut, and the
intersected simulator.

## Consequences

- Easier: rules by role of device ("kiosks may reach the print server") instead of addresses; links
  that do something.
- Harder: every compiled policy depends on group membership, so membership changes must advance the
  epoch; the DNS record set per node becomes per-node instead of per-organisation.
- To revisit: per-installation IPv6 prefix; whether a group can span sub-networks in rules (no, by
  ADR 0021, until a use case forces it).
- `peering_agreements` is replaced by `network_links` with `organization_id` on each side; the old
  table has no production use (links never carried traffic) and is migrated or dropped.

## Action items

1. [ ] ADR 0030 phases 1-2 first (permissions this design relies on).
2. [ ] Groups: tables, `device_group` permissions, group rules compiled in `AclEngine`, epoch on
   membership change, overlay test "group rule = CIDR rule".
3. [ ] Exposure: unlisted DNS filtering in `NetmapService`; console switch per device and group.
4. [ ] Links v1 (same installation): `network_links`, export sets, two-sided approval, preview,
   expiry and reminders, cut and emergency cut, netmap and compiler changes, overlay `link` scenario.
5. [ ] Links v2 (after beta): installation keys, federation channel, link gateway with translation,
   signed checkpoints.

## Questions for the owner

1. Same-installation links first (several organisations on your installation), or is the real need
   linking two separate installations (yours and a customer's)? The second is several times the work.
2. Default link lifetime 90 days, maximum 365: acceptable?
3. May an exporter hide real device names from the other side (aliases), or must names be real for
   audit reasons?
