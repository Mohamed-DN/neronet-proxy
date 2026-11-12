# ADR 0029: Device apps outside the stores, and a profile gateway

**Status:** Accepted
**Date:** 2026-11-09
**Deciders:** owner (Mohamed), lead engineer

## Context

No end-user device can join a NeroNet network today (verified 2026-11-09):

- The console's "Enroll Node" QR names a placeholder peer key
  (`console/backend/utils/crypto.js:55-57`), so any WireGuard app that imports it never connects.
- Mesh nodes rotate the PSK every two minutes for every peer
  (`pkg/crypto/pskepoch/pskepoch.go:88-105,171-183`) and the transport mux drops packets from a
  peer with no known path (`pkg/transport/mux.go:493-529`): a static WireGuard profile cannot
  talk to a mesh node directly.
- `cmd/neronet-windows` fetches the netmap and never applies it (`service.go:210`); the kernel
  TUN data plane is Linux-only (`pkg/dataplane/tundev.go:34`); there is no Android, iOS or macOS
  code.

The owner's distribution decision: our own apps, **not through the stores**, wherever the
platform allows it. Android: our APK, side-loaded. Windows: our installer, downloaded from our
console. macOS: our package where possible. iOS: no side-loading is possible without an Apple
Developer account, so iOS uses the official WireGuard app until there is one.

## Decision

### 1. A profile gateway

A designated mesh node, the **gateway**, accepts "profile devices": standard WireGuard peers
with a static configuration.

- The device's key pair is generated on the device or in the browser. The server receives the
  public key only. No API response ever contains a device private key.
- Each profile device has its own PSK, chosen with the key pair and stored server side
  (the gateway must know it). Profile devices are exempt from the epoch PSK rotation; mesh
  peers are not.
- The gateway accepts a profile device's endpoint from authenticated packets only (roaming).
- The gateway routes between the profile device's overlay address and the mesh like a subnet
  router; the organisation's ACLs are enforced at the gateway.
- Revoking a device removes it from the gateway within one netmap fetch.

### 2. The NeroNet profile

A profile is a standard `wg-quick` configuration, so every WireGuard implementation reads it,
with NeroNet metadata in comment lines that other implementations ignore:

```
# NeroNet-Profile: 1
# NeroNet-Console: https://console.example/me
# NeroNet-Device: dev-0123abcd
[Interface]
PrivateKey = <generated on the device or in the browser>
Address = 100.64.12.34/32
DNS = 100.64.0.1

[Peer]
PublicKey = <the gateway's real public key>
PresharedKey = <per-device PSK>
Endpoint = gateway.example:51820
AllowedIPs = 100.64.0.0/10
PersistentKeepalive = 25
```

Our apps read `NeroNet-Console` for their "Open the console" button. They never send the
private key anywhere.

### 3. Our apps, version 0 and version 1

- **v0, profile client**: each app imports a NeroNet profile (QR or file), brings the tunnel up
  with the platform's standard WireGuard implementation, and opens the console. This works
  against the gateway as soon as the gateway exists.
- **v1, mesh client**: the shared Go core (`pkg/client`, extracted from `sovereign-node`): invite
  enrollment with on-device keys, netmap, epoch PSK, UDP and DERP transports, ACL filter.

| Platform | v0 | Distribution |
|---|---|---|
| Android | Kotlin app with `VpnService`, the WireGuard tunnel library, QR import | our APK from the console, side-loaded; signed with our own key |
| Windows | `neronet-windows` service + tray, wireguard-go + Wintun, profile import | our installer from the console; unsigned until a code-signing certificate exists (SmartScreen warns) |
| Linux | `neronet` daemon/CLI, kernel or userspace WireGuard, routes, DNS, kill switch | our `.deb`/`.rpm`/tarball from the console |
| macOS | Go daemon with wireguard-go on `utun`, run as root by launchd, CLI and menu-bar later | our package; without an Apple Developer ID it is unsigned and Gatekeeper must be bypassed by the user |
| iOS | **official WireGuard app** importing the NeroNet profile QR | App Store app; our own app needs an Apple Developer account (TestFlight or App Store) |

## Options considered for iOS

- **Official WireGuard app + profile (chosen now).** Works today once the gateway exists; no
  account needed. Loses NeroNet features beyond the tunnel (no DERP, no posture).
- **Free Apple ID side-loading (Xcode, AltStore-style).** Apps expire after 7 days and a
  Network Extension needs a paid team: unusable for users.
- **EU alternative marketplaces.** Still require Apple notarization and a developer account.
- **TestFlight / App Store with an Apple Developer account.** The real path for our own iOS app;
  needs the owner's account (99 USD/year).

## Consequences

- Every platform, including iOS, can join through the gateway before our own apps are complete.
- Profile devices have weaker properties than mesh nodes (static PSK, gateway-only path, no
  DERP); the console must label them as such.
- Unsigned Windows and macOS builds show operating-system warnings until certificates exist.
- The fake QR in the console (D26) is replaced by the profile flow; the old endpoint must stop
  returning a configuration that cannot work.

## Amendment, 2026-11-12: several gateways per organisation

Study `GATEWAY-PER-UTENTE-NOV12`, option B. An organisation may name several mesh nodes as
profile gateways, exactly one of them the default (migration 051 replaces 046's one-gateway
index with a one-default index). Each profile device is served by one gateway,
`nodes.gateway_node_id`, the default unless an administrator chose another; only that
gateway holds it as a peer, other nodes route its address to it, its profile names it, and
only its handshake reports are stored. Moving a device needs a new profile, since a stock
profile has one `[Peer]` and one `Endpoint`. Choosing a gateway other than the default goes
through one hook (`ProfileGatewayService.mayUseGateway`, administrators only) that ADR
0030's `gateway.use` replaces. No failover: a gateway that is down cuts the devices it
serves until they are moved.
