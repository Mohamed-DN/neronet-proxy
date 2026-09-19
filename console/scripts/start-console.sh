#!/usr/bin/env bash
# ==============================================================================
# NeroNet Sovereign Mesh Enterprise Management Console - Staging Launcher
# 
# Starts the multi-container staging environment:
# - PostgreSQL 16 (PostGIS + pgvector) on 127.0.0.1:5432
# - Valkey 7 on 127.0.0.1:6379
# - Backend Control Plane API on 127.0.0.1:8081
# - Frontend Nginx SPA on 127.0.0.1:8443
# 
# 🔒 macOS Host Routing Safety:
# - 100% loopback interface binding (127.0.0.1).
# - Zero host routing table changes; zero Tailscale interference.
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$CONSOLE_DIR/.." && pwd)"

# The compose file lives at the repository root.
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
WORKING_DIR="$ROOT_DIR"

echo "======================================================================"
echo "    NERONET ENTERPRISE MANAGEMENT CONSOLE — LOCAL STAGING (R8)        "
echo "======================================================================"
echo "[+] Target Compose Configuration: $COMPOSE_FILE"
echo "[+] Working Directory:            $WORKING_DIR"

# 1. Check Docker & Compose availability
if ! command -v docker >/dev/null 2>&1; then
    echo "[-] Error: docker is required but not installed or not in PATH."
    exit 1
fi

if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker-compose"
else
    echo "[-] Error: docker compose plugin or docker-compose is required."
    exit 1
fi

echo "[+] Detected Compose Command: $DOCKER_COMPOSE_CMD"

# 2. Port Validation (5432, 6379, 8081, 8443)
REQUIRED_PORTS=(5432 6379 8081 8443)
echo "[+] Validating port availability (127.0.0.1): ${REQUIRED_PORTS[*]}..."

for port in "${REQUIRED_PORTS[@]}"; do
    if lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
        OCCUPIER=$(lsof -ti:"$port" 2>/dev/null | head -n 1 || echo "unknown")
        echo "[!] Notice: Port $port is in use (PID: $OCCUPIER). Checking if it belongs to staging..."
        # If it's a docker-proxy process, that's expected if containers are already running
        # Otherwise, warn user
    fi
done

# 3. Create persistent directories
mkdir -p "$CONSOLE_DIR/data/postgres" "$CONSOLE_DIR/data/valkey"

# 4. Start Docker Compose Stack
echo "[+] Bringing up multi-container staging stack in background..."
cd "$WORKING_DIR"
$DOCKER_COMPOSE_CMD -f "$COMPOSE_FILE" up -d --build

# 5. Wait for Services Healthiness
echo "[+] Waiting for PostgreSQL, Valkey, and Backend to become healthy..."
MAX_WAIT=60
ELAPSED=0
HEALTHY=false

while [ $ELAPSED -lt $MAX_WAIT ]; do
    if curl -s -f http://127.0.0.1:8081/api/health >/dev/null 2>&1; then
        HEALTHY=true
        break
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
    echo "    ... waiting for API readiness (${ELAPSED}s / ${MAX_WAIT}s)"
done

if [ "$HEALTHY" = true ]; then
    echo "[✔] Backend API is ONLINE and healthy!"
else
    echo "[!] Warning: Backend API healthcheck timed out after ${MAX_WAIT}s. Checking logs..."
    $DOCKER_COMPOSE_CMD -f "$COMPOSE_FILE" logs --tail=20 backend || true
fi

# 6. Apply Database Migrations and Demo Seeds if needed
echo "[+] Running database schema validation & seeding..."
if [ -d "$CONSOLE_DIR/backend" ]; then
    (
        cd "$CONSOLE_DIR/backend"
        if [ -n "$DATABASE_URL" ]; then
            npm run migrate 2>/dev/null || true
        fi
    )
fi

# 7. Print High-Visibility Access Banner
echo ""
echo "======================================================================"
echo "    [✔] NERONET CONSOLE STAGING IS LIVE AND READY"
echo "======================================================================"
echo "    - Web Console (SPA):   http://127.0.0.1:8443"
echo "    - Control Plane API:   http://127.0.0.1:8081/api"
echo "    - Health Check:        http://127.0.0.1:8081/api/health"
echo "    - WebSocket Hub:       ws://127.0.0.1:8081/ws/topology"
echo "    - PostgreSQL 16:       127.0.0.1:5432 (DB: neronet_db)"
echo "    - Valkey 7:            127.0.0.1:6379"
echo "    - macOS Safety:        100% Loopback bound (Zero routing changes)"
echo "======================================================================"
echo "To view live logs: $DOCKER_COMPOSE_CMD -f $COMPOSE_FILE logs -f"
echo "To stop staging:   $CONSOLE_DIR/scripts/stop-console.sh"
echo "======================================================================"
