# neronet for macOS (version 0)

The macOS client for NeroNet profile devices (ADR 0029). It is a root daemon: launchd starts
`neronet up` at boot, and wireguard-go runs on a `utun` interface. There is no
NetworkExtension, because that needs an Apple Developer ID.

## Install

1. Build or download `neronet-<version>-macos-universal.pkg` from the console.
2. Install it. Because it is unsigned, Gatekeeper refuses to open it. See the next section.
3. Install the profile and the daemon, then start it:

   ```sh
   sudo neronet install-daemon ~/Downloads/nero.conf
   sudo launchctl bootstrap system /Library/LaunchDaemons/com.darknero.neronet.plist
   ```

4. Check it: `neronet status`. Stop it with `sudo neronet down`. Remove everything with
   `sudo neronet uninstall-daemon`.

To run it in the foreground without the daemon: `sudo neronet up nero.conf`, then Ctrl-C.

## Gatekeeper (unsigned build)

There is no Apple Developer ID, so the package and the binary are not signed or notarized.
macOS shows a warning. Either:

- Right-click the `.pkg` and choose Open, then confirm. Recent macOS releases removed this
  bypass for some apps. If it does not appear, open System Settings, go to Privacy & Security,
  and choose Open Anyway next to the blocked package.
- Or remove the quarantine flag from the downloaded file:

  ```sh
  xattr -d com.apple.quarantine ~/Downloads/neronet-0.1.0-macos-universal.pkg
  # and, if the binary itself is blocked:
  sudo xattr -d com.apple.quarantine /usr/local/bin/neronet
  ```

Only do this for a package you downloaded from your own console. Signing and notarization
need an Apple Developer ID, which the owner has to create. Until then, every macOS user sees
these warnings.

## Profile

The profile is a standard WireGuard file with NeroNet metadata comments (ADR 0029). One
optional line is specific to this client:

```
# NeroNet-Search: corp.example
```

It names the overlay's search domain. With it, `neronet up` writes `/etc/resolver/corp.example`
so that only `*.corp.example` queries go to the overlay DNS servers. Without it, the DNS
servers are printed and the system DNS is not changed.

## What it does and does not do

- Creates `utun`, sets the profile's addresses and MTU, adds one route per `AllowedIPs`
  entry, resolves endpoints before the tunnel exists.
- Refuses a profile whose endpoint falls inside `AllowedIPs` (for example `0.0.0.0/0`).
  Full-tunnel profiles need a bypass route for the endpoint, which version 0 does not add.
- Does not change the system DNS, add a kill switch, or handle roaming between networks
  beyond what WireGuard does by itself.
- Never prints or logs a private key. `neronet status` shows the public-key prefix only.

## Layout

| Path | Purpose |
|---|---|
| `/Library/LaunchDaemons/com.darknero.neronet.plist` | launchd job |
| `/Library/Application Support/NeroNet/neronet` | the daemon binary (copy) |
| `/Library/Application Support/NeroNet/profile.conf` | the profile, mode 0600 |
| `/var/run/neronet.json` | state of the running tunnel (no keys) |
| `/var/log/neronet.log` | daemon output |
| `/etc/resolver/<domain>` | overlay DNS, only with `NeroNet-Search` |

The daemon restarts only after a failure. `neronet down` sends SIGTERM and the daemon exits 0,
so launchd does not start it again.

## Build

`scripts/macos/build-pkg.sh <version>` cross-compiles both architectures, joins them with
`lipo`, and wraps the result with `pkgbuild`. It needs a Mac. It does not sign.
