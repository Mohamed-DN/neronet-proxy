#!/bin/sh
# End-to-end test of the neronet Linux client (ADR 0029, version 0).
#
# Two containers on a private Podman network:
#   gateway: stock wg-quick (alpine + wireguard-tools), the peer that accepts profile devices;
#   client:  our `neronet up --kill-switch` with a profile generated here.
# The script checks a ping and a TCP connection through the tunnel, that the kill switch drops
# traffic that is not the tunnel, and that `neronet down` leaves no interface, route, nft
# table, process or state file behind.
#
# Keys are generated inside the containers and are never printed. Every container, network
# and temporary file this script creates is removed on exit, also after a failure.
#
# Needs rootless Podman with /dev/net/tun in its machine, and network access to pull
# docker.io/library/alpine:3.20 and docker.io/library/golang:1.26.10. On Windows, run it from
# Git Bash; mount and copy paths are converted with cygpath.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PFX=neronet-linuxe2e
NET=$PFX-net
GW=$PFX-gw
CL=$PFX-client
BUILD=$PFX-build
ALPINE=docker.io/library/alpine:3.20
GOIMG=docker.io/library/golang:1.26.10
SUBNET=10.77.42.0/24
GW_UNDER=10.77.42.10
CL_UNDER=10.77.42.20
GW_TUN=10.99.0.1
CL_TUN=10.99.0.2
TUN_NET=10.99.0.0/24
WG_PORT=51820
TCP_PORT=9000
# The t0p1 run holds this file while it is busy; heavy work waits for it to go away.
GATE=${NEURONET_E2E_GATE:-/c/AI/NeroNet/piano/reports/logs-t0p1/DERP_RUNNING}
WORK=$(mktemp -d)

if command -v cygpath >/dev/null 2>&1; then
	winpath() { cygpath -m "$1"; }
else
	winpath() { printf '%s' "$1"; }
fi

# Podman on Windows must not rewrite the arguments; the wrapper keeps that in one place.
pm() { MSYS_NO_PATHCONV=1 podman "$@"; }

step() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

