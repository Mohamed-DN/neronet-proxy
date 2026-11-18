# ADR 0039: Home routers as mesh nodes and exits (OpenWrt packages)

Status: accepted (design). 18 November 2026.

## Context

A mesh node can be an exit (ADR 0032). The owner wants packages to put on routers so a router
(for example at a relative's home in another country) becomes a node and an exit. The Linux client
(`cmd/neronet-linux`, .deb/tar.gz for amd64/arm64, kill switch, nftables) exists on main.

## Decision

1. Target **OpenWrt** (and vendor builds on top of it such as GL.iNet): packages for the current
   stable release format (`.ipk` for 23.05, `.apk` for 24.10 and later), built for the common router
   targets: `mipsel_24kc`, `mips_24kc`, `arm_cortex-a7_neon-vfpv4`, `aarch64_cortex-a53`,
   `aarch64_generic`, `x86_64`. Pure-Go static binaries (CGO off), stripped, size reported per
   target (flash is small: budget per target).
2. The package installs the node agent with a procd init script, a UCI config
   (`/etc/config/neronet`: control URL, enrolment code, exit on/off, LAN advertise on/off) and an
   optional LuCI page (enter the code, see status, toggle exit). nftables (fw4) rules for the exit
   and the kill switch, never touching the router's own WAN/LAN rules beyond a dedicated chain.
3. Enrolment uses the existing pre-auth key flow; the console shows the router as a node of kind
   "router" and, once exit is enabled and approved by an admin, as an exit with its country (from
   its public IP, shown as measured, never guessed).
4. Build in CI with the OpenWrt SDK containers (pinned) per target; install/run smoke test on the
   x86_64 OpenWrt image in a container/VM.

## Consequences

- One more distribution channel to keep current with OpenWrt releases.
- Exit traffic leaves from someone's home connection: the admin approval and a clear label are
  required before a router serves as an exit.
