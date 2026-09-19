# ADR 0007: Remove the Go server half of `pkg/control`; the contract becomes JSON Schema

- Status: Accepted (reviewer's recommendation under delegated authority, 2026-09-19)
- Date: 2026-09-19
- Decision label: D1

## Context

The control plane that runs is the Node.js backend, reached through nginx at
`/v4/control/*` (`console/backend/routes/goBridge.js`). `pkg/control` also contains a
Go server (`server.go` handlers, `registry.go`, `vip.go`, `cmd/sovereign-control-plane`).
It keeps nodes in memory, has no authentication and no tenancy, and no compose file
starts it. Two implementations of one control plane is one too many, and the duplicate
is invisible because only one of them runs.

The request and response structs and the client in the same package are used by
`cmd/sovereign-node` and `cmd/sovereign-cli`. Their struct tags define the wire
contract, and the Node.js side once diverged from them on both sides of both endpoints.
`api/proto/mesh_control.proto` is a third definition and nothing uses it.

Options:

- Remove the server half and keep the types and the client (chosen).
- Complete the Go server. It would repeat in Go the work already done in Node
  (tenancy, revocation, rate limiting, heartbeat buffering), which is months of work to
  reach the current state.

## Decision

The server half is removed: the handlers, the registry, the address allocator,
`cmd/sovereign-control-plane`, and `api/proto/mesh_control.proto`.

The protocol types and the client stay in Go. The contract becomes a JSON Schema
generated from the Go structs into `api/contract/v4/`. The Node.js backend validates
every request against it with `ajv`, and validates responses in its tests. Renaming a
field on one side only fails CI.

## Consequences

- Until the removal lands, changes to the server half change unused code. The README of
  `pkg/control` says so.
- `make build` still builds `sovereign-control-plane` until it is removed, and the
  documentation does not present it as a control plane to run.
- `pkg/management` (the Prometheus endpoint) and part of `pkg/routing` are imported by
  the server half only. Their future is decided when the server is removed.
- The Go tests that exercise the server half are deleted with it. Tests of the client
  and of the types stay.
