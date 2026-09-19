#!/usr/bin/env bash
# ==============================================================================
# NeroNet Sovereign Mesh Enterprise Management Console - Graceful Shutdown
# 
# Gracefully stops all staging containers and frees allocated loopback ports.
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$CONSOLE_DIR/.." && pwd)"

# The compose file lives at the repository root.
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
WORKING_DIR="$ROOT_DIR"

echo "======================================================================"
echo "    STOPPING NERONET ENTERPRISE MANAGEMENT CONSOLE STAGING            "
echo "======================================================================"

if command -v docker >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then
        DOCKER_COMPOSE_CMD="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        DOCKER_COMPOSE_CMD="docker-compose"
    fi

    if [ -n "$DOCKER_COMPOSE_CMD" ]; then
        echo "[+] Stopping Docker Compose services ($COMPOSE_FILE)..."
        $DOCKER_COMPOSE_CMD -f "$COMPOSE_FILE" down || true
    fi
fi

# Kill any lingering node/vite processes on staging ports if needed
PORTS=(8081 8082 8443 5432 6379)
for port in "${PORTS[@]}"; do
    PIDS=$(lsof -ti:"$port" 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
        echo "[+] Releasing port $port (Killing PIDs: $PIDS)..."
        kill -15 $PIDS 2>/dev/null || kill -9 $PIDS 2>/dev/null || true
    fi
done

echo "[✔] All NeroNet Console staging processes stopped cleanly."
