# `pkg/control`

This package contains two things with different status. Read this before changing
anything here: one half runs in every deployment, the other half is not run by any
compose file and is scheduled for removal.

The decision is recorded in
[ADR 0007](../../docs/adr/0007-remove-go-control-plane-server.md).

## The protocol types and the client: in use

`client.go` and the request and response structs in `server.go` define the wire
contract every Go node speaks. `cmd/sovereign-node` and `cmd/sovereign-cli` depend on
them. They stay.

**The struct tags are the contract.** A field renamed here changes the protocol. That is
not a theoretical concern: the Node.js bridge once invented its own field names on both
sides of both endpoints, and the result was a fleet that reported 47 registered nodes
against 7 telemetry rows, with every mismatch answering HTTP 200. See
`console/backend/routes/goBridge.js`.

The contract is to become a JSON Schema generated from these structs into
`api/contract/v4/`, validated by the Node.js backend on every request. Until that
exists, keep the tags and `goBridge.js` in step by hand, and change both in one commit.

## The server implementation: not deployed, to be removed

`server.go`'s handlers, `registry.go`, `vip.go` and `cmd/sovereign-control-plane`
implement a control plane that no compose file starts. `make build` still builds the
binary. It is not the control plane to run.

What serves `/v4/control/*` is the Node.js backend (`console/backend/routes/goBridge.js`),
reached through nginx. Go nodes point at `http://frontend:8443`, and nginx proxies
`/v4/` to `backend:8081`.

This matters because the code looks alive. A fix made here does not reach any
deployment.

What this half does not have:

- **Persistence.** `Registry` is a map behind a mutex, so every registered node is
  forgotten on restart.
- **Authentication.** It does not check the `auth_token` field of a registration.
- **Tenancy.** Nodes have no owner, so there is nothing to isolate.
- **Restart-safe addresses.** `VIPAllocator` keeps its cursor in memory. Without
  `Restore` being called for every existing node before serving traffic, a restart
  reassigns addresses that are already in use.

## Decision

ADR 0007 removes the server half (the handlers, `registry.go`, `vip.go`,
`cmd/sovereign-control-plane` and `api/proto/mesh_control.proto`) and keeps the types and
the client. The removal is not done yet. Until it is, treat changes to the server half
as changes to unused code, and do not add features to it.
