#!/usr/bin/env bash
# NeroNet v4 - One-Command Installer (WP-601)
# Usage: curl -fsSL https://get.neronet.io | bash
#        bash install.sh [--profile standard|regulated]
#
# Rerunning it is safe: an existing .env (secrets, and the database password the data
# volume was created with) is kept as it is. The install fails, with a non-zero exit,
# when the stack does not become healthy. No secret is ever printed.
set -euo pipefail

NERONET_VERSION="4.0.0-rc1"
INSTALL_DIR="${NERONET_INSTALL_DIR:-/opt/neronet}"
DATA_DIR="${NERONET_DATA_DIR:-/var/lib/neronet}"
PROFILE="${NERONET_PROFILE:-standard}"
SYSTEMD_UNIT="neronet.service"
HEALTH_TIMEOUT="${NERONET_INSTALL_HEALTH_TIMEOUT:-120}"
# postgres, valkey, backend and the console: the services with a health check.
HEALTHY_SERVICES="${NERONET_INSTALL_HEALTHY_SERVICES:-4}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[NeroNet]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
err()     { echo -e "${RED}[ERR]${NC} $*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)     PROFILE="$2";     shift 2 ;;
    # Accepted before and then ignored. It configures nothing this installer sets up, so
    # it is refused rather than letting an operator believe it took effect.
    --control-url) err "--control-url is not supported by this installer" ;;
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
  # A new .env on a rerun would hand the stack fresh secrets and a database password
  # the existing data volume was not created with: keep what is there.
  if [[ -e "${INSTALL_DIR}/.env" ]]; then
    info "Keeping the existing ${INSTALL_DIR}/.env"
    return 0
  fi
  local jwt refresh audit_hmac shred_kek admin_pass reg_token pg_pass
  jwt=$(openssl rand -base64 48)
  refresh=$(openssl rand -base64 48)
  audit_hmac=$(openssl rand -base64 48)
  shred_kek=$(openssl rand -base64 48)
  admin_pass=$(openssl rand -base64 18 | tr -d '+/=' | head -c 20)
  reg_token=$(openssl rand -hex 32)
  pg_pass=$(openssl rand -base64 18 | tr -d '+/=' | head -c 20)

  ( umask 077; cat > "${INSTALL_DIR}/.env" ) <<ENVEOF
POSTGRES_PASSWORD=${pg_pass}
SOVEREIGN_JWT_SECRET=${jwt}
SOVEREIGN_REFRESH_SECRET=${refresh}
SOVEREIGN_AUDIT_HMAC_SECRET=${audit_hmac}
SOVEREIGN_SHRED_KEK_SECRET=${shred_kek}
SOVEREIGN_ADMIN_PASS=${admin_pass}
SOVEREIGN_REGISTRATION_TOKEN=${reg_token}
NERONET_CONSOLE_PORT=8443
NERONET_API_PORT=8081
SOVEREIGN_FEATURE_CLOUD_PC=false
NERONET_MAX_NETMAP_STALENESS_SECONDS=86400
ENVEOF
  chmod 600 "${INSTALL_DIR}/.env"

  success "Wrote ${INSTALL_DIR}/.env (mode 600, readable by root only)"
  info "Admin user: admin. Its password is SOVEREIGN_ADMIN_PASS in that file; it is not printed."
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
  info "Waiting for services (up to ${HEALTH_TIMEOUT}s)..."
  local end=$((SECONDS + HEALTH_TIMEOUT))
  while [[ $SECONDS -lt $end ]]; do
    # "(healthy)" only: a bare "healthy" also matches "(unhealthy)".
    local h; h=$(${COMPOSE_CMD} -f "${INSTALL_DIR}/docker-compose.yml" ps 2>/dev/null | grep -c "(healthy)" || true)
    [[ "$h" -ge "$HEALTHY_SERVICES" ]] && { success "Services healthy!"; return 0; }
    echo -n "."; sleep 5
  done
  warn "Not healthy after ${HEALTH_TIMEOUT}s - check: ${COMPOSE_CMD} ps"
  return 1
}

main() {
  check_root
  detect_runtime
  mkdir -p "${INSTALL_DIR}" "${DATA_DIR}"
  
  # The compose file ships next to the installer. Without it there is nothing to
  # start, and carrying on would end in a "healthy" check of an empty directory.
  local compose
  compose="$(dirname "$0")/../docker-compose.yml"
  [[ -f "$compose" ]] || err "No docker-compose.yml next to the installer ($compose)"
  cp "$compose" "${INSTALL_DIR}/docker-compose.yml"
  
  generate_env

  if command -v systemctl &>/dev/null; then
    install_systemd
  else
    cd "${INSTALL_DIR}" && ${COMPOSE_CMD} up -d
  fi

  wait_healthy || err "Installation failed: the stack did not become healthy"
  success "NeroNet v4 installed!"
  echo "  Console -> https://127.0.0.1:8443"
  echo "  API     -> http://127.0.0.1:8081/api/health"
}

main "$@"
