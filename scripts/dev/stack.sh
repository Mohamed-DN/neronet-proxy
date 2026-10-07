#!/bin/sh
# Usage: stack.sh up | nodes | fleet | backup | down [compose args] | status | logs [compose args] [service]
#
#   up      build and start postgres, valkey, backend and console, wait until healthy.
#           The console is https://127.0.0.1:8443; certs/ca.crt is the CA to trust,
#           written by gen-certs.sh on the first run
#   nodes   start the two DERP relays and six Go nodes (starts the core first if needed)
#   fleet   start the simulated fleet written by scripts/sim/fleet.mjs (see scripts/sim/README.md)
#   backup  start the backup service and wait for its first backup (needs RESTIC_PASSWORD
#           in .env: gen-env.sh --append-missing adds it to an older .env)
#   down    stop and remove the stack's containers and network; add -v to drop its volumes
#   status  service health, how many nodes sent a heartbeat in the last 60 s, and what the
#           backup service last did
#   logs    last 200 lines of every service, or of one; pass -f to follow
#
# Environment:
#   COMPOSE_PROJECT_NAME   stack name. Default: the checkout folder name, as Compose does.
#                          Use a different name for each stack running at the same time.
#   NERONET_PORT_OFFSET    added to every default host port (console 8443, API 8081,
#                          DERP 8444/8445, STUN 3478/3479, debug 5432/6379)
#   NERONET_<NAME>_PORT    sets one port explicitly and wins over the offset:
#                          CONSOLE, API, DERP_EU, DERP_US, STUN_EU, STUN_US, POSTGRES, VALKEY
#   NERONET_DEBUG_PORTS=1  also publish PostgreSQL and Valkey on 127.0.0.1
#   NERONET_FLEET_FILE     the compose override the fleet generator wrote, relative to the repository
#                          root. Default: scripts/sim/out/docker-compose.fleet.yml. When the file
#                          exists every command includes it, so `down` removes the fleet as well.
set -eu
. "$(dirname "$0")/engine.sh"

cmd=${1:-}
[ $# -gt 0 ] && shift

# Ports: an explicit variable wins, otherwise the default plus the offset.
OFFSET=${NERONET_PORT_OFFSET:-0}
default_port() {
  eval "_cur=\${$1:-}"
  if [ -z "$_cur" ]; then
    eval "export $1=$(($2 + OFFSET))"
  fi
}
default_port NERONET_CONSOLE_PORT 8443
default_port NERONET_API_PORT 8081
default_port NERONET_DERP_EU_PORT 8444
default_port NERONET_DERP_US_PORT 8445
default_port NERONET_STUN_EU_PORT 3478
default_port NERONET_STUN_US_PORT 3479
default_port NERONET_POSTGRES_PORT 5432
default_port NERONET_VALKEY_PORT 6379
default_port NERONET_HTTP_PORT 8080

# The node image is tagged per stack. A shared tag would let two checkouts overwrite
# each other's image.
_project=${COMPOSE_PROJECT_NAME:-$(basename "$REPO_ROOT")}
_project=$(printf '%s' "$_project" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_-' | sed 's/^[-_]*//')
export NERONET_NODE_IMAGE="${_project}-node:dev"
export NERONET_BACKUP_IMAGE="${NERONET_BACKUP_IMAGE:-${_project}-backup:dev}"

# Compose reads .env and docker-compose.yml from the working directory; relative
# paths also sidestep the Windows path notation mismatch with the compose provider.
cd "$REPO_ROOT"

PROFILES="--profile nodes --profile debug-ports --profile backup --profile restore"

# Read only these non-secret settings from .env, without executing it. Environment
# values take precedence, as they do for Compose. Shell expansion inside .env is
# deliberately not supported here; use a literal value or export the setting.
dotenv_setting() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed 's/^"\(.*\)"$/\1/;s/^'"'"'\(.*\)'"'"'$/\1/'
}
export NERONET_TLS_MODE="${NERONET_TLS_MODE:-$(dotenv_setting NERONET_TLS_MODE)}"
case "${NERONET_TLS_MODE:-internal}" in
  internal) ;;
  acme)
    export NERONET_PUBLIC_DOMAIN="${NERONET_PUBLIC_DOMAIN:-$(dotenv_setting NERONET_PUBLIC_DOMAIN)}"
    [ -n "$NERONET_PUBLIC_DOMAIN" ] || die "ACME needs NERONET_PUBLIC_DOMAIN"
    export NERONET_CONSOLE_PUBLIC_PORT="${NERONET_CONSOLE_PUBLIC_PORT:-$NERONET_CONSOLE_PORT}"
    if [ "$NERONET_CONSOLE_PUBLIC_PORT" = 443 ]; then
      export NERONET_CONSOLE_ORIGIN="https://$NERONET_PUBLIC_DOMAIN"
    else
      export NERONET_CONSOLE_ORIGIN="https://$NERONET_PUBLIC_DOMAIN:$NERONET_CONSOLE_PUBLIC_PORT"
    fi
    export NERONET_CONTROL_PLANE_URL="https://$NERONET_PUBLIC_DOMAIN:8443"
    _ca=${NERONET_CONTROL_PLANE_CA_FILE:-$(dotenv_setting NERONET_CONTROL_PLANE_CA_FILE)}
    if [ -n "$_ca" ]; then
      export NERONET_CONTROL_PLANE_CA_FILE="$_ca"
      export NERONET_NODE_CA=/run/secrets/control_plane_ca
    else
      # Public ACME certificates use the node image's normal system roots.
      export NERONET_NODE_CA=""
    fi
    COMPOSE="$COMPOSE -f docker-compose.yml -f docker-compose.acme.yml"
    ;;
  *) die "NERONET_TLS_MODE must be internal or acme" ;;
