#!/bin/sh
# Usage: test-vless.sh
#
# ADR 0036, access method vless-reality: a real Xray-core (official release, pinned by
# version and sha256) is the REALITY terminator and the client, in front of the gateway's
# virtual device, and a mesh node reports the source address it sees. One container: the Go
# toolchain image downloads and verifies the release, then runs the tagged test, which
# starts Xray server and client as processes on loopback.
#
# Bump XRAY_VERSION and XRAY_SHA256 together, from the release page
# https://github.com/XTLS/Xray-core/releases (asset Xray-linux-64.zip, "digest").
set -eu
. "$(dirname "$0")/engine.sh"

XRAY_VERSION=v26.11.9
XRAY_SHA256=b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82

exec $ENGINE run --rm \
  -e XRAY_VERSION="$XRAY_VERSION" -e XRAY_SHA256="$XRAY_SHA256" \
  -v "$(HOST_PATH "$REPO_ROOT"):/src" \
  -v neronet-gomod:/go/pkg/mod \
  -v neronet-gocache:/root/.cache/go-build \
  -w /src docker.io/library/golang:1.26 sh -c '
    set -eu
    mkdir -p /opt/xray
    curl -fsSL -o /opt/xray/x.zip "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip"
    echo "${XRAY_SHA256}  /opt/xray/x.zip" | sha256sum -c -
    python3 -I -c "import zipfile; zipfile.ZipFile(\"/opt/xray/x.zip\").extract(\"xray\", \"/opt/xray\")"
    chmod +x /opt/xray/xray
    XRAY_BIN=/opt/xray/xray go test -tags xrayit -race -count=1 -run XrayReality -v ./pkg/dataplane/'
