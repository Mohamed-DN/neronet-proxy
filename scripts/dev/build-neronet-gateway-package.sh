#!/bin/sh
# Builds the neronet-gateway Debian package (ADR 0043) for amd64 and arm64:
#   dist/gateway/neronet-gateway_<version>_<arch>.deb
#   dist/gateway/SHA256SUMS
#
# What is inside: the gateway node (cmd/sovereign-node, static), the pinned Xray-core release
# binary, systemd units, the SNI router example and the neronet-443-swap script. The Xray archive
# is downloaded from the official release page and checked against the sha256 below BEFORE it is
# unpacked; a mismatch stops the build. Bump XRAY_VERSION and both digests together, from the
# release page https://github.com/XTLS/Xray-core/releases ("digest" of each asset). The amd64 pair
# is the same one docker/xray/Dockerfile and test-vless.sh use.
#
# Usage: scripts/dev/build-neronet-gateway-package.sh
# Needs Podman (or Docker), git and sha256sum. The packaging step runs this same script inside
# debian:13-slim with --package. Output is gitignored.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$ROOT/dist/gateway
ARCHES="amd64 arm64"
BUILD=/tmp/neronet-gateway-build
GOIMG=docker.io/library/golang:1.26.11
DEBIMG=docker.io/library/debian:13-slim

XRAY_VERSION=v26.11.9
XRAY_SHA256_AMD64=b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82
XRAY_SHA256_ARM64=64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be

pm() { MSYS_NO_PATHCONV=1 "${NERONET_ENGINE:-podman}" "$@"; }

if command -v cygpath >/dev/null 2>&1; then
	winpath() { cygpath -m "$1"; }
else
	winpath() { printf '%s' "$1"; }
fi

die() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

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
# Inside debian:13-slim: packages what is staged under dist/gateway/stage/<arch>/.
# ---------------------------------------------------------------------------------------------

make_deb() {
	arch=$1
	name=neronet-gateway_${V}_${arch}
	pkg=$BUILD/pkg/$name
	P=$ROOT/packaging/gateway
	rm -rf "$pkg"
	mkdir -p "$pkg/DEBIAN" "$pkg/usr/lib/neronet-gateway" "$pkg/usr/lib/systemd/system" \
		"$pkg/usr/lib/sysusers.d" "$pkg/usr/sbin" "$pkg/etc/neronet-gateway" \
		"$pkg/usr/share/doc/neronet-gateway/examples"

	install -m 0755 "$OUT/stage/$arch/sovereign-node" "$pkg/usr/lib/neronet-gateway/sovereign-node"
	install -m 0755 "$OUT/stage/$arch/xray" "$pkg/usr/lib/neronet-gateway/xray"
	install -m 0755 "$P/sbin/neronet-443-swap" "$pkg/usr/sbin/neronet-443-swap"
	for u in neronet-gateway-node.service neronet-gateway-xray.service neronet-gateway-xray.path \
		neronet-gateway-xray-restart.service neronet-443-router.service; do
		install -m 0644 "$P/$u" "$pkg/usr/lib/systemd/system/$u"
	done
	install -m 0644 "$P/neronet-gateway.sysusers" "$pkg/usr/lib/sysusers.d/neronet-gateway.conf"
	install -m 0600 "$P/node.env" "$pkg/etc/neronet-gateway/node.env"
	install -m 0644 "$P/router/nginx.conf.example" "$pkg/usr/share/doc/neronet-gateway/examples/nginx-sni-router.conf"
	install -m 0644 "$P/swap.conf.example" "$pkg/usr/share/doc/neronet-gateway/examples/swap.conf"
	install -m 0644 "$P/README.md" "$pkg/usr/share/doc/neronet-gateway/README.md"
	install -m 0644 "$OUT/stage/$arch/LICENSE.xray" "$pkg/usr/share/doc/neronet-gateway/LICENSE.xray-core"

	cat >"$pkg/usr/share/doc/neronet-gateway/copyright" <<'EOF'
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: neronet-gateway

Files: *
Copyright: not named in the repository; see the LICENSE file (AGPL-3.0)
License: AGPL-3
 On Debian systems, the complete text of the GNU Affero General Public
 License version 3 can be found in /usr/share/common-licenses/AGPL-3.

Files: usr/lib/neronet-gateway/xray
Copyright: Xray-core contributors
License: MPL-2.0
 The unmodified official release binary of Xray-core, https://github.com/XTLS/Xray-core.
 The licence text is in /usr/share/doc/neronet-gateway/LICENSE.xray-core.
EOF
	{
		printf 'neronet-gateway (%s) unstable; urgency=medium\n\n' "$V"
		printf '  * Profile gateway for a Linux server: VLESS + REALITY behind an SNI router.\n\n'
		printf ' -- %s  %s\n' "$MAINTAINER" "$(date -R -u)"
	} | gzip -9n >"$pkg/usr/share/doc/neronet-gateway/changelog.gz"

	printf '%s\n' /etc/neronet-gateway/node.env >"$pkg/DEBIAN/conffiles"
	install -m 0755 "$P/debian/postinst" "$pkg/DEBIAN/postinst"
	install -m 0755 "$P/debian/prerm" "$pkg/DEBIAN/prerm"
	install -m 0755 "$P/debian/postrm" "$pkg/DEBIAN/postrm"

	size=$(du -sk --exclude=DEBIAN "$pkg" | cut -f1)
	cat >"$pkg/DEBIAN/control" <<EOF
Package: neronet-gateway
Version: $V
Architecture: $arch
Maintainer: $MAINTAINER
Section: net
Priority: optional
Installed-Size: $size
Depends: systemd (>= 247), adduser, openssl
Recommends: nginx | nginx-light | nginx-full
Suggests: libnginx-mod-stream
Description: NeroNet profile gateway for a remote Linux server (VLESS + REALITY)
 Serves NeroNet profile devices over VLESS + REALITY from a server in another
 country, sharing TCP 443 with the TLS service already on that host through an
 SNI router (neronet-443-swap). Nothing is started, enabled or reconfigured by
 installing the package: no service, no firewall rule, no port. The Xray-core
 binary is the unmodified official release, verified by sha256 at build time.
EOF

	mkdir -p "$pkg/usr/share/lintian/overrides"
	printf '%s\n' \
		'neronet-gateway: statically-linked-binary [usr/lib/neronet-gateway/sovereign-node]' \
		'neronet-gateway: statically-linked-binary [usr/lib/neronet-gateway/xray]' \
		>"$pkg/usr/share/lintian/overrides/neronet-gateway"
	chmod 0644 "$pkg/usr/share/lintian/overrides/neronet-gateway"

	find "$pkg" -type d -exec chmod 0755 {} +
	dpkg-deb --root-owner-group --build "$pkg" "$OUT/$name.deb" >/dev/null
	printf 'built %s\n' "$name.deb"
}

