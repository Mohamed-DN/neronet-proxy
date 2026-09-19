# ADR 0002: No message broker; NATS JetStream if durable messaging is needed

- Status: Accepted. Recorded in the roadmap on 2026-09-13, confirmed on 2026-09-19
  (see [ADR 0014](0014-confirm-earlier-decisions.md)).
- Date: 2026-09-13

## Context

Topology events travel over Valkey publish/subscribe. A message broker would add durable
queues and retries, which nothing in the product needs today. It would also add a
second consensus system that has to be kept from partitioning, which conflicts with the
high-availability design in [ADR 0001](0001-no-multi-master-postgresql.md).

## Decision

There is no broker. Valkey publish/subscribe carries events that may be lost. Work that
must happen exactly once is done by one control-plane instance holding a PostgreSQL
advisory lock.

If durable messaging becomes necessary, the choice is NATS JetStream: a single Go binary
with Raft-based clustering that composes with the etcd quorum. RabbitMQ is not chosen
because of its Erlang runtime and its own partition handling.

## Consequences

- Events published while a subscriber is disconnected are not replayed. Consumers read
  current state from PostgreSQL when they reconnect.
- The likely trigger for revisiting this is container orchestration for application
  workloads, which is not planned.
