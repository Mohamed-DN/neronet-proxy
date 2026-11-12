# ADR 0032: Exit nodes for profile devices, phase 1

**Status:** Accepted (phase 1)
**Date:** 2026-11-12
**Deciders:** owner (Mohamed), lead engineer

## Context

A phone that joins through the profile gateway (ADR 0029) with the stock WireGuard app reaches
the overlay only (`AllowedIPs = 100.64.0.0/10`). The owner wants what Tailscale calls an exit
node: the phone sends all its internet traffic through a place the user or an administrator
chose, the owner's home connection (the gateway) or a mesh node marked as an exit.

Constraints: the gateway runs the userspace netstack with no capabilities
(`docker-compose.gateway.yml`), so kernel forwarding and NAT are not available; the phone runs
a client that enforces nothing; and an exit that is down must never turn into a direct path.

## Decision

### Control plane

- `nodes.exit_node_id` on a profile device names its exit; `nodes.exit_allow_lan` (admin only)
  lets it reach the exit's private networks. An exit is a mesh node of the same organisation
  registered as `EXIT_BRIDGE` or `HYBRID`, which a node is only when its operator started it
  with `-enable-exit`. The gateway is an exit on the same terms.
- Who may choose: administrators always; the device's owner when
  `organizations.exit_self_service` is on. `ExitService.mayChooseExit` is the one hook ADR
  0030's `devices.exit.set` replaces.
- API: `GET /api/devices/exits`, `PUT /api/devices/exit-policy`, `PUT /api/devices/:id/exit`,
  and `exit_node_id` on `POST /api/devices/profile`, which then answers
  `allowed_ips: ["0.0.0.0/0", "::/0"]` and `dns: ["100.100.100.100"]`.
- Netmap: the gateway's device entry carries `exit` (`via: self` or `via: mesh` + node id) and
  the device's internet rules (enabled ACL rules whose source covers the device and whose
  destination reaches outside the overlay, in priority order). The gateway holds the one mesh
  exit with `0.0.0.0/0, ::/0`; that exit gets `exit_clients` and routes the devices back to
  the gateway. `100.100.100.100` is never allocated to a node.

### Data plane (`pkg/dataplane/egress.go`, `egress_stack.go`)

In the tun wrapper, before forwarding: a decrypted packet from an exit client to a non-overlay
address (or to `100.100.100.100:53`) is checked and then

- **local** (this node is the exit): injected into a second gVisor stack of our own,
  promiscuous and spoofing, whose TCP and UDP forwarders dial the destination from the host
  (Tailscale's userspace exit design). Replies are queued back to wireguard-go. DNS to
  `100.100.100.100:53` goes to the exit host's resolver (`SOVEREIGN_EXIT_DNS` or
  `/etc/resolv.conf`).
- **mesh**: relayed inside WireGuard to the default-route holder; a small conntrack lets only
  replies to the client's own flows back.
- **none**: dropped and counted. No fallback, ever.

Checks, in order: fragments and anything but TCP/UDP dropped; RFC 1918, CGNAT/overlay and ULA
dropped unless `allow_lan`; loopback, link-local (169.254.169.254 included) and multicast
always dropped; then the internet rules, first match, no match accepts (the assignment is the
grant). The mesh exit repeats every check. A node without `-enable-exit` never dials.

## Consequences and limits (phase 1)

- One mesh exit per gateway: WireGuard routes by destination, so a device that chose a second
  mesh exit has no usable exit and its internet traffic is dropped.
- No ICMP through an exit (ping fails); no IPv6 egress beyond what the exit host has.
- Abuse and legal: traffic leaves with the exit operator's address, and the operator can see
  destinations. Consent is the `-enable-exit` flag; every exit assignment is audited. Phase 2:
  per-exit allow lists, rate limits, abuse-port blocking (`pkg/bridge/sandbox.go` already has a
  list), and an exit picker in our Android app; a phone as an exit needs the v1 mesh client.
