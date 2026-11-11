#!/bin/sh
# Builds the neronet Linux client for installation (ADR 0029, version 0):
#   dist/linux/neronet_<version>_<arch>.deb         Debian package, built in debian:13-slim
#   dist/linux/neronet-<version>-linux-<arch>.tar.gz  binary, unit, README, LICENSE
#   dist/linux/SHA256SUMS
# for linux/amd64 and linux/arm64. The binaries are static (CGO_ENABLED=0).
#
# Usage: scripts/dev/build-neronet-linux-packages.sh
# Needs Podman, git and sha256sum; on Windows, run it from Git Bash. Output is gitignored.
#
# The packaging step runs this same script inside debian:13-slim with --package, so the .deb
# and the tarballs come from the container's dpkg-deb and tar, not from the host.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$ROOT/dist/linux
ARCHES="amd64 arm64"
# Package trees live in the container, not on the bind mount: mount permissions are not kept.
BUILD=/tmp/neronet-build
GOIMG=docker.io/library/golang:1.26.10
DEBIMG=docker.io/library/debian:13-slim
# The t0p1 run holds this file while it is busy; container builds wait while it exists.
GATE=${NEURONET_E2E_GATE:-/c/AI/NeroNet/piano/reports/logs-t0p1/DERP_RUNNING}

# Podman on Windows must not rewrite the arguments; the wrapper keeps that in one place.
pm() { MSYS_NO_PATHCONV=1 podman "$@"; }

if command -v cygpath >/dev/null 2>&1; then
	winpath() { cygpath -m "$1"; }
else
	winpath() { printf '%s' "$1"; }
fi

die() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

# The version comes from git and is made valid for dpkg: Debian versions start with a digit
# and may hold only alphanumerics and . + ~; a git hash alone becomes 0+git<hash>.
version_from_git() {
	raw=$(git -C "$ROOT" describe --tags --always 2>/dev/null) || raw=$(git -C "$ROOT" rev-parse --short HEAD)
	v=${raw#v}
	v=$(printf '%s' "$v" | tr '-' '+' | tr -c 'A-Za-z0-9.+~' '.')
	case $v in
	[0-9]*) ;;
	*) v="0+git$v" ;;
	esac
	printf '%s' "$v"
}

# ---------------------------------------------------------------------------------------------
# Inside debian:13-slim: packages the binaries staged under dist/linux/stage/<arch>/.
# ---------------------------------------------------------------------------------------------

make_deb() {
	arch=$1
	name=neronet_${V}_${arch}
	pkg=$BUILD/pkg/$name
	rm -rf "$pkg"
	mkdir -p "$pkg/DEBIAN" "$pkg/usr/bin" "$pkg/usr/lib/systemd/system" "$pkg/usr/share/doc/neronet"

	install -m 0755 "$OUT/stage/$arch/neronet" "$pkg/usr/bin/neronet"
	install -m 0644 "$ROOT/packaging/linux/neronet@.service" "$pkg/usr/lib/systemd/system/neronet@.service"
	install -m 0644 "$ROOT/packaging/linux/README.md" "$pkg/usr/share/doc/neronet/README.md"
	install -m 0644 "$ROOT/packaging/linux/LEGGIMI.md" "$pkg/usr/share/doc/neronet/LEGGIMI.md"

	cat >"$pkg/usr/share/doc/neronet/copyright" <<'EOF'
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: neronet

Files: *
Copyright: not named in the repository; see the LICENSE file (AGPL-3.0)
License: AGPL-3
 On Debian systems, the complete text of the GNU Affero General Public
 License version 3 can be found in /usr/share/common-licenses/AGPL-3.
EOF

	{
		printf 'neronet (%s) unstable; urgency=medium\n\n' "$V"
		printf '  * Linux client for NeroNet profiles: up, down, status, version.\n\n'
		printf ' -- %s  %s\n' "$MAINTAINER" "$(date -R -u)"
	} | gzip -9n >"$pkg/usr/share/doc/neronet/changelog.gz"

	cat >"$pkg/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
# Only reload unit files; the service is never started or enabled by the package.
if [ "$1" = configure ] && [ -d /run/systemd/system ]; then
	systemctl daemon-reload || true
fi
exit 0
EOF
	chmod 0755 "$pkg/DEBIAN/postinst"

	size=$(du -sk --exclude=DEBIAN "$pkg" | cut -f1)
	cat >"$pkg/DEBIAN/control" <<EOF
Package: neronet
Version: $V
Architecture: $arch
Maintainer: $MAINTAINER
Section: net
Priority: optional
Installed-Size: $size
Depends: nftables
Recommends: systemd-resolved
Description: Tunnel client for NeroNet profiles
 neronet brings a NeroNet profile up as a WireGuard tunnel: it creates the TUN
 interface, sets addresses and routes, configures DNS through systemd-resolved
 and, with the kill switch, uses nftables to block traffic outside the tunnel.
 Run one profile per instance of the neronet@.service unit.
EOF

	# The Go binary is static on purpose (CGO_ENABLED=0): it needs no libc on the target.
	mkdir -p "$pkg/usr/share/lintian/overrides"
	printf '%s\n' 'neronet: statically-linked-binary [usr/bin/neronet]' \
		>"$pkg/usr/share/lintian/overrides/neronet"
	chmod 0644 "$pkg/usr/share/lintian/overrides/neronet"

	find "$pkg" -type d -exec chmod 0755 {} +
	dpkg-deb --root-owner-group --build "$pkg" "$OUT/$name.deb" >/dev/null
	printf 'built %s\n' "$name.deb"
}

