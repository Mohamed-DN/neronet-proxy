# ADR 0008: WireGuard is the data plane transport

- Status: Accepted (reviewer's recommendation under delegated authority, 2026-09-19)
- Date: 2026-09-19
- Decision label: D2

## Context

There is no data plane. A node runs a local SOCKS5 and HTTP proxy that dials targets
directly. The overlay address the control plane assigns is not configured on any
interface, and the ACL policy the node loads is not applied to traffic. The onion
layer, NAT traversal, the DERP relay client and the Noise transport in `pkg/crypto`
are implemented and tested, and no running path uses them.

Two options exist for the tunnel between nodes:

- WireGuard through `wireguard-go`, with Rosenpass for a post-quantum pre-shared key.
  The protocol has formal audits and good performance, and the transport can be stated
  as "WireGuard" instead of asking for trust in an internal implementation. Onion
  routing is not expressible in plain WireGuard and stays a layer above it; that layer
  is where external review effort belongs.
- The internal Noise IKpsk2 transport in `pkg/crypto`. It is correct, but it is another
  implementation that needs external review. A nonce-reuse defect was found and fixed in
  the onion layer of the same package in September 2026.

## Decision

WireGuard through `wireguard-go`, in two modes:

- Kernel or TUN device, where the node has `CAP_NET_ADMIN` and `/dev/net/tun`
  (hosts and virtual machines).
- Userspace netstack (gVisor `tun/netstack`), without privileges. This is the mode of
  the unprivileged containers (uid 10001). The existing SOCKS5 and HTTP proxies dial
  inside the overlay through the netstack.

The node's static X25519 identity key is its WireGuard key. Addresses are
`100.64.0.0/10` and `fd7a:115c:a1e0::/48`, which the control plane already allocates.
The control plane delivers a versioned netmap per node with the peers the policy allows,
their `AllowedIPs`, endpoints and relay regions. Enforcement is default-deny in
`pkg/acl` on the receiving node, with an outbound filter as defence in depth.

Connectivity order: direct between known endpoints, STUN for the public endpoint,
DERP as fallback and starting channel. Post-quantum protection of the tunnel comes from
Rosenpass supplying the pre-shared key, later. The onion layer runs above the tunnel:
fixed 1420-byte cells over TCP between overlay addresses.

## Consequences

- The Noise transport in `pkg/crypto` (`noise.go`, `ratchet.go`, `replay.go`,
  `wire.go`) is code to retire if no path uses it. The data plane ADR of the
  implementing change decides, with the fate of the DERP client.
- New dependencies: `wireguard-go` and gVisor. Their licences must be checked for
  compatibility with AGPL-3.0 in the change that adds them.
- Until this is implemented, the documentation states that no data plane exists.
- Fail-static behaviour is part of the design: with the control plane down, existing
  tunnels keep the last valid netmap up to a configurable staleness limit, then remove
  all peers. Revocations apply as soon as they arrive.