package_in_container() {
	V=${NERONET_VERSION:?NERONET_VERSION is not set}
	MAINTAINER="DarkNero <packages@neronet.invalid>"
	rm -rf "$BUILD"
	for arch in $ARCHES; do
		[ -s "$OUT/stage/$arch/sovereign-node" ] || die "missing staged node for $arch"
		[ -s "$OUT/stage/$arch/xray" ] || die "missing staged xray for $arch"
		make_deb "$arch"
	done
	rm -rf "$BUILD" "$OUT/stage"
}

if [ "${1:-}" = "--package" ]; then
	package_in_container
	exit 0
fi

# ---------------------------------------------------------------------------------------------
# On the host.
# ---------------------------------------------------------------------------------------------

for tool in git sha256sum; do
	command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done

# Container work is serial on this machine: wait while another test container is running.
waited=0
while [ -n "$(pm ps --format '{{.Names}}' | grep -v '^darknero-web$' || true)" ]; do
	[ "$waited" -lt 1800 ] || die "another container kept running for 30 minutes"
	printf 'another container is running; checking again in 30 s\n'
	sleep 30
	waited=$((waited + 30))
done

VERSION=$(version_from_git)
printf 'version %s\n' "$VERSION"
WT=$(winpath "$ROOT")
rm -rf "$OUT"
mkdir -p "$OUT"

printf '\n== build static nodes and fetch + verify Xray %s in %s\n' "$XRAY_VERSION" "$GOIMG"
# shellcheck disable=SC2016
timeout 900 "${NERONET_ENGINE:-podman}" run --rm --name neronet-gw-pkg-go \
	-e XRAY_VERSION="$XRAY_VERSION" \
	-e XRAY_SHA256_AMD64="$XRAY_SHA256_AMD64" -e XRAY_SHA256_ARM64="$XRAY_SHA256_ARM64" \
	-v "$WT:/src" \
	-v neronet-gomod:/go/pkg/mod \
	-v neronet-gocache:/root/.cache/go-build \
	-w /src "$GOIMG" sh -c '
set -eu
mkdir -p /tmp/x
for pair in amd64:64:$XRAY_SHA256_AMD64 arm64:arm64-v8a:$XRAY_SHA256_ARM64; do
	arch=${pair%%:*}; rest=${pair#*:}; asset=${rest%%:*}; want=${rest#*:}
	zip=/tmp/x/Xray-linux-$asset.zip
	curl -fsSL -o "$zip" "https://github.com/XTLS/Xray-core/releases/download/$XRAY_VERSION/Xray-linux-$asset.zip"
	echo "$want  $zip" | sha256sum -c -
	mkdir -p dist/gateway/stage/$arch
	python3 -I -c "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); z.extract(\"xray\", sys.argv[2]); z.extract(\"LICENSE\", sys.argv[2])" "$zip" dist/gateway/stage/$arch
	mv dist/gateway/stage/$arch/LICENSE dist/gateway/stage/$arch/LICENSE.xray
	chmod 0755 dist/gateway/stage/$arch/xray
	CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -buildvcs=false \
		-ldflags "-s -w" -o dist/gateway/stage/$arch/sovereign-node ./cmd/sovereign-node
done' || die "build or Xray verification failed"

printf '\n== package in %s\n' "$DEBIMG"
timeout 600 "${NERONET_ENGINE:-podman}" run --rm --name neronet-gw-pkg-deb \
	-e NERONET_VERSION="$VERSION" \
	-v "$WT:/src" \
	-w /src "$DEBIMG" sh /src/scripts/dev/build-neronet-gateway-package.sh --package \
	|| die "packaging failed"

printf '\n== checksums\n'
(cd "$OUT" && sha256sum ./*.deb >SHA256SUMS)
(cd "$OUT" && ls -l ./*.deb SHA256SUMS)
