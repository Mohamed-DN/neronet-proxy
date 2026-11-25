#!/bin/sh
# Usage: test-neronet-gateway-package.sh [amd64|arm64]
#
# Installs the neronet-gateway .deb in a clean debian:13-slim container and checks the promises
# of ADR 0043:
#   - installing starts nothing, enables nothing, adds no listening socket, writes no firewall
#     rule and leaves every pre-existing service and file as it was;
#   - the node, Xray (the pinned version) and the swap script run on this architecture;
#   - systemd-analyze accepts every unit and reports its exposure;
#   - remove keeps the configuration and the users, purge deletes state, configuration and users.
# arm64 runs under qemu when the engine has it (podman machine usually does); if the engine
# cannot start an arm64 container the script says so and exits 3 instead of passing.
#
# Needs dist/gateway/neronet-gateway_*_<arch>.deb from build-neronet-gateway-package.sh.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ARCH=${1:-amd64}
DIST=$ROOT/dist/gateway
IMG=docker.io/library/debian:13-slim
NAME=neronet-gateway-pkgtest-$ARCH
ENGINE=${NERONET_ENGINE:-podman}

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

set -- "$DIST"/neronet-gateway_*_"$ARCH".deb
[ -f "$1" ] || die "no $ARCH package in $DIST; run scripts/dev/build-neronet-gateway-package.sh first"
[ "$#" -eq 1 ] || die "more than one $ARCH package in $DIST"
DEB=$(basename "$1")

waited=0
while [ -n "$(pm ps --format '{{.Names}}' | grep -v '^darknero-web$' || true)" ]; do
	[ "$waited" -lt 1800 ] || die "another container kept running for 30 minutes"
	printf 'another container is running; checking again in 30 s\n'
	sleep 30
	waited=$((waited + 30))
done

WORK=$(mktemp -d)
trap 'pm rm -f -t 0 "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

cat >"$WORK/inner.sh" <<'EOF'
set -eu
export DEBIAN_FRONTEND=noninteractive
step() { printf '\n== %s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
listeners() { cat /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6 2>/dev/null | awk '$1 != "sl" {print $2, $4}' | sort; }

step "arch"
uname -m
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends ca-certificates >/dev/null

# A pre-existing service of the host, and its files, that the package must not touch.
mkdir -p /etc/other-service
echo "keep" >/etc/other-service/conf
before_files=$(find /etc /usr/lib/systemd/system -maxdepth 2 -type f | sort | sha256sum)
before_listen=$(listeners | sha256sum)

step "install"
apt-get install -y -qq --no-install-recommends /pkg/"$DEB" >/dev/null
dpkg -s neronet-gateway | grep -E '^(Status|Version|Architecture):'

step "install started nothing, enabled nothing, opened nothing"
[ "$(listeners | sha256sum)" = "$before_listen" ] || die "a listening socket appeared"
if command -v systemctl >/dev/null 2>&1; then
	for u in neronet-gateway-node.service neronet-gateway-xray.service neronet-gateway-xray.path neronet-443-router.service; do
		st=$(systemctl is-enabled "$u" 2>&1 || true)
		case $st in
		enabled*) die "$u is enabled" ;;
		esac
	done
fi
ls /etc/systemd/system/multi-user.target.wants 2>/dev/null | grep -i neronet && die "a unit was wanted by multi-user.target" || true
[ "$(cat /etc/other-service/conf)" = keep ] || die "another service's file changed"
command -v nft >/dev/null 2>&1 && [ -n "$(nft list ruleset 2>/dev/null)" ] && die "a firewall rule appeared" || true
ps -eo comm | grep -E '^(sovereign-node|xray|nginx)$' && die "a process was started" || true

step "files, modes and users"
for f in /usr/lib/neronet-gateway/sovereign-node /usr/lib/neronet-gateway/xray /usr/sbin/neronet-443-swap; do
	[ -x "$f" ] || die "$f is missing or not executable"
done
[ "$(stat -c %a /etc/neronet-gateway/node.env)" = 600 ] || die "node.env is not 0600"
for u in neronet-gw neronet-xray neronet-router; do
	getent passwd "$u" >/dev/null || die "user $u missing"
	shell=$(getent passwd "$u" | cut -d: -f7)
	case $shell in */nologin | */false) ;; *) die "$u has a login shell: $shell" ;; esac
