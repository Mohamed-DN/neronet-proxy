# ADR 0021: Sub-networks are enforced, and DROP rules subtract from an open mesh

- Status: Accepted
- Date: 2026-10-04
- Amends: [ADR 0005](0005-acl-delivery-allow-all-enforcement-default-deny.md). An open mesh
  now closes when the first ACCEPT rule is written, not the first rule of any kind.

## Context

Two parts of the policy model said one thing in the console and did another on the nodes.

1. **Compartments did nothing.** Migration 019 added compartments, a `compartment_id` on
   nodes, and `compartment_peerings` with an allow/deny policy. Neither the policy compiler
   (`AclEngine`) nor the netmap read any of it. A node in "Finance" reached a node in
   "Guests" as if they were one network. Nodes enrolled over the control plane carry no
   compartment at all.
2. **One DROP rule closed the whole mesh.** An open organisation compiled to allow-all only
   while it had no rules. The first rule of any kind made the policy an allow-list, so a
   rule set of DROPs alone permitted nothing and `pkg/acl`, which denies whatever no entry
   permits, cut every peer of every node. Cutting one link from the topology canvas took
   the mesh down: 30 of 30 pairs timed out on the running stack. The overlay `rule-deny`
   scenario passed only because it also wrote an allow-all rule.

## Decision

1. **A compartment is a reachability boundary, applied before any rule.** A node's candidate
   peers are the nodes of its own compartment and of every compartment joined to it by a
   peering with policy `allow`. A peering connects its two compartments both ways. A node
   outside the boundary is not a candidate peer at all: no rule and no default reaches it,
   and the netmap never names it. ACL rules refine inside the boundary; they cannot cross it.
   This is the same mechanism as the organisation boundary.
2. **A node with no compartment is in its organisation's default one** (`cmp-<org>`, the id
   migration 019 gives it). A fleet that never creates a second compartment is unchanged.
3. **DROP rules subtract from an open default; the first ACCEPT ends it.** In an open
   organisation whose rules contain no ACCEPT, the open default is compiled after every
   rule. `pkg/acl` takes the first matching entry, so each DROP still wins for its pair and
   everything else stays open. The first ACCEPT turns the policy into an allow-list, as
   before, which is how Tailscale behaves. A deny organisation is unchanged.
4. **One reading of the compiled policy everywhere.** The netmap, the topology view and the
   packet simulator all answer "can these two talk" the way `pkg/acl` does: first match,
   compartment boundary first. The topology draws a pair as cut only when a DROP names it;
   a pair an allow-list never granted is not drawn.
5. **The stored `subnet_cidr` is a label.** Overlay addresses are not reallocated when a
   node changes compartment (that would need re-enrolment), so the console does not present
   it as the devices' address range.

## Consequences

- Moving nodes, creating or removing a peering, and deleting a compartment advance the ACL
  epoch; the fleet recompiles within a heartbeat. Deleting a compartment returns its nodes
  to the default one and drops its peerings.
- A hidden (Ghost Vault) compartment is isolated like any other unless peered. Below the
  root tier it reads as absent: it cannot be peered with, nodes cannot be moved into it, and
  the peering list does not name it.
- A peering is accepted only between two compartments of the caller's organisation.
- A peering row with policy `deny` means the same as no peering. It is kept for the API's
  sake; isolation is already the default.
- An exit bridge in another compartment is unreachable until the compartments are peered.
- The overlay scenarios `rule-deny` (two DROPs and nothing else) and `subnet` (isolate,
  peer, delete) measure both decisions on real traffic in CI.
