#!/usr/bin/env bash
# NeroNet v4 - One-Command Installer (WP-601)
# Usage: curl -fsSL https://get.neronet.io | bash
#        bash install.sh [--profile standard|regulated] [--control-url URL]
set -euo pipefail

NERONET_VERSION="4.0.0-rc1"
INSTALL_DIR="${NERONET_INSTALL_DIR:-/opt/neronet}"
DATA_DIR="${NERONET_DATA_DIR:-/var/lib/neronet}"
PROFILE="${NERONET_PROFILE:-standard}"
SYSTEMD_UNIT="neronet.service"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[NeroNet]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
err()     { echo -e "${RED}[ERR]${NC} $*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)     PROFILE="$2";     shift 2 ;;
    --control-url) CONTROL_URL="$2"; shift 2 ;;
    --help|-h) echo "Usage: $0 [--profile standard|regulated]"; exit 0 ;;
    *) err "Unknown: $1" ;;
  esac
done

check_root() { [[ $EUID -eq 0 ]] || err "Run as root: sudo bash install.sh"; }

detect_runtime() {
  if command -v podman &>/dev/null; then COMPOSE_CMD="podman compose"
  elif command -v docker &>/dev/null; then COMPOSE_CMD="docker compose"
  else err "Neither Podman nor Docker found."; fi
  success "Runtime: ${COMPOSE_CMD}"
}

generate_env() {
  local jwt refresh admin_pass reg_token pg_pass
  jwt=$(openssl rand -base64 48)
  refresh=$(openssl rand -base64 48)
  admin_pass=$(openssl rand -base64 18 | tr -d '+/=' | head -c 20)
  reg_token=$(openssl rand -hex 32)
  pg_pass=$(openssl rand -base64 18 | tr -d '+/=' | head -c 20)

  cat > "${INSTALL_DIR}/.env" <<ENVEOF
POSTGRES_PASSWORD=${pg_pass}
SOVEREIGN_JWT_SECRET=${jwt}
SOVEREIGN_REFRESH_SECRET=${refresh}
SOVEREIGN_ADMIN_PASS=${admin_pass}
SOVEREIGN_REGISTRATION_TOKEN=${reg_token}
NERONET_CONSOLE_PORT=8443
NERONET_API_PORT=8081
SOVEREIGN_FEATURE_CLOUD_PC=false
NERONET_MAX_NETMAP_STALENESS_SECONDS=86400
ENVEOF
  chmod 600 "${INSTALL_DIR}/.env"

  echo ""
  echo "=================================================="
  echo "  NeroNet v4 - SAVE THESE CREDENTIALS"
  echo "=================================================="
  printf "  Admin User    : admin\n"
  printf "  Admin Pass    : %s\n" "${admin_pass}"
  printf "  Console       : http://127.0.0.1:8443\n"
  printf "  API           : http://127.0.0.1:8081\n"
  echo "=================================================="
  warn "These credentials will NOT be shown again!"
}

install_systemd() {
  cat > "/etc/systemd/system/${SYSTEMD_UNIT}" <<SVCEOF
[Unit]
Description=NeroNet v4 Sovereign Mesh
Requires=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${COMPOSE_CMD} up -d --remove-orphans
ExecStop=${COMPOSE_CMD} down
TimeoutStartSec=300
Restart=on-failure

[Install]
WantedBy=multi-user.target
SVCEOF
  systemctl daemon-reload
  systemctl enable "${SYSTEMD_UNIT}"
  systemctl start "${SYSTEMD_UNIT}"
  success "Systemd service active"
}

wait_healthy() {
  info "Waiting for services (up to 120s)..."
  local end=$((SECONDS + 120))
  while [[ $SECONDS -lt $end ]]; do
    local h; h=$(${COMPOSE_CMD} -f "${INSTALL_DIR}/docker-compose.yml" ps 2>/dev/null | grep -c "healthy" || true)
    [[ "$h" -ge 2 ]] && { success "Services healthy!"; return 0; }
    echo -n "."; sleep 5
  done
  warn "Timeout - check: ${COMPOSE_CMD} ps"
}

main() {
  check_root
  detect_runtime
  mkdir -p "${INSTALL_DIR}" "${DATA_DIR}"
  
  # Copy compose from script dir or download
  if [[ -f "$(dirname "$0")/../docker-compose.yml" ]]; then
    cp "$(dirname "$0")/../docker-compose.yml" "${INSTALL_DIR}/docker-compose.yml"
  fi
  
  generate_env

  if command -v systemctl &>/dev/null; then
    install_systemd
  else
    cd "${INSTALL_DIR}" && ${COMPOSE_CMD} up -d
  fi

  wait_healthy
  success "NeroNet v4 installed!"
  echo "  Console -> http://127.0.0.1:8443"
  echo "  API     -> http://127.0.0.1:8081/api/health"
}

main "$@"
