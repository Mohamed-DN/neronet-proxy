# 20. Data plane: WireGuard via wireguard-go

Date: 2026-09-19
Status: proposed
Decision record for: D2

## Context

There is no data plane. A node runs a local SOCKS5 and HTTP CONNECT proxy whose
bridge dials targets directly (`pkg/bridge/netstack.go`). The overlay address the
control plane assigns is configured nowhere: inside the node container there is only
`lo` and `eth0`, and `100.64.0.0/10` is on the egress sandbox's bogon list, so a
request for an overlay address is rejected rather than routed. The compiled ACL
policy the node downloads on every epoch change is held in memory and applied to no
packet. `pkg/routing` (onion), `pkg/nat`, `pkg/derp` and the Noise transport in
`pkg/crypto` are tested but no running path reaches them.

The product needs an overlay between the fleet nodes: encrypted node to node
transport, addressing on the assigned virtual IPs, enforcement of the policy the
control plane compiles, and a place for the onion layer and the relay to attach.

This record states how that is built and what the WP-201 spike measured.

## Decision

The transport is **WireGuard**, in the **wireguard-go** userspace implementation,
in two modes. The spike code is `pkg/dataplane`, off unless `-dataplane` names a
mode.

### 1. Transport and modes

`golang.zx2c4.com/wireguard v0.0.0-20260522210424-ecfc5a8d5446` (MIT), which now
carries the gVisor netstack backend in its main module, with
`gvisor.dev/gvisor v0.0.0-20250503011706-39ed1f5ac29c` (Apache-2.0) as a transitive
dependency. Both licences are compatible with AGPL-3.0.

The separate module `golang.zx2c4.com/wireguard/tun/netstack` must **not** be
required: it provides the same import path as the main module and the build fails
with an ambiguous import.

| Mode | Stack | Privileges | Used for |
|---|---|---|---|
| `netstack` | gVisor in the node process | none | containers, the staging fleet (uid 10001, `--cap-drop ALL`) |
| `tun` | kernel TUN interface | `/dev/net/tun` and `CAP_NET_ADMIN` | hosts, virtual machines, gateways that must route for others |
| `off` | none | none | default |

In `netstack` mode the IP stack lives inside the process: only the node reaches the
overlay, and it does so through `Device.DialContext` and `Device.Listen`. In `tun`
mode the interface belongs to the kernel, so every process in the namespace sees the
overlay and ordinary routing applies; this is the mode a node needs when it
advertises subnet routes for others.

`tun` mode configures the interface through iproute2 rather than raw netlink. The
question the spike had to answer was whether the capability is available at all; a
netlink dependency bought before that answer would have been bought blind. If `tun`
mode becomes a supported deployment, netlink replaces the three `ip` calls.

### 2. Keys

The WireGuard static key is the node's existing X25519 identity key
(`crypto.Keypair`, already clamped at generation, persisted at
`SOVEREIGN_NODE_KEY_PATH`). A peer's WireGuard public key is therefore the public
key the control plane already stores and the console already shows, hex encoded. No
second key hierarchy, and no key material added to the netmap that is not already in
the database.

### 3. Enforcement

`pkg/acl` plugs into the packet path through a wrapper around the `tun.Device`
(`dataplane.filteredTUN`), which both modes go through:

- the wrapper's `Read` is the outbound direction, before encryption. A rejected
  packet is removed from the batch and is never encrypted;
- the wrapper's `Write` is the inbound direction, after decryption and after
  wireguard-go has already checked the source against the peer's `AllowedIPs`. A
  rejected packet never reaches the local stack.

This is the only point where the plaintext of both directions passes through one
place, and it is the same code for `netstack` and `tun`.

`dataplane.ACLFilter` maps a parsed packet onto `acl.NetstackFilter`:
`EvaluateOutbound4Tuple` on the way out, `EvaluateInbound` on the way in, which
already consults the conntrack table so the answer to an allowed connection is not
dropped on an ephemeral port no rule names.

Direction of authority, as the architecture states: the **receiving** node's filter
decides, and the sender's filter repeats the check as defence in depth. A node with
a stale or tampered policy still cannot emit what it is not entitled to, and a node
that is lied to still refuses what its own policy denies.

