#!/bin/sh
# Usage: test-neronet-gateway-systemd.sh
#
# Runs the neronet-gateway units under a real systemd (PID 1 of a throw-away privileged
# container, amd64) to check what static inspection cannot:
#   - the hardened node unit really starts with the real binary (ProtectSystem=strict, the system
#     call filter, an empty capability set, memory limit applied);
#   - Xray, under its own user, runs exactly while the node's configuration file exists: not
#     before, restarted when the file changes, stopped when it is removed, and not started at all
#     for a unit the operator did not enable;
#   - Xray cannot read the node's state directory, only its credential copy.
# The file the node writes is imitated by hand here (the node writing it is tested with the real
# binary in tests/remotegw); everything on the systemd side is real.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIST=$ROOT/dist/gateway
ENGINE=${NERONET_ENGINE:-podman}
NAME=neronet-gateway-systemd-test
IMGTAG=localhost/neronet-systemd-test:debian13

if command -v cygpath >/dev/null 2>&1; then
	winpath() { cygpath -m "$1"; }
else
	winpath() { printf '%s' "$1"; }
fi
pm() { MSYS_NO_PATHCONV=1 "$ENGINE" "$@"; }
die() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

set -- "$DIST"/neronet-gateway_*_amd64.deb
[ -f "$1" ] || die "no amd64 package in $DIST"
DEB=$(basename "$1")

waited=0
while [ -n "$(pm ps --format '{{.Names}}' | grep -v '^darknero-web$' || true)" ]; do
	[ "$waited" -lt 1800 ] || die "another container kept running for 30 minutes"
	printf 'another container is running; checking again in 30 s\n'
	sleep 30
	waited=$((waited + 30))
done

WORK=$(mktemp -d)
trap 'pm rm -f -t 2 "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

if ! pm image exists "$IMGTAG" 2>/dev/null; then
	printf '== building %s\n' "$IMGTAG"
	cat >"$WORK/Containerfile" <<'EOF'
FROM docker.io/library/debian:13-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends systemd systemd-sysv dbus procps iproute2 util-linux ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
	timeout 600 "$ENGINE" build -q -t "$IMGTAG" "$(winpath "$WORK")" >/dev/null
fi

cat >"$WORK/inner.sh" <<'EOF'
set -eu
step() { printf '\n== %s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; for u in neronet-gateway-node neronet-gateway-xray; do systemctl status --no-pager -n 15 "$u.service" 2>&1 | cut -c1-200 | head -30; done; journalctl -u neronet-gateway-xray.service --no-pager -n 12 -o cat 2>&1 | cut -c1-300; exit 1; }
active(){ systemctl is-active --quiet "$1"; }
wait_until() { # seconds description command...
	n=$1; d=$2; shift 2
	i=0
	while [ "$i" -lt "$((n * 4))" ]; do
		if "$@"; then return 0; fi
		sleep 0.25; i=$((i + 1))
	done
	die "timed out: $d"
}
pidof_unit() { systemctl show -p MainPID --value "$1"; }

step "systemd is PID 1"
systemctl is-system-running --wait >/dev/null 2>&1 || true
systemctl --version | head -1

step "install"
apt-get install -y -qq --no-install-recommends /pkg/"$DEB" >/dev/null 2>&1 || {
	apt-get update -qq >/dev/null; apt-get install -y -qq --no-install-recommends /pkg/"$DEB" >/dev/null; }
apt-get install -y -qq --no-install-recommends openssl >/dev/null 2>&1 || true
systemctl daemon-reload
active neronet-gateway-xray.service && die "xray started by install" || true
active neronet-gateway-node.service && die "node started by install" || true

step "the hardened node unit starts with the real binary"
systemctl start neronet-gateway-node.service
wait_until 20 "node active" active neronet-gateway-node.service
wait_until 15 "the node process to exec the binary" sh -c '[ "$(cat /proc/$(systemctl show -p MainPID --value neronet-gateway-node.service)/comm 2>/dev/null)" = sovereign-node ]'
pid=$(pidof_unit neronet-gateway-node.service)
[ "$(stat -c %U /proc/"$pid")" = neronet-gw ] || die "node does not run as neronet-gw"
grep -E '^(CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/"$pid"/status
grep -q '^CapEff:[[:space:]]*0000000000000000' /proc/"$pid"/status || die "node has effective capabilities"
grep -q '^CapBnd:[[:space:]]*0000000000000000' /proc/"$pid"/status || die "node has a capability bounding set"
grep -q '^NoNewPrivs:[[:space:]]*1' /proc/"$pid"/status || die "NoNewPrivileges not applied"
grep -q '^Seccomp:[[:space:]]*2' /proc/"$pid"/status || die "no seccomp filter"
systemctl show -p MemoryMax -p CPUQuotaPerSecUSec -p IOSchedulingClass -p TasksMax neronet-gateway-node.service
[ "$(systemctl show -p MemoryMax --value neronet-gateway-node.service)" = 402653184 ] || die "MemoryMax not applied"
wait_until 20 "identity key written into the state directory" test -s /var/lib/neronet-gateway/node_identity.key
stat -c '%U %a %n' /var/lib/neronet-gateway /var/lib/neronet-gateway/node_identity.key
step "what the node listens on"
ss -Hltnup | awk '{print $1, $5, $7}' | sort -u
# Without a control plane the data plane stays down, so the device SOCKS is not up here; the real
# binary against a stub control plane is tested in tests/remotegw.
ss -Hltnup | awk '{print $1, $5, $7}' | sort -u
ss -Hltn | awk '{print $4}' | grep -E '^(0.0.0.0|\*|\[::\]):' && die "a TCP listener on a public address" || true
journalctl -u neronet-gateway-node.service --no-pager -n 8 | cut -c1-200

step "Xray is not started without the file, nor without being enabled"
systemctl enable --now neronet-gateway-xray.path >/dev/null 2>&1
active neronet-gateway-xray.service && die "xray runs with no configuration" || true
[ -f /var/lib/neronet-gateway/xray/config.json ] && die "a configuration exists already" || true

# A configuration like the node writes: REALITY on loopback, no clients (the test is the unit).
priv=$(/usr/lib/neronet-gateway/xray x25519 | sed -n 's/^PrivateKey: *//p')
mkcfg() { # shortid
	cat <<JSON
{"log":{"loglevel":"warning"},"inbounds":[{"tag":"reality-in","listen":"127.0.0.1","port":8445,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"show":false,"dest":"127.0.0.1:9","xver":0,"serverNames":["nero.example.test"],"privateKey":"$priv","shortIds":["$1"]}}}],"outbounds":[{"tag":"block","protocol":"blackhole"}]}
JSON
}
put() { # as the node: its own user, 0600, by rename
	d=/var/lib/neronet-gateway/xray
	mkcfg "$1" | runuser -u neronet-gw -- sh -c "umask 077; cat >$d/.tmp && mv $d/.tmp $d/config.json"
}
put 0123456789abcdef
sleep 3
active neronet-gateway-xray.service && die "xray started although the operator never enabled the service" || true

