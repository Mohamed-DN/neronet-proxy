#!/usr/bin/env bash
# ==============================================================================
# NeroNet Sovereign Mesh - k6 High-Throughput Load Testing Runner
# Simulates fleet heartbeat load against ephemeral Valkey + PG18 backend
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "======================================================================"
echo "    NERONET k6 100K FLEET LOAD & THROUGHPUT BENCHMARK RUNNER           "
echo "======================================================================"

# Run k6 container against local scenario
echo "--> Running k6 load scenario in Podman container..."
podman run --rm -i \
  --network host \
  -v "$REPO_DIR/tests/load:/scripts:ro" \
  docker.io/grafana/k6:latest \
  run --summary-trend-stats="min,avg,med,p(90),p(95),p(99),max" \
  /scripts/k6_heartbeat_100k.js

echo "======================================================================"
echo "    [OK] k6 LOAD TESTING BENCHMARK COMPLETED SUCCESSFULLY             "
echo "======================================================================"
