#!/bin/sh
# Installs the amd64 neronet .deb in a fresh debian:13-slim container and checks it:
#   - apt installs it with its dependencies (nftables, systemd-resolved as a recommendation);
#   - `neronet version` runs;
#   - neronet@.service is in place and `systemd-analyze verify` accepts an instance of it;
#   - the package removes cleanly (files gone, not in the installed state);
#   - lintian reports no errors (warnings are printed).
#
# Needs dist/linux/neronet_*_amd64.deb, made by scripts/dev/build-neronet-linux-packages.sh,
# and network access to pull docker.io/library/debian:13-slim. On Windows, run it from Git Bash.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIST=$ROOT/dist/linux
IMG=docker.io/library/debian:13-slim
NAME=neronet-pkgtest
# The t0p1 run holds this file while it is busy; the container waits while it exists.
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
die() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

cleanup() {
	status=$?
	pm rm -f -t 0 "$NAME" >/dev/null 2>&1 || true
	rm -rf "$WORK"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

step "preflight"
pm version >/dev/null 2>&1 || die "podman is not reachable"
set -- "$DIST"/neronet_*_amd64.deb
[ -f "$1" ] || die "no amd64 package in $DIST; run scripts/dev/build-neronet-linux-packages.sh first"
[ "$#" -eq 1 ] || die "more than one amd64 package in $DIST; keep only the one to test"
note=$(basename "$1")
printf '   package: %s\n' "$note"

# The container runs this script; it reads the package from /pkg and writes lintian output to /out.
cat >"$WORK/inner.sh" <<'EOF'
set -eu
export DEBIAN_FRONTEND=noninteractive
step() { printf '\n== %s\n' "$*"; }
die() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

DEB=$(ls /pkg/neronet_*_amd64.deb)

step "apt-get update"
apt-get update -qq

step "install $(basename "$DEB") with its dependencies"
apt-get install -y -qq "$DEB" >/tmp/install.log 2>&1 || {
	cat /tmp/install.log >&2
	die "apt-get install failed"
}
STATUS=$(dpkg-query -W -f='${db:Status-Abbrev}' neronet)
[ "$STATUS" = "ii " ] || die "package state after install is '$STATUS'"
printf '   installed: %s\n' "$(dpkg-query -W -f='${Version} (${Architecture}), depends: ${Depends}' neronet)"
dpkg-query -W -f='${Depends}\n' neronet | grep -q nftables || die "nftables is not a dependency"

step "neronet version"
VERSION_OUT=$(neronet version) || die "neronet version exited non-zero"
printf '   %s\n' "$VERSION_OUT"
case "$VERSION_OUT" in
"neronet "*) ;;
*) die "unexpected output from neronet version" ;;
esac

step "unit file and systemd-analyze verify"
UNIT=/usr/lib/systemd/system/neronet@.service
[ -f "$UNIT" ] || die "$UNIT is missing"
grep -q '^ExecStart=/usr/bin/neronet up /etc/neronet/%i.conf --kill-switch$' "$UNIT" ||
	die "ExecStart line not as expected"
apt-get install -y -qq systemd >/tmp/systemd.log 2>&1 || {
	cat /tmp/systemd.log >&2
	die "apt-get install systemd failed"
}
mkdir -p /tmp/verify
cp "$UNIT" /tmp/verify/neronet@example.service
systemd-analyze verify /tmp/verify/neronet@example.service ||
	die "systemd-analyze verify rejected the unit"
printf '   systemd-analyze verify: accepted\n'

step "lintian"
apt-get install -y -qq lintian >/tmp/lintian-install.log 2>&1 || {
	cat /tmp/lintian-install.log >&2
	die "apt-get install lintian failed"
}
lintian "$DEB" >/out/lintian.txt 2>&1 || true
cat /out/lintian.txt
ERRORS=$(grep -c '^E: ' /out/lintian.txt || true)
WARNINGS=$(grep -c '^W: ' /out/lintian.txt || true)
printf '   lintian: %s errors, %s warnings\n' "$ERRORS" "$WARNINGS"
[ "$ERRORS" -eq 0 ] || die "lintian reported $ERRORS errors"

step "remove the package"
apt-get remove -y -qq neronet >/tmp/remove.log 2>&1 || {
	cat /tmp/remove.log >&2
	die "apt-get remove failed"
}
STATUS=$(dpkg-query -W -f='${db:Status-Abbrev}' neronet 2>/dev/null || true)
case "$STATUS" in
"ii "*|"hi "*|"iF "*) die "package still installed after remove: '$STATUS'" ;;
esac
[ ! -e /usr/bin/neronet ] || die "/usr/bin/neronet is still there"
[ ! -e "$UNIT" ] || die "$UNIT is still there"
printf '   removed; package state: %s\n' "${STATUS:-not-installed}"

step "purge the package"
# The package has no conffiles, so remove leaves no config state; purge only runs if one is left.
if [ "$STATUS" = "rc " ]; then
	apt-get purge -y -qq neronet >/tmp/purge.log 2>&1 || {
		cat /tmp/purge.log >&2
		die "apt-get purge failed"
	}
fi
PSTATUS=$(dpkg-query -W -f='${db:Status-Abbrev}' neronet 2>/dev/null || true)
case "$PSTATUS" in
"ii "*|"hi "*|"rc "*) die "package state after purge: '$PSTATUS'" ;;
esac
printf '   purged; package state: %s\n' "${PSTATUS:-not-installed}"

step "container result"
printf '   PASS\n'
EOF

step "wait for the t0p1 gate, then run the container"
while [ -e "$GATE" ]; do
	printf '   %s exists; checking again in 120 s\n' "$GATE"
	sleep 120
done

pm run --rm --name "$NAME" \
	-v "$(winpath "$DIST"):/pkg:ro" \
	-v "$(winpath "$WORK"):/out" \
	"$IMG" sh /out/inner.sh || die "package test failed in $IMG"

step "result"
printf '   PASS: %s installs, runs, verifies and removes cleanly; lintian has no errors\n' "$note"
