#!/usr/bin/env bash
# ==============================================================================
# Sovereign Mesh v4.0 - Deterministic Reproducible Build Verifier
# ==============================================================================
export MSYS_NO_PATHCONV=1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT_DIR="$REPO_DIR/reports/provenance"
mkdir -p "$REPORT_DIR"

ENGINE=podman
command -v podman >/dev/null 2>&1 || ENGINE=docker

WIN_PATH="$(cd "$REPO_DIR" && pwd -W 2>/dev/null || pwd)"

echo "======================================================================"
echo "    NERONET REPRODUCIBLE & DETERMINISTIC BUILD VERIFIER               "
echo "======================================================================"
echo "--> Repo Directory: $WIN_PATH"
echo "--> Reports Directory: $REPORT_DIR"

echo "--> Executing dual hermetic compilation in golang:1.26 container..."

BUILD_OUTPUT=$($ENGINE run --rm \
  -v "$WIN_PATH:/src:ro" \
  -v neronet-gomod:/go/pkg/mod \
  -e SOURCE_DATE_EPOCH=1700000000 \
  -e CGO_ENABLED=0 \
  -w /src \
  docker.io/library/golang:1.26 sh -c '
    set -eu
    mkdir -p /tmp/b1 /tmp/b2
    
    # Independent Build 1
    go build -trimpath -ldflags="-s -w -buildid= -X main.Version=4.0.0-rc1" -o /tmp/b1/sovereign-node ./cmd/sovereign-node
    H1=$(sha256sum /tmp/b1/sovereign-node | cut -d" " -f1)
    
    # Flush Go build cache to guarantee cold second compile
    rm -rf /root/.cache/go-build
    
    # Independent Build 2
    go build -trimpath -ldflags="-s -w -buildid= -X main.Version=4.0.0-rc1" -o /tmp/b2/sovereign-node ./cmd/sovereign-node
    H2=$(sha256sum /tmp/b2/sovereign-node | cut -d" " -f1)
    
    echo "BUILD1_SHA256=$H1"
    echo "BUILD2_SHA256=$H2"
  ')

echo "$BUILD_OUTPUT"

HASH1=$(echo "$BUILD_OUTPUT" | grep 'BUILD1_SHA256=' | cut -d= -f2)
HASH2=$(echo "$BUILD_OUTPUT" | grep 'BUILD2_SHA256=' | cut -d= -f2)

if [ -z "$HASH1" ] || [ -z "$HASH2" ]; then
  echo "[ERROR] Failed to obtain build hashes from container output!" >&2
  exit 1
fi

if [ "$HASH1" != "$HASH2" ]; then
  echo "======================================================================"
  echo "[FAIL] NON-DETERMINISTIC BUILD DETECTED!"
  echo "Build 1: $HASH1"
  echo "Build 2: $HASH2"
  echo "======================================================================"
  exit 1
fi

echo "======================================================================"
echo "[OK] DETERMINISTIC BUILD VERIFIED! SHA256 MATCHES ACROSS BUILDS"
echo "Verified Digest: $HASH1"
echo "======================================================================"

echo "$HASH1  sovereign-node" > "$REPORT_DIR/sovereign-node.sha256"