cleanup() {
	status=$?
	if [ "$status" -ne 0 ] && pm container exists "$CL" >/dev/null 2>&1; then
		echo "--- neronet log in the client:" >&2
		pm exec "$CL" sh -c 'cat /work/neronet.log 2>/dev/null' >&2 || true
	fi
	pm rm -f -t 0 "$CL" "$GW" "$BUILD" >/dev/null 2>&1 || true
	pm network rm -f "$NET" >/dev/null 2>&1 || true
	rm -rf "$WORK"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

wait_gate() {
	while [ -e "$GATE" ]; do
		note "$GATE exists; waiting 60 s before heavy work"
		sleep 60
	done
}

step "preflight"
pm version >/dev/null 2>&1 || die "podman is not reachable"
# Leftovers of an earlier run of this script, under our own names only.
pm rm -f -t 0 "$CL" "$GW" "$BUILD" >/dev/null 2>&1 || true
pm network rm -f "$NET" >/dev/null 2>&1 || true

step "cross-compile neronet for linux/amd64 (CGO off) in $GOIMG"
wait_gate
pm run --rm --name "$BUILD" \
	-v "$(winpath "$ROOT"):/src" \
	-v "$(winpath "$WORK"):/out" \
	-v neronet-gomod:/go/pkg/mod \
	-v neronet-gocache:/root/.cache/go-build \
	-w /src "$GOIMG" \
	sh -c 'CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-X main.version=e2e" -o /out/neronet ./cmd/neronet-linux' \
	|| die "build failed"
[ -s "$WORK/neronet" ] || die "the build produced no binary"

step "create the network and the two containers"
wait_gate
pm network create --subnet "$SUBNET" "$NET" >/dev/null
pm run -d --name "$GW" --network "$NET" --ip "$GW_UNDER" \
	--cap-add NET_ADMIN --device /dev/net/tun "$ALPINE" sleep 3600 >/dev/null
pm run -d --name "$CL" --network "$NET" --ip "$CL_UNDER" \
	--cap-add NET_ADMIN --device /dev/net/tun "$ALPINE" sleep 3600 >/dev/null
pm cp "$(winpath "$WORK/neronet")" "$CL:/usr/local/bin/neronet"
pm exec "$CL" chmod 0755 /usr/local/bin/neronet

step "install wireguard-tools, iproute2 and nftables"
pm exec "$GW" sh -c 'apk add --no-cache wireguard-tools iproute2 >/dev/null'
pm exec "$CL" sh -c 'apk add --no-cache wireguard-tools iproute2 nftables >/dev/null'

step "generate keys inside the containers (not printed)"
pm exec "$GW" sh -c 'umask 077; mkdir -p /etc/wireguard && wg genkey > /etc/wireguard/gw.key && wg genpsk > /etc/wireguard/psk'
pm exec "$CL" sh -c 'umask 077; mkdir -p /work && wg genkey > /work/client.key'
GW_PRIV=$(pm exec "$GW" cat /etc/wireguard/gw.key)
GW_PUB=$(pm exec "$GW" sh -c 'wg pubkey < /etc/wireguard/gw.key')
PSK=$(pm exec "$GW" cat /etc/wireguard/psk)
CL_PRIV=$(pm exec "$CL" cat /work/client.key)
CL_PUB=$(pm exec "$CL" sh -c 'wg pubkey < /work/client.key')
[ -n "$GW_PRIV" ] && [ -n "$GW_PUB" ] && [ -n "$PSK" ] && [ -n "$CL_PRIV" ] && [ -n "$CL_PUB" ] \
	|| die "key generation failed"

step "bring up the wg-quick gateway at $GW_TUN"
printf '%s\n' \
	"[Interface]" \
	"PrivateKey = $GW_PRIV" \
	"Address = $GW_TUN/24" \
	"ListenPort = $WG_PORT" \
	"" \
	"[Peer]" \
	"PublicKey = $CL_PUB" \
	"PresharedKey = $PSK" \
	"AllowedIPs = $CL_TUN/32" |
	pm exec -i "$GW" sh -c 'cat > /etc/wireguard/wg0.conf && chmod 600 /etc/wireguard/wg0.conf'
pm exec "$GW" wg-quick up /etc/wireguard/wg0.conf >/dev/null
pm exec -d "$GW" sh -c "while true; do echo neronet-e2e-ok | nc -l -p $TCP_PORT >/dev/null; done"

step "write the NeroNet profile into the client and start neronet up --kill-switch"
printf '%s\n' \
	"# NeroNet-Profile: 1" \
	"# NeroNet-Console: https://console.example/me" \
	"# NeroNet-Device: dev-e2e0001" \
	"[Interface]" \
	"PrivateKey = $CL_PRIV" \
	"Address = $CL_TUN/32" \
	"" \
	"[Peer]" \
	"PublicKey = $GW_PUB" \
	"PresharedKey = $PSK" \
	"Endpoint = $GW_UNDER:$WG_PORT" \
	"AllowedIPs = $TUN_NET" \
	"PersistentKeepalive = 25" |
	pm exec -i "$CL" sh -c 'umask 077; cat > /work/profile.conf'
pm exec -d "$CL" sh -c 'exec /usr/local/bin/neronet up --kill-switch /work/profile.conf >/work/neronet.log 2>&1'

step "wait for the tunnel (up to 30 s)"
tries=0
until pm exec "$CL" ping -c 1 -W 1 "$GW_TUN" >/dev/null 2>&1; do
	tries=$((tries + 1))
	if [ "$tries" -ge 30 ]; then
		pm exec "$CL" cat /work/neronet.log >&2 || true
		die "no ping reached $GW_TUN through the tunnel within 30 s"
	fi
	sleep 1
done
note "tunnel is up after about $tries s"

step "neronet status"
STATUS=$(pm exec "$CL" /usr/local/bin/neronet status) || die "neronet status failed"
printf '%s\n' "$STATUS" | sed 's/^/   /'
if printf '%s\n' "$STATUS" | grep -q 'handshake:   never'; then
	die "status reports no handshake"
fi

step "ping through the tunnel (10 probes)"
PING=$(pm exec "$CL" ping -c 10 -W 2 "$GW_TUN") || true
printf '%s\n' "$PING" | tail -n 2 | sed 's/^/   /'
RECV=$(printf '%s\n' "$PING" | sed -n 's/^\([0-9]*\) packets transmitted, \([0-9]*\) packets received.*/\2/p')
[ "${RECV:-0}" -eq 10 ] || die "ping through the tunnel received ${RECV:-0} of 10 probes"

step "TCP through the tunnel to $GW_TUN:$TCP_PORT"
TCP=$(pm exec "$CL" sh -c "nc -w 3 $GW_TUN $TCP_PORT </dev/null" 2>/dev/null) || true
[ "$TCP" = "neronet-e2e-ok" ] || die "TCP through the tunnel returned '$TCP'"
note "TCP: got the expected reply"

step "kill switch: traffic that is not the tunnel must be dropped"
pm exec "$CL" nft list table inet neronet >/dev/null 2>&1 || die "nft table inet neronet is missing while the tunnel is up"
if pm exec "$CL" ping -c 2 -W 2 "$GW_UNDER" >/dev/null 2>&1; then
	die "ping to $GW_UNDER got through: the kill switch does not block non-tunnel traffic"
fi
note "ping to $GW_UNDER (the endpoint address, but not the WireGuard port) is dropped"

step "neronet down"
pm exec "$CL" /usr/local/bin/neronet down || die "neronet down failed"

step "nothing left behind"
if pm exec "$CL" ip link show neronet0 >/dev/null 2>&1; then
	die "interface neronet0 still exists"
fi
ROUTES=$(pm exec "$CL" ip route show)
if printf '%s\n' "$ROUTES" | grep -Fq -e '10.99.0.' -e "$GW_UNDER "; then
	printf '%s\n' "$ROUTES" >&2
	die "routes for the tunnel or the endpoint are still installed"
fi
if pm exec "$CL" nft list table inet neronet >/dev/null 2>&1; then
	die "nft table inet neronet is still loaded"
fi
if pm exec "$CL" test -e /run/neronet/state.json; then
	die "the state file /run/neronet/state.json is still there"
fi
if pm exec "$CL" pidof neronet >/dev/null 2>&1; then
	die "a neronet process is still running"
fi
note "no interface neronet0, no tunnel or endpoint route, no nft table, no state file, no process"

step "result"
ROUNDTRIP=$(printf '%s\n' "$PING" | sed -n 's/.*round-trip min\/avg\/max = [^/]*\/\([^/]*\)\/.*/\1/p')
note "PASS: ping $RECV/10 through the tunnel, avg rtt ${ROUNDTRIP:-n/a} ms; TCP reply received; kill switch blocks non-tunnel traffic; down leaves nothing behind"
