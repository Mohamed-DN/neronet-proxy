# ADR 0008: WireGuard is the data plane transport

- Status: Accepted (reviewer's recommendation under delegated authority, 2026-09-19)
- Date: 2026-09-19
- Decision label: D2

The design, the measurements and the open questions are in
[ADR 0020](0020-data-plane.md). This record states the decision and its reasons; it
does not repeat that design.

## Context

There is no data plane in the default configuration. A node runs a local SOCKS5 and HTTP
proxy that dials targets directly. The overlay address the control plane assigns is not
configured on an interface, and the ACL policy the node loads is not applied to traffic.
The onion layer, NAT traversal, the DERP client and the Noise transport in `pkg/crypto`
are implemented and tested, and no running node uses them.

Two options exist for the tunnel between nodes:

- WireGuard through `wireguard-go`, with Rosenpass for a post-quantum pre-shared key.
  The protocol has formal audits and good performance, and the transport can be stated
  as "WireGuard" instead of asking for trust in an internal implementation. Onion
  routing is not expressible in plain WireGuard and stays a layer above it; that layer is
  where external review effort belongs.
- The internal Noise IKpsk2 transport in `pkg/crypto`. It is correct, but it is another
  implementation that needs external review. A nonce-reuse defect was found and fixed in
  the onion layer of the same package in September 2026.

## Decision

The tunnel between nodes is WireGuard through `wireguard-go`, in a userspace netstack
mode for unprivileged containers and a kernel TUN mode for hosts and virtual machines.
Post-quantum protection of the tunnel comes from Rosenpass supplying the pre-shared key,
later. The onion layer runs above the tunnel.

## Consequences

- The Noise transport in `pkg/crypto` (`noise.go`, `ratchet.go`, `replay.go`, `wire.go`)
  is code to retire; ADR 0020 records that nothing imports it. The retirement is a
  separate change.
- `wireguard-go` and gVisor are dependencies. ADR 0020 records their licences, which are
  compatible with AGPL-3.0.
- The spike (`pkg/dataplane`) is behind the node's `-dataplane` flag, off by default. Until
  a data plane is the default, documents say that none exists.
- Fail-static behaviour is part of the design: with the control plane down, existing
  tunnels keep the last valid netmap up to a configurable staleness limit, then remove
  all peers. Revocations apply as soon as they arrive.