step "enabled: Xray follows the file"
systemctl enable neronet-gateway-xray.service >/dev/null 2>&1
put 0123456789abcdef
wait_until 15 "xray active after the file appeared" active neronet-gateway-xray.service
wait_until 15 "the xray process to exec the binary" sh -c '[ "$(cat /proc/$(systemctl show -p MainPID --value neronet-gateway-xray.service)/comm 2>/dev/null)" = xray ]'
x1=$(pidof_unit neronet-gateway-xray.service)
[ "$(stat -c %U /proc/"$x1")" = neronet-xray ] || die "xray does not run as neronet-xray"
grep -q '^CapEff:[[:space:]]*0000000000000000' /proc/"$x1"/status || die "xray has capabilities"
grep -q '^NoNewPrivs:[[:space:]]*1' /proc/"$x1"/status || die "xray: NoNewPrivileges not applied"
wait_until 10 "xray listening on loopback 8445" sh -c "ss -Hltn | grep -q '127.0.0.1:8445'"
ss -Hltn | awk '{print $4}' | grep -E ':8445$' | grep -v '^127.0.0.1:' && die "xray listens beyond loopback" || true
echo "xray main pid $x1, user neronet-xray, listening on 127.0.0.1:8445"
[ "$(systemctl show -p MemoryMax --value neronet-gateway-xray.service)" = 536870912 ] || die "xray MemoryMax not applied"

step "xray cannot read the node's state; it holds only a credential copy"
if runuser -u neronet-xray -- cat /var/lib/neronet-gateway/xray/config.json >/dev/null 2>&1; then die "neronet-xray can read the node's file"; fi
ls -l /run/credentials/neronet-gateway-xray.service/ 2>&1 | head -3 || true

step "a changed file restarts Xray"
put fedcba9876543210
wait_until 15 "a new xray process" sh -c "[ \"\$(systemctl show -p MainPID --value neronet-gateway-xray.service)\" != \"$x1\" ] && systemctl is-active --quiet neronet-gateway-xray.service"
echo "restarted: pid $x1 -> $(pidof_unit neronet-gateway-xray.service)"

step "a removed file stops Xray"
rm -f /var/lib/neronet-gateway/xray/config.json
wait_until 15 "xray stopped after the file was removed" sh -c '! systemctl is-active --quiet neronet-gateway-xray.service'
ss -Hltn | grep -q '127.0.0.1:8445' && die "port 8445 still open" || true

step "the node unit stops cleanly"
systemctl stop neronet-gateway-node.service
active neronet-gateway-node.service && die "node still active" || true

step "exposure scores (lower is better)"
for u in neronet-gateway-node neronet-gateway-xray neronet-443-router; do
	printf '%s: ' "$u"; systemd-analyze security --no-pager "$u.service" 2>/dev/null | tail -1
done
echo "SYSTEMD TEST PASSED"
EOF

printf '\n== running under systemd\n'
pm rm -f -t 2 "$NAME" >/dev/null 2>&1 || true
timeout 300 env MSYS_NO_PATHCONV=1 "$ENGINE" run -d --name "$NAME" --privileged --systemd=always \
	-v "$(winpath "$DIST"):/pkg:ro" -v "$(winpath "$WORK"):/w:ro" -e DEB="$DEB" "$IMGTAG" >/dev/null
i=0
until pm exec "$NAME" systemctl is-system-running --wait >/dev/null 2>&1 || [ "$i" -ge 40 ]; do sleep 1; i=$((i + 1)); done
timeout 900 env MSYS_NO_PATHCONV=1 "$ENGINE" exec -e DEB="$DEB" "$NAME" sh /w/inner.sh
