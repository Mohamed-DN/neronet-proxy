# amneziawg-go, as used by NeroNet

Upstream: https://github.com/amnezia-vpn/amneziawg-go, tag v0.2.19 (17 June 2026), MIT
(see LICENSE, Copyright WireGuard LLC). Only the packages the gateway imports are here, without
tests: conn, device, ipc, ratelimiter, replay, rwcancel, tai64n, tun (and tun/tuntest, which the
interop tests use). The root go.mod `replace` points here so the one patch below applies.

## Patches

1. `device/uapi.go`, `mergeWithDevice`: write the four message-type headers back to the device
   only when the request changed one. Upstream assigns all four on every `IpcSet`, including a
   request that only adds or removes peers, while the receive goroutines (`receive.go`,
   `DeterminePacketTypeAndPadding`) and the handshake and encryption goroutines read them with no
   lock. The values written are the ones already there, so nothing misbehaves, but the Go race
   detector reports it on every peer update of a running device, and the gateway updates peers on
   every netmap. Measured: `go test -tags awg -race ./pkg/dataplane` fails with 20+ reports on
   v0.2.19 unmodified (uapi.go:737-740 against receive.go:568-604) and is clean with this patch.

To update: copy the same packages from the new tag, re-apply the patch, run the awg-tagged tests
with `-race -count=5`, and drop the patch if upstream has fixed it (then delete this directory and
the `replace` line).
