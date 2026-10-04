# ADR 0022: One WireGuard session over modular, selectable transports

- Status: Accepted
- Date: 2026-10-05
- Deciders: project owner, technical lead
- Builds on: [ADR 0008](0008-wireguard-data-plane-transport.md), [ADR 0015](0015-high-risk-features-on-by-default.md),
  [ADR 0020](0020-data-plane.md); design notes in [ROADMAP section 14](../ROADMAP.md)

## Context

The owner wants "the best of the best, and modular": WireGuard's speed, OpenVPN's reach
through firewalls and proxies (TCP, port 443), and the resistance of VLESS + REALITY to
deep packet inspection and active probing, with each capability something a customer can
switch on in full, in part, or not at all.

What exists today, verified in code and on the running stack:

- WireGuard (wireguard-go, netstack or TUN) carries all traffic; a 13-node overlay
  measures 30 of 30 pairs.
- `pkg/dataplane/stealth` implements AmneziaWG-style obfuscation and a `TransportManager`,
  with tests. No node sets `Stealth` or `TransportMgr`, so neither is ever active.
- A DERP fallback is wired into the node; the relayed path has not been measured.
- "openvpn" and "vless" exist only as names. The topology's per-link "mode" comes from
  `mesh_link_configs`, which nothing in the data plane reads.

Banks and public administration (ADR 0006) will usually forbid traffic disguised as
something else, while a journalist's deployment needs exactly that. One build has to serve
both, and the choice must be enforced, not only displayed.

## Options considered

### A. WireGuard as the only cryptography, transports underneath it (chosen)

Transports carry WireGuard's already-encrypted packets through `conn.Bind`.

| Dimension | Assessment |
|---|---|
| Complexity | Medium: one interface, one module per transport |
| Security | Unchanged cryptography; a transport bug can break reachability, not confidentiality |
| Modularity | Natural: each transport is a module that can be absent |
| Effort | Incremental; each module ships on its own |

### B. Run three VPN stacks side by side (WireGuard, OpenVPN, Xray/VLESS)

| Dimension | Assessment |
|---|---|
| Complexity | High: three key systems, three policy engines, three sets of routes |
| Security | Three attack surfaces; ACL, compartments and revocation re-implemented three times or bypassed |
| Modularity | Coarse: a whole stack on or off |
| Effort | High, and permanent |

### C. A new protocol merging the three handshakes

| Dimension | Assessment |
|---|---|
| Complexity | Very high |
| Security | A new, unreviewed cryptographic protocol. ROADMAP 7.1 records what happened the last time: the in-house onion layer reused nonces |
| Modularity | None |
| Effort | Open-ended, and it needs external cryptographic review before anyone may trust it |

## Decision

**Option A.** WireGuard stays the only cryptographic protocol. A transport moves WireGuard
packets and nothing else; it never sees plaintext and never replaces a WireGuard key.

### Transports

| Name | What the network sees | Use |
|---|---|---|
| `udp` | WireGuard on UDP | Default, fastest |
| `obfs` | Randomised UDP with junk packets, no WireGuard header (AmneziaWG-style), parameters per organisation | Networks that drop WireGuard by signature |
| `quic` | QUIC datagrams (RFC 9221) on UDP 443 | Networks that only pass web ports; no TCP-over-TCP |
| `tls` | TLS 1.3 on TCP 443, REALITY-style: a browser-like client hello, the client authenticated by a key hidden in the handshake, any other connection (a probe) forwarded to a real website | Only TCP 443 open, active probing, HTTP `CONNECT` proxies |
| `derp` | HTTPS to a relay | Last resort when no direct path exists |

### The four switches

1. **Build.** Each transport is a package registered through a registry at init, behind a
   build tag (`notransport_obfs`, `notransport_quic`, `notransport_tls`). A customer who
   must not ship disguise code compiles it out; the binary reports what it contains.
   `udp` and `derp` are always built.
2. **Deployment.** `SOVEREIGN_TRANSPORTS` on the control plane names the transports this
   installation offers. It is the ceiling for everything below.
