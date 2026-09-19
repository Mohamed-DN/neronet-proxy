# ADR 0001: No multi-master PostgreSQL; Patroni and etcd for high availability

- Status: Accepted. Recorded in the roadmap on 2026-09-13, confirmed on 2026-09-19
  (see [ADR 0014](0014-confirm-earlier-decisions.md)).
- Date: 2026-09-13

## Context

The control plane must survive the loss of a machine. Multi-master replication (BDR,
Bucardo, bidirectional streaming) does not remove split-brain; it turns it into write
conflict resolution, and for network state those conflicts have no correct answer:

- Two control-plane instances assign the same overlay address to different nodes.
- A node is quarantined on one side and cleared on the other.

## Decision

Control-plane instances are stateless and all active, over a single consensus-backed
source of truth:

- PostgreSQL with one primary and two standbys, synchronous replication, managed by
  Patroni.
- etcd with three voters (five if two failures must be tolerated) as the quorum and
  leader-key store.
- A hardware or software watchdog resets a machine whose Patroni process stops
  responding, so that demotion does not depend on the stalled process.
- The number of voters is odd, and a deployment on two sites has a third voter at a
  third location. Two sites alone cannot form a quorum that survives losing one.

State that lives in a control-plane process today moves out of it: token revocation,
rate-limit counters, heartbeat buffering and topology events are already in Valkey;
the Go registry and address allocator are removed with the Go server (see
[ADR 0007](0007-remove-go-control-plane-server.md)).

## Consequences

- Writes go to one primary, so write throughput is bounded by that node. The measured
  load ceilings, including heartbeat write volume, are in [the roadmap](../ROADMAP.md).
- Periodic jobs (metrics collection, heartbeat flush, dead man's switch timers, canary
  publication) must run on one instance at a time. The planned mechanism is a
  PostgreSQL advisory lock.
- The design is not built. Each failure scenario in the roadmap (kill the primary,
  partition it, freeze it, lose one voter, lose two) has to be executed and recorded
  before this is described as high availability.
- Deployment order follows [ADR 0012](0012-deployment-target-vm-first.md): single node
  first, then three virtual machines.
