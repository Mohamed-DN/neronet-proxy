# `pkg/control`

This package contains two things with very different status. Read this before
changing anything here, because one half runs in production and the other half has
never been deployed at all.

## The protocol and client — in use

`client.go` and the request/response structs in `server.go` define the wire contract
every Go node speaks. `cmd/sovereign-node` and `cmd/sovereign-cli` depend on them.

**The struct tags are the contract.** A field renamed here changes the protocol. That
is not a theoretical concern: the Node.js bridge once invented its own field names on
both sides of both endpoints, and the result was a fleet that reported 47 registered
nodes against 7 telemetry rows, with every mismatch answering HTTP 200. See
`console/backend/routes/goBridge.js`.

## The server implementation — not deployed

`server.go`'s handlers, `registry.go` and `vip.go` implement a control plane that
**no compose file starts**. `cmd/sovereign-control-plane` is built by `make build`
and then nothing runs it.

What actually serves `/v4/control/register` and `/v4/control/heartbeat` is the
Node.js backend, reached through nginx. Go nodes point at `http://frontend:8443`,
nginx proxies `/v4/` to `backend:8081`.

This matters because the code looks alive. Someone could fix a bug here and believe
they had fixed production. They would not have.

### What this half does not have

- **No persistence.** `Registry` is a map behind a mutex. Every registered node is
  forgotten on restart.
- **No authentication.** The Node.js bridge requires an enrolment token; this does
  not.
- **No tenancy.** Nodes have no owner, so there is nothing to isolate.
- `VIPAllocator` keeps its cursor in memory. Without `Restore` being called for every
  existing node before serving traffic, a restart reassigns addresses that are
  already in use.

### If you are deciding what to do with it

Two implementations of the same control plane is one too many, and today the
duplication is invisible because only one of them runs. The choice is between
completing this one — persistence, authentication, tenancy, roughly the work already
done on the Node.js side — or removing the server half and keeping this package as
the protocol definition and client it is genuinely used for.

That decision is tracked in `docs/PIANO_ESECUTIVO.md`. Until it is made, treat
changes to the server half as changes to unused code.
