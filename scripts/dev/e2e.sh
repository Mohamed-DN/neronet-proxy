#!/bin/sh
# Usage: e2e.sh [--keep] [scenario ...]
#
# Brings up a throw-away stack with the node fleet, runs the overlay scenarios against
# it and tears it down. Every scenario is a real exchange between containers over the
# encrypted overlay (see scenarios/overlay.sh); nothing reads a database row and calls
# it reachability.
#
#   scenarios   default: matrix rule-deny quarantine fail-static revoke
#               revoke removes a node, so it runs last
#   --keep      leave the stack running afterwards (stop it with: stack.sh down -v)
#
# The stack has its own name and ports, so it does not touch another stack on the same
# machine: COMPOSE_PROJECT_NAME=neronet-e2e and NERONET_PORT_OFFSET=3000 unless set.
# It uses the .env in the repository root; run gen-env.sh first if there is none.
#
# Two settings are forced for the run, whatever .env says:
#   SOVEREIGN_MFA_MANDATORY=off        the scenarios sign in with the admin password
#   NERONET_MAX_NETMAP_STALENESS_SECONDS=60
#                                      so fail-static can observe the fail-closed step
#
# Exit status: 0 when every scenario passed.
set -eu
. "$(dirname "$0")/engine.sh"
cd "$REPO_ROOT"

KEEP=0
SCENARIOS=""
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    -h | --help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) SCENARIOS="$SCENARIOS $arg" ;;
  esac
done
[ -n "$SCENARIOS" ] || SCENARIOS="matrix rule-deny quarantine fail-static revoke"

export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-neronet-e2e}
export NERONET_PORT_OFFSET=${NERONET_PORT_OFFSET:-3000}
export NERONET_DATAPLANE=${NERONET_DATAPLANE:-netstack}
export SOVEREIGN_MFA_MANDATORY=off
export NERONET_MAX_NETMAP_STALENESS_SECONDS=${NERONET_MAX_NETMAP_STALENESS_SECONDS:-60}
export NERONET_OVERLAY_STALENESS_WAIT=${NERONET_OVERLAY_STALENESS_WAIT:-45}
API_PORT=$((8081 + NERONET_PORT_OFFSET))
export NERONET_API_URL=${NERONET_API_URL:-http://127.0.0.1:$API_PORT}

[ -f .env ] || die "no .env in $REPO_ROOT; run: sh scripts/dev/gen-env.sh"
for key in POSTGRES_PASSWORD SOVEREIGN_JWT_SECRET SOVEREIGN_REFRESH_SECRET SOVEREIGN_AUDIT_HMAC_SECRET \
  SOVEREIGN_SHRED_KEK_SECRET SOVEREIGN_ADMIN_PASS SOVEREIGN_REGISTRATION_TOKEN; do
  grep -q "^$key=." .env || die ".env has no value for $key; add one (openssl rand -hex 32) or regenerate .env"
done

STACK="sh scripts/dev/stack.sh"
cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    echo "== tearing down $COMPOSE_PROJECT_NAME"
    $STACK down -v > /dev/null 2>&1 || true
  else
    echo "== left running: COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME, console https://127.0.0.1:$((8443 + NERONET_PORT_OFFSET))"
  fi
}
trap cleanup EXIT INT TERM

echo "== starting $COMPOSE_PROJECT_NAME (API on port $API_PORT)"
$STACK up
$STACK nodes
sh scripts/dev/smoke.sh 6 240

failed=""
for scenario in $SCENARIOS; do
  echo
  echo "######## scenario: $scenario"
  if ! sh scripts/dev/scenarios/overlay.sh "$scenario"; then
    failed="$failed $scenario"
  fi
done

echo
if [ -n "$failed" ]; then
  echo "FAILED:$failed"
  [ "$KEEP" -eq 1 ] || $STACK logs > "e2e-${COMPOSE_PROJECT_NAME}.log" 2>&1 || true
  [ "$KEEP" -eq 1 ] || echo "service logs written to e2e-${COMPOSE_PROJECT_NAME}.log"
  exit 1
fi
echo "PASS: every scenario ($SCENARIOS )"