Default deny is the behaviour of `pkg/acl` with no policy loaded: every packet is
dropped. That is correct and it is why the spike leaves enforcement off (a flag in
the spike document) while measuring the transport. Wiring enforcement on by default,
with the organisation's `default_policy` deciding what a node does before its first
netmap arrives, belongs to the enforcement work package.

A packet whose header cannot be parsed is dropped and counted, never forwarded. The
parser does not walk IPv6 extension headers; a packet carrying them arrives with no
ports, which default deny rejects. Guessing zero ports for a header chain nobody
parsed would be an invented value.

### 4. How peers are delivered

WP-201 read peers from a file (`-spike-peers`). WP-202 replaced that file with a
control plane document, `POST /v4/control/netmap`, and this section now records what
was built rather than what was proposed. The shape was the proposal and it did not
change:

- **one complete document per node**, versioned. Peers are replaced, not merged: a
  peer the control plane stopped sending is a peer the node must stop talking to,
  and an incremental feed cannot express that. `Device.SetPeers` sends
  `replace_peers=true` plus the whole set in one UAPI operation;
- **validated before applied**. The whole document is checked first, so a malformed
  entry leaves the previous peers in place instead of tearing the overlay down
  halfway through;
- per peer: public key, `AllowedIPs` (the VIP /32 and /128, plus advertised subnets
  the policy grants), known endpoints, DERP region, optional preshared key;
- the control plane includes only peers the compiled policy permits traffic with in
  at least one direction. A node does not learn of nodes it cannot reach;
- **fail-static**: if the control plane is unreachable the node keeps the last valid
  netmap. Past `max_netmap_staleness` (default 24 h, per organisation) it removes
  every peer: fail-closed. Revocations apply immediately and always. `SetPeers` is
  the single call that implements both, because both are "here is the complete set
  now".

#### 4.1 The contract, as built

`POST /v4/control/netmap`, authenticated like `/v4/control/sync-acls`.

Request `{node_id, version}`, where `version` is what the node holds and 0 means none.
Response `{version, unchanged, self, peers, acl, routes, revoked_keys,
generated_at_unix, max_staleness_seconds}`; when the version matches, `unchanged` is
true and nothing else is sent.

- `self` is `{overlay_ipv4, overlay_ipv6, mtu, listen_port}`.
- `peers[]` is `{node_id, public_key_hex, allowed_ips[], endpoints[], derp_region,
  keepalive_seconds}`. `public_key_hex` is the peer's X25519 identity key, which is
  also its WireGuard key. `derp_region` is null: no column records one and nothing
  measures one.
- The heartbeat response carries `netmap_version` and the heartbeat request carries
  the node's candidate `endpoints`.

Three decisions the card fixed, and what they mean here:

1. **Default deny before the first netmap.** A node with the data plane on installs
   the ACL filter from the first packet. `pkg/acl` with no policy loaded drops
   everything, so nothing moves until a netmap arrives. The organisation's
   `default_policy` decides what the control plane *compiles into* the netmap, never
   what a node does on its own.
2. **One version per node.** The netmap version replaces the policy and route epochs
   on the node side. The control plane still keeps both internally — they are what
   `/v4/control/sync-acls` and `/v4/control/sync-routes` answer for a node running
   without the data plane — and anything that moves either of them moves the netmap
   version too.
3. **The overlay MTU is a configured constant, default 1380**, leaving room for a DERP
   frame header inside a 1500 byte path. Onion cells stay 1420 bytes as *logical units
   on a TCP stream*: TCP segments them, so the overlay MTU does not constrain them and
   no wire-level packet-size uniformity is claimed anywhere. This closes open question
   2 below.

**Determinism.** Peers are sorted by node id, allowed IPs by family then address,
endpoints lexicographically, and every object is built with a fixed key order, so two
builds from the same database state serialise to identical bytes. Without that an
unchanged version would not mean unchanged.

**Peer inclusion reads the policy the way the filter does.** `pkg/acl` takes the first
matching entry in order, so "an ACCEPT exists for this peer" is not the test: a peer
denied on one port and allowed on the rest is a peer, and a peer whose every entry is a
DROP is not, however permissive a later rule is. Getting this wrong in the permissive
direction hands a node the key of a peer the operator forbade.

