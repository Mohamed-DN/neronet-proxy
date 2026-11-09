# neronet-windows

Windows profile client for NeroNet (ADR 0029, version 0). It imports a NeroNet profile (a
standard WireGuard `.conf` with `# NeroNet-*` comment lines) and runs the tunnel as a Windows
service using wireguard-go and a Wintun adapter named `NeroNet`.

## Build

From the repository root:

```sh
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
  -o bin/neronet-windows.exe ./cmd/neronet-windows
```

Or `make build-windows`, which writes `bin/neronet-windows.exe`.

## wintun.dll

The binary loads `wintun.dll` at runtime. Download the official Wintun release from
https://www.wintun.net, take `wintun.dll` for your architecture (amd64 for this build), and place
it **next to `neronet-windows.exe`**. It is not part of this repository and must not be
committed. Without it, `up` fails with "create wintun adapter".

## Code signing

The binary is **unsigned** until the project has a code-signing certificate. Windows SmartScreen
will warn on first run ("Windows protected your PC"); the user has to choose "More info", then
"Run anyway". Installers from the console carry the same warning.

## Commands

Run these from an **elevated** (Administrator) prompt, except `status`.

| Command | What it does |
|---|---|
| `neronet-windows import <profile.conf>` | Validates the profile and copies it to `%ProgramData%\NeroNet\profile.conf`. The directory and file are readable only by SYSTEM and Administrators. |
| `neronet-windows install` | Registers the `NeroNet` service (automatic, delayed start). |
| `neronet-windows up` | Starts the service, which brings the tunnel up (alias: `start`). |
| `neronet-windows down` | Stops the service and tears the tunnel down (alias: `stop`). |
| `neronet-windows status` | Shows the service state and the imported profile: device ID, console URL, peers. It never prints key material. |
| `neronet-windows uninstall` | Removes the service. |
| `neronet-windows run` | Runs the tunnel in the console until Ctrl+C (debugging, no service). |

Typical use:

```
neronet-windows import C:\Users\me\Downloads\laptop.conf
neronet-windows install
neronet-windows up
neronet-windows status
```

The service log is `%ProgramData%\NeroNet\service.log`.

## What the service applies

- Addresses from `Address`, on the `NeroNet` adapter.
- One route per `AllowedIPs` entry (masked, duplicates removed), on-link.
- DNS from `DNS`, per address family.
- Peer endpoints resolved before the tunnel starts (IPv4 preferred), with four attempts about
  five seconds apart, so a service that starts before DNS works still comes up.

## Limitations in version 0

- **No full tunnel.** An `AllowedIPs` containing a default route (`0.0.0.0/0` or `::/0`) is
  refused, because the gateway endpoint would route into the tunnel. A bypass route is needed
  first.
- **No kill switch, no tray icon, no DERP, no posture.** Profile devices use the gateway path
  only (ADR 0029, section 1).
- **Static profile.** Changing the profile means importing it again and running `down` then
  `up`.
- The ACL restriction and the Wintun adapter setup are written against the Windows APIs but
  have not been run on a Windows machine yet (see the verification notes in the commit).
