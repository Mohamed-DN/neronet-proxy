#!/bin/sh
# Builds an UNSIGNED universal macOS installer for the NeroNet client (ADR 0029, v0).
#
# Not run in this repository's CI and not runnable on Linux: lipo and pkgbuild are macOS tools.
# Run it on a Mac with Go installed:
#
#   scripts/macos/build-pkg.sh 0.1.0
#
# Output goes to ${OUT:-$TMPDIR/neronet-macos-<version>}, not into the repository.
#
# Steps:
#   1. cross-compile arm64 and amd64 binaries with the version stamped in main.version
#   2. join them into one universal binary with lipo
#   3. lay out /usr/local/bin/neronet in a payload directory
#   4. wrap the payload in a .pkg with pkgbuild
#
# No signing: there is no Apple Developer ID, so there is no productsign and no notarytool.
# Users must bypass Gatekeeper; see cmd/neronet-macos/README.md. Signing and notarization
# need an Apple Developer ID, which is the owner's account to create.
set -eu

VERSION=${1:?usage: build-pkg.sh <version>}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-${TMPDIR:-/tmp}/neronet-macos-$VERSION}
IDENTIFIER=com.darknero.neronet

rm -rf "$OUT"
mkdir -p "$OUT/payload/usr/local/bin"
cd "$ROOT"

for arch in arm64 amd64; do
	CGO_ENABLED=0 GOOS=darwin GOARCH=$arch \
		go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
		-o "$OUT/neronet-$arch" ./cmd/neronet-macos/
done

# One file that runs on Apple silicon and on Intel Macs.
lipo -create -output "$OUT/payload/usr/local/bin/neronet" "$OUT/neronet-arm64" "$OUT/neronet-amd64"
chmod 0755 "$OUT/payload/usr/local/bin/neronet"
lipo -info "$OUT/payload/usr/local/bin/neronet"

# --install-location / puts the payload at its absolute paths. The package installs only the
# binary; `sudo neronet install-daemon <profile>` does the rest.
pkgbuild \
	--root "$OUT/payload" \
	--identifier "$IDENTIFIER" \
	--version "$VERSION" \
	--install-location / \
	"$OUT/neronet-$VERSION-macos-universal.pkg"

echo "built (unsigned): $OUT/neronet-$VERSION-macos-universal.pkg"
echo "check with: pkgutil --payload-files $OUT/neronet-$VERSION-macos-universal.pkg"