**The version is global, not per node.** It is the `netmap` row of `mesh_epochs`. A
global counter can only over-signal — a node re-fetches a document it finds identical —
and never under-signal, and under-signalling is the failure that leaves a revoked peer
reachable. Endpoint changes are debounced to one version bump per node per 30 s, so an
endpoint that flaps cannot make the whole fleet re-fetch on every heartbeat; the
endpoints themselves are stored on every beat.

#### 4.2 What the netmap endpoint does not authenticate

It is authenticated by the fleet-wide enrolment token, exactly like `/v4/control/
sync-acls` and `/v4/control/sync-routes`. That token does not bind a request to a node,
so **any node holding it can read any other node's netmap**, which means any node can
obtain the peer key and endpoint set of any other. The peer sets it serves are still
compiled per node, so this is a confidentiality limit on who may *read* a netmap, not a
hole in what a node may *reach*: the receiving node's filter still decides.

Closing it is WP-103's (per-node credentials, proof of possession of the identity key).
Until then the limitation is stated here rather than implied by the absence of a test.

### 5. NAT traversal and DERP

Direct endpoints are enough for the compose fleet and are what the spike used.
Beyond it:

1. `pkg/nat` discovers the public endpoint over STUN; the node reports it in the
   heartbeat and the control plane puts it in the peers' netmaps.
2. A relay path attaches to wireguard-go through a custom `conn.Bind`. wireguard-go
   takes the `conn.Bind` as a constructor argument, so a bind that keeps the UDP
   socket and, per peer endpoint, can send and receive through a DERP session is the
   whole integration: no change to the device, the filter or the netmap format.
3. `pkg/derp` needs, for that bind: an endpoint type carrying a peer public key
   instead of a UDP address, a receive path that delivers frames into the bind's
   receive functions, and reconnection with backoff. Today `derp.Client` speaks
   frames over a WebSocket with a `PacketHandler` callback, which is the right shape
   but not yet a `conn.Bind`.
4. Start on the relay and move to direct when direct works, as the architecture
   says; coordinated hole punching (`pkg/nat` already has the pieces) only if the
   measurements justify it.

The spike did not implement the bind. It is the largest single unknown left.

### 6. Onion layer

Unchanged in placement by this record, and now with somewhere to sit:

- the control plane chooses the path (`/v4/control/circuit`);
- the client builds the circuit with `pkg/routing`: ephemeral key per hop,
  XChaCha20-Poly1305 per layer, fixed 1420 byte cells;
- **cells travel over TCP between overlay addresses**, on a dedicated onion port.
  Each leg is therefore also inside WireGuard. In `netstack` mode that is
  `Device.Listen` on the onion port and `Device.DialContext` to the next hop: the
  same API the spike's responder and the SOCKS5 path use;
- the node process terminates the hop it is. There is no separate relay process on
  the overlay path;
- the exit egresses through the existing bridge sandbox (no RFC 1918, per-exit
  policy), which is the code that already exists in `pkg/bridge`;
- per-node activation arrives in the netmap.

The cell size and the overlay MTU do not in fact interact, and WP-202 settled it: a
cell is a logical unit on a TCP stream, and TCP segments it against whatever the path
MTU is. A 1420 byte cell crossing a 1380 byte overlay becomes two segments, which costs
one extra packet per cell and nothing else. What would have been affected is a claim
that every packet on the wire is the same size, and no such claim is made anywhere.

### 7. Post-quantum (Rosenpass)

WireGuard's preshared key slot is the injection point. `dataplane.Peer` already
carries `PresharedKey` and `SetPeers` applies it, so the transport side is done and
untested. What is missing is the Rosenpass exchange itself and the rotation: the
architecture asks for a fresh PSK every two minutes, which means calling `SetPeers`
(or a narrower per-peer update) on a timer with the key the Rosenpass session
produced. Rotation at that rate argues for adding a per-peer update path so that a
PSK change does not rewrite the whole peer set. Not in this work package.

### 8. What becomes dead code

