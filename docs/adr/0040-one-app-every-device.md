# ADR 0040: One NeroNet app for every device, on one shared core

Status: accepted (design). 23 November 2026.

## Context

The add-device flow sends people to the stock WireGuard app. Today that is the honest default: on
Windows our client is a command-line profile runner that has never been run on a real Windows
machine, on macOS it is a daemon with no interface, on Linux a command-line package, and Android has
a real app that is still a profile client (ADR 0035, phase A). There is no iOS app. A stock app is
one UDP endpoint: no fallback when a network blocks UDP, no exit picker, no direct path between two
devices (everything crosses the gateway), no NeroDrop, no policy or connection state in the app.

Four codebases doing the same job separately is the reason the desktop clients stayed behind.
NetBird replaced its native desktop interface with Wails v3 and React in 2026 and kept a Go daemon
behind it; Tailscale has one Go core under every interface. The console already has a React design
system (DIRECTION-2026-11) and the node agent is already Go.

## Decision

1. **The app is a mesh node, not a profile.** It holds its own key, receives a netmap, talks to
   peers directly and falls back to relays, and obeys the same ACL as any node. Profiles for stock
   apps stay supported as the second choice ("Usa un'altra app").
2. **One core, thin interfaces.** `pkg/clientcore` (Go) owns sign-in, keys, netmap, tunnel,
   connection order (ADR 0037), exit choice (ADR 0032), names (ADR 0034), kill switch state and
   statistics, and reuses the node agent's packages instead of copying them. It exposes one small
   versioned **local API** (state stream plus commands).
   - Desktop (Windows, macOS, Linux): privileged service with the core, unprivileged interface in
     **Wails + React** using the console's tokens, components and strings. The exact Wails version
     is chosen and pinned when phase 1 starts, after reading its release page.
   - Android: the existing Compose interface stays; the profile tunnel is replaced by the core
     through gomobile.
   - iOS: SwiftUI over the same core in a packet tunnel extension, when an Apple developer account
     exists.
3. **Sign-in by device code** (ADR 0035 phase B): the app shows a code and a QR, the person approves
   on the console with their own sign-in and MFA. The app token is bound to the person and the
   installation, scoped, listed and revocable, and stored in the system key store (DPAPI, Keychain,
   Android Keystore, Secret Service or a root-only file on headless Linux). The app never sees a
   password.
4. **Local API security.** Windows: named pipe whose ACL admits only the interactive user who owns
   the installation and administrators. Unix: socket with peer-credential check. No TCP listener.
   The interface can ask the service to do only what the API names; the service validates every
   argument as untrusted input.
5. **Feature parity is tracked per platform and never overstated.** The portal and the app show a
   feature only where it works. Known platform limits: iOS has no per-app split tunnelling without
   device management and cannot act as an exit in the first version; background work on phones is
   bounded by the system; macOS system extensions and store distribution need an Apple account.
6. **Dangerous functions** (NeroNuke, admin) are reached with a fresh console sign-in and MFA inside
   the app, with the same IAM checks; the app token alone never authorises them.
7. **Portal.** When a stable interface build is published for the person's platform, "Aggiungi
   dispositivo" offers **NeroNet first** and WireGuard/AmneziaWG/VLESS as the alternative. Until
   then the portal keeps the stock app first: a test build is never the default.

## Phases

| Phase | Content | Proof required |
|---|---|---|
| 0 | `pkg/clientcore`, local API, device-code sign-in and app tokens in the console | Linux container end to end: sign in, join, reach a peer, revoke cuts it |
| 1 | Windows app: installer, service, tray, connect, devices, exit, names, kill switch, WireGuard → 443 fallback, NeroDrop | Windows CI runner with a real Wintun adapter against a real stack; then one real PC |
| 2 | Linux and macOS with the same interface | Linux desktop container and a macOS CI runner with a real utun |
| 3 | Android on the core: exit picker, fallback, device list; phone as exit | emulator in CI plus one real phone |
| 4 | Native NeroDrop, Cloud PC, admin and NeroNuke in the app | per-feature scenario with MFA |
| 5 | iOS | needs the owner's Apple developer account |

Distribution: MSI/EXE, deb/rpm, pkg, APK, each with a published SHA-256 and a signed update manifest.
Without a code-signing certificate Windows shows a SmartScreen warning and macOS refuses a normal
double click; the download page says so plainly.

## Consequences

- The current `cmd/neronet-{windows,macos,linux}` profile clients become thin wrappers over the core
  and are removed once the core covers them.
- Two new attack surfaces, the app token and the local API, get their own tests before any interface.
- Feature work happens once in the core and once in the desktop interface, instead of four times.

## Phase 0 as built (23 November 2026)

Slice A, console (migration 059): `POST /api/app-auth/device/start|poll`, `token/refresh`, and for a
signed-in person `device/lookup|approve|deny`, `GET /sessions`, `DELETE /sessions/:id`; the app's own
routes live under `/api/app-auth/app/*`. Choices worth knowing:

- An app token (`nna_`, refresh `nnr_`) is an opaque secret, not a console JWT. No console route reads it,
  so reaching admin or NeroNuke with it is impossible by construction; a test walks the whole route
  table and checks it gains nothing over no credential at all. Hashes only are stored.
- The enrolment grant is the existing single-use pre-auth key, now bound to the installation public key
  (`preauth_keys.bound_public_key`), so it enrols exactly one node, owned by the approving person in
  their organisation. Registration itself proves possession of the key.
- Approval needs a fresh TOTP (or recovery) code when the account has a second factor or must have one;
  an account that must have one and has none is refused with `mfa_setup_required`.
- Replaying a replaced refresh token revokes the app and cuts its node. Revoking from the console uses
  the existing key revocation path (revoked key to every peer, credentials dead, ACL epoch bumped).
- Binding of a refresh to the installation is by public key match, not by a fresh proof of possession.

Slice B, `pkg/clientcore`: device-code client, enrolment through `pkg/control`, connection order walk
(each method once, bounded, forced means first only, a removed device never falls back), state stream,
and the versioned local API (newline-delimited JSON, strict decoding) over a `Transport` interface with
a Linux unix-socket implementation (0600 file, peer credentials checked). The Windows named pipe is
phase 1. Starting the real tunnel from the core (reusing the netmap manager that still lives in
`cmd/sovereign-node`'s `main` package) and the real-stack end-to-end proof are not done yet.
