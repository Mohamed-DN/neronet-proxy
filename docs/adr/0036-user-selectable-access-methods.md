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
   - `ikev2`: later (native on iOS/macOS without an app; needs PKI and a privileged terminator).
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