- **The Noise transport in `pkg/crypto`** (`noise.go`, `ratchet.go`, `replay.go`,
  `wire.go`). WireGuard brings its own Noise IK handshake, its own replay window and
  its own rekeying. Nothing in `pkg/` or `cmd/` imports these files today, so they
  are already unreachable; WireGuard removes the last reason to keep them.
  `chacha.go`, `xchacha.go` and `x25519.go` stay: the onion layer and the identity
  key use them.
- **`pkg/ebpf`**: imported by nothing.
- **`cmd/sovereign-relay`**: duplicates `cmd/sovereign-derp-relay`.

Retirement is WP-208, not this work package. Nothing is removed here.

## Alternatives considered

**Keep the in-house Noise transport in `pkg/crypto`.** It is tested at the unit
level and it is ours. Rejected: it is a hand-written transport protocol with no
external review, no formal analysis and no interoperability, in a product sold to
banks and public administration. It also has no data plane around it: choosing it
would mean writing the device, the peer table, the allowed-IP routing, the
rekeying timers and the replay handling that WireGuard already has, and then
convincing a bank's reviewer that all of it is right.

**Kernel WireGuard only (`wg` / `wg-quick`).** Faster (see the numbers below) and
already in every recent kernel. Rejected as the only mode: it needs `CAP_NET_ADMIN`
and `/dev/net/tun`, which the container deployment is specifically meant not to
require, and it cannot run on a node that is a plain unprivileged process. It stays
available as `tun` mode, which is the same wireguard-go code with a kernel
interface, so nothing is lost by not adding a third implementation.

**boringtun.** A Rust userspace WireGuard. Rejected: it would add a second language
and a cgo or subprocess boundary to a Go code base, for an implementation with a
smaller userspace-stack story than wireguard-go's netstack. wireguard-go is by the
protocol's authors and is what its netstack mode was written for.

## Spike results, 2026-09-19

Reproduced with `scripts/dev/dataplane-spike-lab.sh`. Two containers on a private
Podman network (10.89.201.0/24), overlay `100.64.0.1` and `100.64.0.2`, one
WireGuard peer each, measured from node A through node A's own SOCKS5 proxy against
the spike responder on node B. Host: Windows 11, Podman 6.0.2 rootless, WSL2 machine
with 8 CPUs.

| | `netstack`, uid 10001, `--cap-drop ALL` | `tun`, uid 10001, `--device /dev/net/tun --cap-add NET_ADMIN` |
|---|---|---|
| TCP round trip through the overlay (50 samples) | median 0.389 ms, p95 0.668 ms, max 1.045 ms | median 0.451 ms, p95 0.561 ms, max 0.735 ms |
| ICMP through the overlay, idle | 0.49 ms (netstack ping) | not measured: `ping` needs `CAP_NET_RAW`, not granted |
| Send throughput, 30 s, counted by the receiver | 2.34 GiB = **670 Mbit/s** | 32.55 GiB = **9321 Mbit/s** |
| Receive throughput, 30 s | 2.18 GiB = **624 Mbit/s** | 24.33 GiB = **6967 Mbit/s** |
| Node process CPU over the measurement (62-63 s) | A 154 s, B 146 s (≈240% of one core each) | A 220 s, B 219 s (≈355% of one core each) |
| Node process RSS after the transfer | A 55 MB, B 192 MB | A 386 MB, B 449 MB |
| Node process RSS at rest | 15-16 MB | 14-16 MB |

Both figures are loopback-class: the traffic never leaves the WSL virtual machine,
so they are an upper bound on the software, not a network measurement. The ratio is
the finding: **the userspace stack costs roughly an order of magnitude of
throughput** against a kernel interface, at the same latency.

670 Mbit/s is ample for the management and onion traffic this product carries. It is
not ample for a node acting as a subnet gateway for a busy site, which is the case
where `tun` mode earns its capabilities.

The ICMP probe through the netstack rises from 0.49 ms at rest to 18-25 ms during
the throughput flood: the gVisor stack is a single queue and the probe waits behind
the transfer. Latency under load is a userspace-stack property to state in the
product documentation, not a defect.

