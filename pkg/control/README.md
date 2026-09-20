# `pkg/control`

This package defines the node-to-control-plane wire protocol and client for NeroNet.

The architectural decision is recorded in
[ADR 0007](../../docs/adr/0007-remove-go-control-plane-server.md) and implemented in **WP-102**.

## Protocol Types and Client

- `types.go`: Canonical Go request and response structs for all endpoints under `/v4/control/*`, descriptors (`EndpointDesc`, `CapabilityDesc`, `RelayDesc`, `NetmapSelf`, `NetmapPeer`), and node ID derivation (`GenerateNodeID`).
- `client.go`: HTTP client used by `cmd/sovereign-node` and `cmd/sovereign-cli` to communicate with the control plane.
- `netmap.go`: Client method for netmap delivery (`Client.Netmap`).

**The struct tags are the contract.**

The wire contract is compiled into JSON Schema (Draft 2020-12) files stored in `api/contract/v4/*.schema.json` via the generator in `cmd/contractgen`. The Node.js control plane backend (`console/backend/routes/goBridge.js`) compiles these schemas at startup with Ajv in strict mode, validating incoming requests and responding with HTTP 400 with the failing JSON pointer on any schema mismatch.

## Server Half Retirement

Per ADR 0007 (WP-102), the dead in-memory Go control plane server (`server.go`, `registry.go`, `vip.go`, `cmd/sovereign-control-plane`, and `api/proto/`) has been completely removed. The authoritative control plane server is the Node.js backend (`console/backend/routes/goBridge.js`).
