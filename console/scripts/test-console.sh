#!/usr/bin/env bash
# ==============================================================================
# NeroNet Sovereign Mesh Enterprise Management Console - Test Suite Runner
# 
# Runs the backend unit and integration tests (node --test). The Python and Node.js
# E2E suites that used to follow were removed: they asserted on data they defined.
# scripts/dev/stack.sh and scripts/dev/smoke.sh check the running stack.
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$CONSOLE_DIR/.." && pwd)"

echo "======================================================================"
echo "    NERONET CONSOLE — FULL TEST SUITE EXECUTION                       "
echo "======================================================================"

# 1. Backend Unit & Integration Tests
echo ""
echo "----------------------------------------------------------------------"
echo "[1/1] Running Backend Unit & Integration Test Suite (node:test)..."
echo "----------------------------------------------------------------------"
(
    cd "$CONSOLE_DIR/backend"
    npm test
)


echo ""
echo "======================================================================"
echo "    [✔] ALL CONSOLE TEST SUITES COMPLETED SUCCESSFULLY (100% PASS)"
echo "======================================================================"