make_tar() {
	arch=$1
	dir=neronet-${V}-linux-${arch}
	stage=$BUILD/tar/$dir
	rm -rf "$stage"
	mkdir -p "$stage"
	install -m 0755 "$OUT/stage/$arch/neronet" "$stage/neronet"
	install -m 0644 "$ROOT/packaging/linux/neronet@.service" "$stage/neronet@.service"
	install -m 0644 "$ROOT/packaging/linux/README.md" "$stage/README.md"
	install -m 0644 "$ROOT/LICENSE" "$stage/LICENSE"
	tar --owner=0 --group=0 --numeric-owner -C "$BUILD/tar" -czf "$OUT/$dir.tar.gz" "$dir"
	printf 'built %s.tar.gz\n' "$dir"
}

package_in_container() {
	V=${NEURONET_VERSION:?NEURONET_VERSION is not set}
	MAINTAINER="DarkNero <packages@neronet.invalid>"
	rm -rf "$BUILD"
	for arch in $ARCHES; do
		[ -s "$OUT/stage/$arch/neronet" ] || die "missing staged binary for $arch"
		make_deb "$arch"
		make_tar "$arch"
	done
	rm -rf "$BUILD" "$OUT/stage"
}

if [ "${1:-}" = "--package" ]; then
	package_in_container
	exit 0
fi

# ---------------------------------------------------------------------------------------------
# On the host: build the binaries in the Go container, then package in debian:13-slim.
# ---------------------------------------------------------------------------------------------

wait_gate() {
	while [ -e "$GATE" ]; do
		printf '%s exists; checking again in 120 s\n' "$GATE"
		sleep 120
	done
}

for tool in git podman sha256sum; do
	command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done

VERSION=$(version_from_git)
printf 'version %s\n' "$VERSION"
WT=$(winpath "$ROOT")
rm -rf "$OUT"
mkdir -p "$OUT"

printf '\n== build static binaries (CGO_ENABLED=0) in %s\n' "$GOIMG"
wait_gate
# -buildvcs=false: in a git worktree the .git file points outside the mount, so VCS stamping fails.
# shellcheck disable=SC2016
pm run --rm --name neronet-pkg-go \
	-e NEURONET_VERSION="$VERSION" \
	-v "$WT:/src" \
	-v neronet-gomod:/go/pkg/mod \
	-v neronet-gocache:/root/.cache/go-build \
	-w /src "$GOIMG" sh -c '
set -eu
for arch in amd64 arm64; do
	mkdir -p dist/linux/stage/$arch
	CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -buildvcs=false \
		-ldflags "-s -w -X main.version=$NEURONET_VERSION" \
		-o dist/linux/stage/$arch/neronet ./cmd/neronet-linux
done' || die "go build failed"

printf '\n== package in %s\n' "$DEBIMG"
wait_gate
pm run --rm --name neronet-pkg-deb \
	-e NEURONET_VERSION="$VERSION" \
	-v "$WT:/src" \
	-w /src "$DEBIMG" sh /src/scripts/dev/build-neronet-linux-packages.sh --package \
	|| die "packaging failed"

printf '\n== checksums\n'
(cd "$OUT" && sha256sum ./*.deb ./*.tar.gz >SHA256SUMS)
(cd "$OUT" && ls -l ./*.deb ./*.tar.gz SHA256SUMS)
