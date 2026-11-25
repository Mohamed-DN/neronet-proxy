# ADR 0043: A profile gateway on a remote Linux server

Status: accepted. 25 November 2026.

## Context

A profile gateway (ADR 0029) has so far run as containers next to the console. Some organisations
need one in another country: devices on a censored network connect to a server that is not theirs
to rebuild, on a host that already has a TLS service on TCP 443, with no containers and no spare
inbound port. ADR 0036 gave the gateway VLESS + REALITY, which needs 443 to look like the web.

## Decision

1. **Report and listen are two settings.** `SOVEREIGN_VLESS_PORT` stays the public port the console
   writes into every VLESS link. `SOVEREIGN_VLESS_LISTEN` (`host:port`, host an IP address) moves the
   socket Xray binds, normally `127.0.0.1:8445`. Unset, the rendered Xray configuration is
   byte-identical to before (a golden test holds that). A bad host or port stops the node at start.
2. **PROXY protocol only on loopback.** `SOVEREIGN_VLESS_ACCEPT_PROXY=true` makes Xray read a PROXY
   header (`sockopt.acceptProxyProtocol`) so per-address limits see the client, not the router. Anyone
   who can reach the socket can write that header, so it is refused unless the listen address is
   loopback and was set explicitly. Without it, the other service and Xray see `127.0.0.1` as the
   client.
3. **Enrolment without the fleet token.** A remote server must never hold the fleet token. The node
   already took a single-use pre-auth key in `SOVEREIGN_ENROLMENT_KEY`; `SOVEREIGN_ENROLMENT_KEY_FILE`
   adds a file that must be mode 0600, is removed once the control plane accepts the registration and
   is never logged. The control plane is reached over TLS verified against `SOVEREIGN_CONTROL_PLANE_CA`;
   there is no flag that skips verification, and a test shows a server the pinned CA did not sign is
   never reached.
4. **A Debian package, `neronet-gateway`** (amd64, arm64). The node and the pinned Xray-core release
   (sha256 checked at build, against the digest on the release page) run as two units under two
   dedicated users, hardened (no capabilities, `ProtectSystem=strict`, restricted address families
   and system calls, memory, CPU and IO limits so the host's other services come first). Xray reads
   its configuration as a systemd credential, not from the node's state. A path unit restarts Xray
   when the node rewrites the file and stops it when the file disappears. Installing starts, enables
   and opens nothing; the scripts never touch another service, a firewall or a port. Purge, and only
   purge, removes state.
5. **Sharing 443 with an SNI router**, nginx `stream` with `ssl_preread`: the NeroNet name goes to
   Xray on loopback, every other name and every client without a name goes to the service that had
   443. Nothing is decrypted at the router, so it needs no certificate. `neronet-443-swap`
   (`plan`, `apply`, `rollback`, `status`) is generic: the operator gives the other service a loopback
   listener and writes the two commands that release and restore its public 443; the tool checks,
   swaps, probes the public address with both names and an unowned one, and rolls back by itself if a
   probe fails within the deadline. `apply` is a dry run unless `--yes`.

## Threat model

The remote host is a gateway: after Xray decrypts a device's connection, its traffic leaves toward
the mesh from this machine, so whoever has root there can read the device's traffic in clear and the
REALITY private key and the per-device SOCKS secrets in memory. It does not see the organisation's
other devices, the fleet token (never installed) or the mesh private keys of other nodes. Choose the
host accordingly; it is a place the organisation trusts with the traffic of profile devices, not more.
The router sees only the SNI of each connection.

## Measured

In one container with real Xray servers and clients and a real nginx (scripts/dev/test-remote-gateway.sh):
the existing service lost no request during the swap (113 round trips, 0 failed, longest silence
between two successes 227 ms; 443 had no listener for 26 ms); both services answer through 443
afterwards; a wrong name or an unknown uuid is refused and the unauthenticated answer is the cover
site's certificate; rollback restores the existing service in 58 to 270 ms over several runs; a swap whose probe fails undoes
itself and exits 2. The existing service's own restart is part of that figure: a service that reloads
without dropping connections does better, one that restarts slowly does worse.

## Not decided here, designed for later

- **Relay (slice 2).** The DERP relay as a third unit of the same package behind the same router
  under its own name, with a certificate issued for that name (HTTP-01 on port 80 or DNS-01; no secret
  in the package), STUN on UDP 3478, the existing admission snapshot.
- **Mesh exit (slice 3).** `EXIT_BRIDGE` per ADR 0032, userspace netstack, plain WireGuard on UDP
  51820 optional, approval as exit stays an admin action.
- **Offsite backups (slice 4).** The server as an append-only target for the installation's encrypted
  restic backups: an account that can add and cannot read or delete (restic `rest-server
  --append-only`, or an SFTP account restricted by `command=`), a quota, and these to agree first:
  who holds the restic repository key (never this host), the retention that the owner applies from
  elsewhere because this host cannot prune, and what the host operator may see (ciphertext and sizes).
  Not built.

## Consequences

The owner of the other service changes one thing on that host (a loopback listener) and writes two
commands; everything else is ours and reversible with `neronet-443-swap rollback`.