done
id neronet-gw; id neronet-xray; id neronet-router

step "binaries run on this architecture"
/usr/lib/neronet-gateway/xray version | head -1 | grep -F "Xray 26.11.9" || die "wrong Xray version"
file_out=$(od -An -tx1 -N20 /usr/lib/neronet-gateway/sovereign-node | tr -d ' \n')
printf 'sovereign-node ELF header: %s\n' "$file_out"
/usr/lib/neronet-gateway/sovereign-node -h 2>&1 | grep -F -- "-vless-listen" >/dev/null || die "the node does not know -vless-listen"
bash -n /usr/sbin/neronet-443-swap
/usr/sbin/neronet-443-swap --help | head -3

step "units"
for u in neronet-gateway-node.service neronet-gateway-xray.service neronet-gateway-xray.path neronet-gateway-xray-restart.service neronet-443-router.service; do
	systemd-analyze verify "/usr/lib/systemd/system/$u" 2>&1 | grep -v -E "nginx|Failed to prepare|not executable|No such file" || true
done
for u in neronet-gateway-node.service neronet-gateway-xray.service neronet-443-router.service; do
	printf '%s: ' "$u"
	systemd-analyze security --offline=true --no-pager "/usr/lib/systemd/system/$u" 2>/dev/null | tail -1
done

step "pre-existing files untouched"
after_files=$(find /etc /usr/lib/systemd/system -maxdepth 2 -type f -not -path '*neronet*' -not -path '/etc/passwd*' -not -path '/etc/group*' -not -path '/etc/shadow*' -not -path '/etc/gshadow*' -not -path '/etc/subuid*' -not -path '/etc/subgid*' -not -path '/etc/ld.so.cache' -not -path '/etc/alternatives/*' -not -path '/etc/systemd/*' -not -path '/etc/apt/*' -not -path '/etc/ssl/*' -not -path '/etc/ca-certificates*' | wc -l)
printf 'other files: %s\n' "$after_files"
[ "$(cat /etc/other-service/conf)" = keep ] || die "other-service changed"

step "remove keeps configuration and users"
echo "operator-edit" >>/etc/neronet-gateway/node.env
mkdir -p /var/lib/neronet-gateway && echo state >/var/lib/neronet-gateway/node_identity.key
apt-get remove -y -qq neronet-gateway >/dev/null
[ ! -e /usr/lib/neronet-gateway/xray ] || die "binaries survived remove"
grep -q operator-edit /etc/neronet-gateway/node.env || die "remove deleted the operator's configuration"
[ -f /var/lib/neronet-gateway/node_identity.key ] || die "remove deleted state"
getent passwd neronet-gw >/dev/null || die "remove deleted a user"

step "purge deletes state, configuration and users"
apt-get purge -y -qq neronet-gateway >/dev/null
[ ! -e /etc/neronet-gateway ] || die "purge left the configuration"
[ ! -e /var/lib/neronet-gateway ] || die "purge left state"
for u in neronet-gw neronet-xray neronet-router; do
	! getent passwd "$u" >/dev/null || die "purge left user $u"
done
[ "$(cat /etc/other-service/conf)" = keep ] || die "purge touched another service"

step "lintian"
apt-get install -y -qq --no-install-recommends lintian >/dev/null
apt-get install -y -qq --no-install-recommends /pkg/"$DEB" >/dev/null 2>&1 || true
lintian --no-tag-display-limit /pkg/"$DEB" >/out/lintian.txt 2>&1 || true
grep -E '^E:' /out/lintian.txt && die "lintian reports errors" || true
grep -E '^W:' /out/lintian.txt || true
echo "PACKAGE TEST PASSED"
EOF

mkdir -p "$WORK/out"
printf '\n== %s in %s (%s)\n' "$DEB" "$IMG" "$ARCH"
if ! pm run --rm --platform "linux/$ARCH" "$IMG" uname -m >/dev/null 2>&1; then
	printf 'cannot start a linux/%s container with this engine\n' "$ARCH" >&2
	exit 3
fi
timeout 900 "$ENGINE" run --rm --name "$NAME" --platform "linux/$ARCH" \
	-e DEB="$DEB" \
	-v "$(winpath "$DIST"):/pkg:ro" -v "$(winpath "$WORK"):/w" -v "$(winpath "$WORK/out"):/out" \
	"$IMG" sh /w/inner.sh
