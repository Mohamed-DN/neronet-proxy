# ADR 0026: Extend networking through measured adapters and resource boundaries

- Status: Proposed
- Date: 2026-10-29
- Deciders: project owner and technical lead
- Builds on: [ADR0022](0022-modular-transports.md),
  [ADR0019](0019-organizations-and-rbac.md),
  [ADR0021](0021-sub-networks-and-drop-rules.md)

## Context

The owner requested a broad source audit across mesh VPNs, P2P traversal, reverse
tunnels, alternate transports, kernel/userspace networking and DNS. NeroNet needs
an installable product and reliable reachability before adopting every advanced
technique. Existing candidates and data must be preserved. The
[blueprint](../NERONET_MASTER_NETWORKING_BLUEPRINT.md) records the baseline,
source comparison, gaps and required acceptance evidence.

## Proposed decision

Keep the accepted control/data split and one Go WireGuard device with selectable
`conn.Bind` transports. Finish authenticated redundant DERP under ADR0022 before
integrating additional transports. Use upstreams as source evidence and narrow
adapter candidates, not as an instruction to embed whole networking platforms.

Keep userspace resource connectors, public ingress, DNS indirection, relay
admission and packet filtering as explicit boundaries. Adopt event-driven
selection state machines with deterministic clock tests; leave socket ownership,
I/O, buffer lifetime and cancellation with the executor. Preserve current tenant,
compartment, revocation and expiry semantics at every boundary.

Profile the deployed packet path before optimizing it. Keep batching/offloads
provided by the pinned dependencies when introducing the multiplexer. Any Linux
fast path must enforce the same policy and keep the portable implementation.
Signed resource grants, connection MFA, PQC, multipath and anti-DPI each need
their own lifecycle/threat model and acceptance package.

## Options considered

| Option | Complexity / cost | Benefit | Consequence |
|---|---|---|---|
| Extend the existing device and boundaries (recommended) | Moderate incremental integration and tests | Preserves measured WG/ACL/identity behavior and portable clients | Requires explicit adapters, truthful telemetry and per-module ownership |
| Embed another complete mesh/proxy platform | High permanent policy, identity, dependency and license cost | Faster access to a particular platform's existing features | Adds competing authorities and deployment assumptions; requires a new architecture decision |
| Rewrite dataplane/control in Rust or a new protocol | Very high implementation and verification cost | Could support a different runtime/performance design | Invalidates current evidence; offers no measured gain without a prototype/profile |

## Consequences

The research backlog is retained without making advanced networking a prerequisite
for the first usable single-node product. Integration proceeds through NR0-NR8 in
the blueprint and the existing product phases. Two relays on one host remain one
failure domain; HA, offsite backup and mobile providers retain independent gates.
Component licenses and notices must be established before code reuse.

## Action items

1. Complete the current security/session package and its real API/browser gates.
2. Complete the existing T0 contract, relay, policy, observations and process-level
   overlay scenarios before claiming redundant DERP availability.
3. Establish portable baseline profiles and client/connector requirements.
4. Evaluate each optional adapter against the source comparison and a failing
   scenario; re-run enforcement/lifecycle tests over that adapter.
5. Record measured results and remaining unknowns; require independent review
   before treating a new transport or cryptographic contribution as stable.