3. **Organisation.** `organizations.allowed_transports`, edited in the console, a subset
   of the deployment's. Presets: *Regulated* (`udp`, `derp`), *Resilient* (adds `quic`),
   *Censorship-resistant* (all). Changing it advances the ACL epoch.
4. **Node.** A node reports the transports it was built with and can listen on. The
   netmap offers, per peer, the intersection of the organisation's list with what both
   nodes support, each with its endpoint and parameters.

A transport the policy does not allow is never used, not even as a fallback: if no
allowed transport reaches a peer, there is no path, and the console says why.

### Selection

The node listens on every allowed transport at once and accepts WireGuard packets from
any of them. To send, it tries the allowed transports in order (`udp`, `obfs`, `quic`,
`tls`, `derp`), starting the next one if the previous has not completed a WireGuard
handshake within a short delay (happy-eyeballs). It keeps the first that works and probes
the faster ones again in the background. An endpoint names its transport
(`quic://203.0.113.7:443`), so WireGuard's roaming works within and across transports.

### Reporting

Each heartbeat carries, per peer, the transport in use and the age of the last handshake.
The topology draws that, measured, and `mesh_link_configs` stops deciding a link's mode.

## Trade-off analysis

Option A gives up nothing the owner asked for. "OpenVPN's reach" and "VLESS's
resistance" are properties of how packets travel, not of their cryptography, and the
transports reproduce them. What it costs:

- `tls` and `derp` put tunnelled TCP inside TCP, which stalls under loss. They are
  fallbacks, never defaults; `quic` exists to cover port 443 without that cost.
- Disguise is an arms race. TLS fingerprints, packet sizes and timing need maintenance,
  and an unmaintained disguise becomes a fingerprint. Each disguise module is owned and
  re-tested against current DPI behaviour on a schedule.
- Every module is more code on the node. Build tags keep it out of builds that do not
  want it, which is also what keeps regulated builds reviewable.

## Consequences

- A customer can run plain WireGuard only, or everything, from the same source tree, and
  the choice is enforced on the node, not just shown.
- ACLs, compartments (ADR 0021), revocation and quarantine apply unchanged, whatever the
  transport: they act on WireGuard peers.
- Ports: UDP 51820 (`udp`, `obfs`), UDP 443 (`quic`), TCP 443 (`tls`) on nodes that offer
  them. The console stays on its own port.
- `tls` needs a real website to forward probes to, chosen per deployment.
- Licences: `quic-go` (MIT), `utls` (BSD-3), REALITY (MPL-2.0, a check against
  AGPL-3.0 before reuse; a clean reimplementation is the fallback).
- Every module ships with an overlay scenario that blocks what it is meant to pass, and
  fails without it:
  - `udp` blocked between nodes: traffic still flows (through `derp` or another module);
  - WireGuard's handshake dropped by its signature (type 1, 148 bytes): `obfs` passes;
  - only UDP 443 open: `quic` passes;
  - only TCP 443 open: `tls` passes, and a probe without the key gets the real site;
  - a transport removed from the organisation's list: it is never seen on the wire.
- "Stable" is declared only after an external review of the transport layer.

## Action items

1. [ ] T0: transport registry and multiplexing `conn.Bind`; endpoints that name their
   transport; `udp` and `derp` behind it; policy plumbing (deployment, organisation,
   node, netmap); per-peer transport in heartbeats. Scenario: UDP blocked, traffic flows.
2. [ ] T1: `obfs` from `pkg/dataplane/stealth`, parameters per organisation in the netmap.
   Scenario: WireGuard handshake dropped by signature.
3. [ ] T2: `quic` (RFC 9221 datagrams on UDP 443). Scenario: only UDP 443 open.
4. [ ] T3: `tls` REALITY-style. Scenario: only TCP 443 open; probe gets the real site.
5. [ ] T4: console: transport presets per organisation, measured transport per link.
6. [ ] T5: external review; then mark the layer stable in the handbook.