esac

# The ACME test adds a private Pebble CA without changing the deployment files.
if [ -n "${NERONET_EXTRA_COMPOSE_FILE:-}" ]; then
  [ -f "$NERONET_EXTRA_COMPOSE_FILE" ] || die "no $NERONET_EXTRA_COMPOSE_FILE"
  COMPOSE="$COMPOSE -f $NERONET_EXTRA_COMPOSE_FILE"
fi

# The fleet override is generated, not committed. When it exists it joins every command,
# so `down` and `status` see the fleet's containers too.
FLEET_FILE=${NERONET_FLEET_FILE:-scripts/sim/out/docker-compose.fleet.yml}
if [ -f "$FLEET_FILE" ]; then
  COMPOSE="$COMPOSE -f docker-compose.yml -f $FLEET_FILE"
  PROFILES="$PROFILES --profile fleet"
fi
UP_PROFILES=""
[ "${NERONET_DEBUG_PORTS:-}" = "1" ] && UP_PROFILES="--profile debug-ports"

need_env() {
  if [ ! -f .env ] && [ -z "${POSTGRES_PASSWORD:-}" ]; then
    die "no .env in $REPO_ROOT; run scripts/dev/gen-env.sh first"
  fi
  # The console is TLS-only and the nodes pin its CA. A fresh checkout has neither,
  # so the development pair is written on first use (see gen-certs.sh).
  if [ ! -f certs/ca.crt ] || [ ! -f certs/server.crt ] || [ ! -f certs/server.key ]; then
    sh "$REPO_ROOT/scripts/dev/gen-certs.sh" "$REPO_ROOT/certs"
  fi
}

case "$cmd" in
  up)
    need_env
    # shellcheck disable=SC2086
    $COMPOSE $UP_PROFILES up -d --build --wait "$@"
    ;;
  nodes)
    need_env
    # All eight node-image services share one image. Build it through one service,
    # then start everything without rebuilding, so it is built once and not eight times.
    # shellcheck disable=SC2086
    $COMPOSE --profile nodes build derp-eu
    # shellcheck disable=SC2086
    $COMPOSE --profile nodes $UP_PROFILES up -d "$@"
    ;;
  fleet)
    need_env
    [ -f "$FLEET_FILE" ] || die "no $FLEET_FILE; run: node scripts/sim/fleet.mjs --nodes 24 --seed 1"
    # Every service in the override uses the node image. Build it once through the first one.
    first=$(sed -n 's/^  \(fleet-[a-z0-9-]*\):$/\1/p' "$FLEET_FILE" | head -n 1)
    [ -n "$first" ] || die "$FLEET_FILE declares no fleet service"
    # shellcheck disable=SC2086
    $COMPOSE --profile fleet build "$first"
    # shellcheck disable=SC2086
    $COMPOSE --profile fleet $UP_PROFILES up -d "$@"
    ;;
  backup)
    need_env
    # shellcheck disable=SC2086
    $COMPOSE --profile backup up -d --build --wait backup "$@"
    ;;
  down)
    # shellcheck disable=SC2086
    $COMPOSE $PROFILES down --remove-orphans "$@"
    ;;
  status)
    # shellcheck disable=SC2086
    $COMPOSE $PROFILES ps
    echo
    # Fixed query text; nothing from the environment is interpolated into the SQL.
    counts=$($COMPOSE exec -T postgres psql -U neronet -d neronet_db -tA -F ' ' -c \
      "SELECT count(*) FILTER (WHERE last_heartbeat > now() - interval '60 seconds'), count(*) FROM nodes" \
      2>/dev/null) || counts=""
    if [ -z "$counts" ]; then
      echo "nodes: database not reachable (is the stack up?)"
      exit 1
    fi
    set -- $counts
    echo "nodes with a heartbeat under 60 s: $1 of $2 registered"
    ;;
  logs)
    # shellcheck disable=SC2086
    $COMPOSE $PROFILES logs --tail 200 "$@"
    ;;
  *)
    sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
