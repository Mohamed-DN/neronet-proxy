# ADR 0035: What the Android app does on its own, and how it signs in

Status: accepted; phase A implemented, phases B and C proposed. 17 November 2026.

## Context

`clients/android` (ADR 0029) imports a NeroNet profile and runs it with the official WireGuard
tunnel library. It has QR import, always-on and a Quick Settings tile. The owner wants the app to
match and beat the Tailscale and NetBird apps: exit-node choice, phone as exit node, a real kill
switch, split tunnelling, device names, NeroDrop, NeroNuke, Cloud PC access, admin functions and an
automatic fallback when a network blocks UDP. Several of these need the app to talk to the console
as the person, which it cannot do today: the profile carries no credential, and must not.

## Decision

Three phases, each usable on its own.

**Phase A: features that need no console session.**
1. Kill switch that the app enforces itself: while the tunnel reconnects or after it drops
   unexpectedly, the app keeps the VPN interface up with all routes and no peer, so nothing leaves
   outside the tunnel until it is back or the person turns it off. A setting, on by default for full
   tunnel profiles. The system "Block connections without VPN" stays recommended on top.
2. Split tunnelling per app: include-only or exclude lists through `VpnService.Builder`
   `addAllowedApplication` / `addDisallowedApplication`, stored per profile on the device. Never in
   the profile file, which stays a standard `wg-quick` file.
3. Device name: show the name the console gave the device (`# NeroNet-DNS-Name:` comment line in the
   profile when present, else the profile title) and the search domain from the `DNS =` line.
4. NeroDrop: open the console's `/drop` page in a Custom Tab. The file key stays in the URL fragment
   and the page does the cryptography, exactly as in the browser (ADR 0033).

**Phase B: an app session, then the features that need it.**
The app signs in with a device-code flow: it shows a short code and a QR; the person approves it on
the console (already signed in there, MFA if the account has it). The console issues an app token
bound to that person and that installation, scoped (`devices:read`, `exit:select`, `drop:use`),
revocable from the console, stored in Android Keystore, never in the profile. With it: choose or
change the exit from the app (the console reissues the profile), native NeroDrop, list own devices
with their names and reachability.

**Phase C: heavier work.** Automatic transport fallback (UDP, then WireGuard over WebSocket 443 with
an embedded client; AmneziaWG only once the gateway speaks it), phone as exit node (needs the node
agent on Android, not a profile client), NeroNuke and Cloud PC access, admin functions behind the
same IAM and MFA as the web console.

## Consequences

- Phase A ships without any console change and keeps the app a pure profile client.
- Phase B adds one new credential type; it must be listed and revocable next to sessions, and its
  scopes are the only way the app reaches the API.
- The phone-as-exit and fallback items change what the app is (an agent, not a profile client); they
  get their own ADRs before code.
