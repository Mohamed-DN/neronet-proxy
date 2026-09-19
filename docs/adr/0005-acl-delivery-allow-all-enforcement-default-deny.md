# ADR 0005: ACL delivery is allow-all when no rules exist; enforcement is default-deny

- Status: Accepted as the current behaviour. Superseded in part by the organisation
  setting in the target architecture (see Consequences).
- Date: 2026-09-13

## Context

`pkg/acl` on the node denies everything that no rule permits. The control plane
compiles a policy for each node from the rules an administrator wrote. If it delivered
an empty rule set to a fleet, every node would drop all traffic.

Policy delivery is versioned by an epoch reported in the register and heartbeat
responses. The node compares the epoch in the heartbeat response with the one it holds
and downloads a new policy only when the value has advanced.

## Decision

When no rules exist, the control plane compiles an allow-all policy. A mesh with no
policy written is open, and it closes when the first rule is written. The two sides are
changed together or not at all: changing the delivery default without changing the
enforcement side takes a mesh down on deploy.

The epochs stay real counters. A constant epoch makes the comparison on the node
permanently false: policy is then delivered once, at enrolment, and never again, and
every direct test of the sync endpoint still passes.

## Consequences

- An administrator who has not written any rule has an open mesh. The console has to
  say so.
- The node loads the delivered policy into its filter, but no traffic passes through
  that filter today, because there is no data plane. The policy is delivered and
  discarded. Enforcement arrives with the data plane
  ([ADR 0008](0008-wireguard-data-plane-transport.md)).
- The target architecture replaces the implicit default with an organisation setting,
  `default_policy`, with values `open` (laboratories) and `deny` (production), shown in
  the console. Delivery then follows that setting, and enforcement stays default-deny.
