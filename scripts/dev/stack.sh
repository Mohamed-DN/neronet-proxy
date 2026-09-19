#!/bin/sh
# Usage: stack.sh up | nodes | down [compose args] | status | logs [compose args] [service]
#
#   up      build and start postgres, valkey, backend and console, wait until healthy
#   nodes   start the two DERP relays and six Go nodes (starts the core first if needed)
#   down    stop and remove the stack's containers and network; add -v to drop its volumes
#   status  service health, and how many nodes sent a heartbeat in the last 60 s
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

# The node image is tagged per stack. A shared tag would let two checkouts overwrite
# each other's image.
_project=${COMPOSE_PROJECT_NAME:-$(basename "$REPO_ROOT")}
_project=$(printf '%s' "$_project" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_-' | sed 's/^[-_]*//')
export NERONET_NODE_IMAGE="${_project}-node:dev"

# Compose reads .env and docker-compose.yml from the working directory; relative
# paths also sidestep the Windows path notation mismatch with the compose provider.
cd "$REPO_ROOT"

PROFILES="--profile nodes --profile debug-ports"
UP_PROFILES=""
[ "${NERONET_DEBUG_PORTS:-}" = "1" ] && UP_PROFILES="--profile debug-ports"

need_env() {
  if [ ! -f .env ] && [ -z "${POSTGRES_PASSWORD:-}" ]; then
    die "no .env in $REPO_ROOT; run scripts/dev/gen-env.sh first"
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
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
