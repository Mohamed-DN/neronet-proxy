#!/bin/sh
# Usage: test-remote-gateway.sh
#
# ADR 0043: an nginx stream router (ssl_preread) in front of TCP 443 shares the port between an
# existing REALITY service and the NeroNet gateway, swapped in and out by neronet-443-swap. One
# container runs everything: nginx, two real Xray REALITY servers (the existing service with its
# own key and name; the gateway rendered by pkg/xrayconf), two real Xray clients, the real script.
# Xray is the official release pinned by version and sha256, as in test-vless.sh.
#
# Container tests are serial on this machine: it waits while any container other than darknero-web
# is running, and every run has a timeout.
set -eu
# shellcheck source=engine.sh
. "$(dirname "$0")/engine.sh"

XRAY_VERSION=v26.11.9
XRAY_SHA256=b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82
LIMIT=${RGW_TIMEOUT:-900}

waited=0
while [ -n "$($ENGINE ps --format '{{.Names}}' | grep -v '^darknero-web$' || true)" ]; do
  [ "$waited" -lt 1800 ] || die "another container kept running for 30 minutes"
  echo "another test container is running; checking again in 30 s"
  sleep 30
  waited=$((waited + 30))
done

# shellcheck disable=SC2016
exec timeout "$LIMIT" "$ENGINE" run --rm \
  -e XRAY_VERSION="$XRAY_VERSION" -e XRAY_SHA256="$XRAY_SHA256" \
  -v "$(HOST_PATH "$REPO_ROOT"):/src" \
  -v neronet-gomod:/go/pkg/mod \
  -v neronet-gocache:/root/.cache/go-build \
  -w /src docker.io/library/golang:1.26 sh -c '
    set -eu
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends nginx libnginx-mod-stream openssl curl unzip >/dev/null
    mkdir -p /opt/xray
    curl -fsSL -o /opt/xray/x.zip "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip"
    echo "${XRAY_SHA256}  /opt/xray/x.zip" | sha256sum -c -
    python3 -I -c "import zipfile; zipfile.ZipFile(\"/opt/xray/x.zip\").extract(\"xray\", \"/opt/xray\")"
    chmod +x /opt/xray/xray
    systemctl stop nginx 2>/dev/null || true
    XRAY_BIN=/opt/xray/xray SWAP_SCRIPT=/src/packaging/gateway/sbin/neronet-443-swap \
      go test -tags rgwit -count=1 -v -timeout 600s ./tests/remotegw/'
