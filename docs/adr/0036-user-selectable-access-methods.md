# ADR 0036: Access methods the user can choose, starting with AmneziaWG

Status: accepted. 18 November 2026.

## Context

A profile device (a phone or computer with a stock app) reaches the network through the profile
gateway (ADR 0029). Today it can do so in two ways: plain WireGuard over UDP, and WireGuard inside
a WebSocket on TCP 443 for networks that block UDP (`docker-compose.wss.yml`, in production since
12 November). AmneziaWG exists only as a label and an unused sketch: `pkg/dataplane/stealth` with
fixed header constants (fingerprintable), no `amneziawg-go` dependency, no parameter generation,
and the console stores `transport = amneziawg` without anything using it. The owner wants the
person adding a device to choose among open-source protocols, and AmneziaWG to really work.

## Decision

1. **Access method is a property of each profile device**, chosen in the add-device flow among the
   methods that are both *allowed by the organisation* (same ceiling pattern as
   `allowed_transports`) and *advertised by the device's gateway* (node capabilities in the
   netmap). A method that is not allowed is never started on the gateway.
2. Methods, in order of delivery:
   - `wireguard` (UDP), default; any stock WireGuard app.
   - `wireguard-wss` (TCP 443, WebSocket), already running; becomes a visible choice ("Rete che
     blocca le VPN") instead of a hidden troubleshooting section.
   - `amneziawg`: a **second device on the gateway** built on `amneziawg-go` (MIT), on its own UDP
     port, behind a build tag; obfuscation parameters (Jc, Jmin, Jmax, S1–S4, H1–H4 as ranges per
     AWG 2.0) **generated randomly per organisation in the console**, stored, sent in the netmap,
     never compiled into the binary. The profile is written for the official AmneziaWG apps (iOS,
     Android, macOS, Windows, Linux). The fixed constants in `pkg/dataplane/stealth` are removed or
     no longer used for this.
   - `vless-reality`: VLESS + REALITY + XTLS-Vision (Xray-core, MPL-2.0), the protocol this project
     started with on Oracle Cloud (`sovereign-oci-proxy`, 3x-ui). For heavy censorship and active
     probing. An Xray terminator on TCP 443 in front of the gateway; each NeroNet device is one Xray
     user (UUID), and its traffic enters the mesh through the gateway's netstack **as that device**
     (an authenticated per-device hop into the forward/policy point, not a shared NAT), so ACLs,
     blocks and names apply exactly as for WireGuard. Clients: FoXray/Streisand (iOS), v2rayNG
     (Android), v2rayN (Windows), nekoray/v2rayN (macOS, Linux); subscription link per device.
   - `openvpn`: for people and networks that only accept OpenVPN (OpenVPN Connect, or company
     firewalls). An OpenVPN terminator in front of the gateway with a per-device client address
     mapped 1:1 to the NeroNet device, so policy stays per device; certificates per device issued
     by the console, revocable with the device.
   - `ikev2`: later (native on iOS/macOS without an app; needs PKI and a privileged terminator).

   Rule for every non-WireGuard method: it is a way **into** the same per-device policy, never a
   bypass. A method whose terminator cannot attribute traffic to a device is not shipped.
3. Tests come first: an overlay scenario per method; for AmneziaWG an `amneziawg-go` client against
   the gateway, which must fail before the work and pass after, plus a negative test with a
   mismatched parameter.
4. The words the person sees describe the situation, not the protocol: "Normale", "Rete che blocca
   le VPN (porta 443)", "Rete che riconosce le VPN (AmneziaWG)", with the protocol name in muted
   text.

## Consequences

- One more WireGuard implementation on the gateway (amneziawg-go), isolated by build tag and port.
- Per-organisation secrets of a new kind (AWG parameters): treated like keys, never logged.
- The add-device flow gains one choice, shown only when more than one method is available.

## Console side (implemented 18 November 2026)

What the console stores and sends, so the gateway can be built against it:

- **Schema** (migration 055): `nodes.access_method` (`wireguard` | `wireguard-wss` | `amneziawg`, default
  `wireguard`), `nodes.awg_port`, `organizations.allowed_access_methods` (default
  `{wireguard,wireguard-wss}`, plain WireGuard always present), `organizations.awg_params` (jsonb, NULL until
  an administrator first switches AmneziaWG on).
- **Gateway capability**: a gateway that runs the AmneziaWG listener registers with `capability.capabilities`
  containing `awg-v1` and `capability.awg_port` (UDP port). The host is never reported: the profile's
  endpoint is the host of the endpoint the administrator named for the gateway plus that port, so a node
  cannot send people to an address of its own choosing. WebSocket availability stays installation-wide
  (`NERONET_WSS_PATH_PREFIX` configured).
- **Netmap**: for an organisation gateway that reports `awg-v1`, while the organisation allows `amneziawg`
  and has parameters, `self.awg = { listen_port, params }`. No other node receives it. Each profile device
  entry with `access_method: "amneziawg"` is served by the AmneziaWG device; any other device entry keeps
  the plain WireGuard device (a WebSocket device reaches it through the tunnel server).
- **Parameters** (`AccessMethodService.generateAwgParams`, random per organisation with `crypto.randomInt`;
  ranges per the AmneziaWG 2.0 documentation, to be checked against the pinned `amneziawg-go` release):
  Jc 4..12, Jmin 8..128, Jmax Jmin+32..Jmin+400 (at most 1280), S1 and S2 15..150 with S1+56 != S2, S3 8..64,
  S4 4..32, H1..H4 four disjoint ranges `low-high` inside 5..4294967295, at least 1000 wide, each in its own
  quarter of the space in a random order. They are never logged or audited, and the Settings route does not
  return them.
- **API**: `GET /api/devices/profile/methods`, `POST /api/devices/profile` with `access_method` (409
  `method_not_available` unless allowed and advertised), `GET|PUT /api/organizations/:id/access-methods`,
  `POST /api/organizations/:id/access-methods/regenerate` (owner or admin).