RSS is the other cost: node B holds 192 MB after a 2.3 GiB transfer in netstack mode
and 449 MB in tun mode, against 15 MB at rest. This is buffer retention, not a leak
(the process was still running when it was measured), but a node with a memory limit
needs that headroom.

**Capture.** `tcpdump -i eth0` in a sidecar sharing node B's network namespace, over
the marker exchange and the latency phase, 224 packets captured and 0 dropped by the
kernel: 222 UDP datagrams between `10.89.201.11:51820` and `10.89.201.12:51820`, 2
ARP frames, **0 TCP segments**. A 34 byte marker string sent through the overlay and
echoed back does not appear anywhere in the raw capture file. The tun-mode capture
is the same shape: 240 packets, 0 dropped, only UDP 51820 and ARP, marker absent.

One caveat worth recording: the same capture taken with `tcpdump -i any` in tun mode
**does** show the plaintext, because `any` includes the node's own `nero0` interface,
where the traffic is by definition already decrypted. That is true of every
WireGuard deployment and is exactly why the enforcement filter sits where it does.

**Rootless Podman and `tun` mode: it works.** `--device /dev/net/tun --cap-add
NET_ADMIN` is enough, and it is enough **for uid 10001**, not only for root: Podman
raises the added capability into the ambient set, so the unprivileged user holds
`CAP_NET_ADMIN` effectively (`CapEff: 0000000000001000`) and `tun.CreateTUN`
succeeds. Node A came up with `nero0` carrying `100.64.0.1/10` and a connected route
for `100.64.0.0/10`. `CAP_NET_RAW` is a separate grant and was not given, which is
why `ping` inside the container could not run.

## Consequences

- Two new dependencies, both permissively licensed and both actively maintained, one
  of them large (gVisor). The binary grows and the gVisor stack is a substantial
  amount of code inside the node process.
- The node gains a second IP stack in `netstack` mode. Anything that wants to reach
  the overlay has to go through `pkg/dataplane`; it cannot use `net.Dial`. The
  SOCKS5 and HTTP proxies do this through the bridge's overlay dialer.
- `pkg/bridge` now sends `100.64.0.0/10` and `fd7a:115c:a1e0::/48` destinations
  through the overlay and skips the egress sandbox for them. The sandbox lists those
  ranges as bogons because reaching them over the host's interfaces would be a leak;
  inside the tunnel they are the mesh, and what a peer may reach there is decided by
  the ACL filter on the packets. With no data plane attached the old behaviour is
  unchanged: the destination is rejected as a bogon.
- Throughput in the default container mode is bounded by the userspace stack at
  around 700 Mbit/s per node on this hardware, and memory use after large transfers
  is in the hundreds of megabytes.
- Onion cells and the DERP relay both have a defined attachment point, and neither
  is implemented.

## Risks and open questions

1. **The DERP `conn.Bind` is unproven.** It is the largest remaining unknown and the
   difference between a mesh that works between known endpoints and one that works
   between real networks.
2. **Onion cell size against the overlay MTU — closed by WP-202.** The overlay MTU is
   a configured constant, default 1380, and cells stay 1420 bytes as logical units on
   a TCP stream. See section 4.1, decision 3.
3. **Enforcement has not been measured with a policy loaded.** The filter is on the
   packet path and tested, but the throughput figures above were taken with it off.
   The per-packet cost of `pkg/acl` at 700 Mbit/s is not known.
4. **Memory retention.** Hundreds of megabytes of RSS after a large transfer needs a
   limit or a buffer policy before a node runs on a small appliance.
5. **`tun` mode configuration through iproute2** means the node image must carry it
   and the node shells out. Acceptable for a spike, not for a shipped mode.
6. **No MTU discovery.** The MTU is a configured constant. A path that cannot carry
   1420 + 60 bytes will black-hole large packets.
7. **Keys at rest.** The WireGuard private key is the identity key, which is a file
   on disk with mode 0600 and no passphrase. Unchanged by this record, but the data
   plane makes it a tunnel key as well as an identity, which raises what its
   compromise costs.
8. **This is a spike.** The measurements are from one machine, one run per mode, on
   loopback-class networking, with one peer per node. Nothing here has been measured
   at the fleet's six nodes, with contention, or across a real network.
