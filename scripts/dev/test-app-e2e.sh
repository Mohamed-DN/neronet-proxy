#!/bin/sh
# Usage: test-app-e2e.sh [--keep]
#
# The NeroNet app against a real stack (ADR 0040, phase 0): the real binaries in containers, the real
# console, control plane, database and two real mesh nodes. In order:
#
#   sign in by code          the app shows a code; a person with an authenticator approves it on the console
#   join                     the app enrols as one node of that person
#   reach a peer             the app's tunnel carries a real TCP exchange to a peer's overlay address
#   suspend                  "revoke all sessions": the app's node is cut off from its peer
#   re-approve               the same installation signs in again and the peer is reachable again
#   revoke                   the person removes the app: cut for good; the installation is refused after
#   another local user       a different user of the same machine cannot use the app's socket
#
# One stack, one at a time: it refuses to start while another test container is running, and uses its own
# compose project (COMPOSE_PROJECT_NAME, default neronet-appe2e) which it removes at the end unless --keep.
# Every step prints PASS or FAIL; the exit status is 0 only if every step passed.
set -eu
. "$(dirname "$0")/engine.sh"
cd "$REPO_ROOT"

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) die "unknown argument $arg" ;;
  esac
done

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-neronet-appe2e}"
case "$COMPOSE_PROJECT_NAME" in
  neronet | *[!a-z0-9_-]*) die "set a safe COMPOSE_PROJECT_NAME for disposable tests; neronet is protected" ;;
esac
export NERONET_PORT_OFFSET=${NERONET_PORT_OFFSET:-5000}
export NERONET_DATAPLANE=netstack
export SOVEREIGN_MFA_MANDATORY=off
export NERONET_MAX_NETMAP_STALENESS_SECONDS=${NERONET_MAX_NETMAP_STALENESS_SECONDS:-60}

PROJECT=$COMPOSE_PROJECT_NAME
NET="${PROJECT}_neronet-isolated-mesh"
APP="${PROJECT}-app"
IMAGE="${PROJECT}-app:dev"
STACK="sh scripts/dev/stack.sh"
SOCKET=/run/neronet/10001/core.sock
ECHO_PORT=${NERONET_OVERLAY_ECHO_PORT:-9999}

# Only one stack at a time on this machine: wait while another test container runs (ours do not count).
quiet() {
  $ENGINE ps --format '{{.Names}} {{.Image}}' | grep -v "^${PROJECT}[-_]" | grep -v darknero-web \
    | grep -c -E 'node:22|golang|postgres|valkey|xray' || true
}
waited=0
while [ "$(quiet)" -gt 0 ]; do
  [ "$waited" -lt 1800 ] || die "another test stack kept running for 30 minutes"
  [ "$waited" -ne 0 ] || echo "waiting: another test container is running"
  sleep 30
  waited=$((waited + 30))
done

[ -f .env ] || sh scripts/dev/gen-env.sh
for key in POSTGRES_PASSWORD SOVEREIGN_JWT_SECRET SOVEREIGN_ADMIN_PASS SOVEREIGN_REGISTRATION_TOKEN; do
  grep -q "^$key=." .env || die ".env has no value for $key"
done
ADMIN_PASS=$(sed -n 's/^SOVEREIGN_ADMIN_PASS=//p' .env | head -1)
export ADMIN_PASS

WORK=$(mktemp -d)
FAILED=0
cleanup() {
  rc=$?
  if [ "$KEEP" -eq 0 ]; then
    echo "== removing $PROJECT"
    $ENGINE rm -f "$APP" > /dev/null 2>&1 || true
    $STACK down -v > /dev/null 2>&1 || true
    $ENGINE rmi -f "$IMAGE" > /dev/null 2>&1 || true
  else
    echo "== left running: project $PROJECT, app container $APP"
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT INT TERM

pass() { echo "PASS: $*"; }
fail() {
  echo "FAIL: $*"
  FAILED=$((FAILED + 1))
}

# What the console's side does, inside the stack network (scripts/dev/scenarios/app-e2e.mjs).
driver() {
  $ENGINE run --rm --network "$NET" \
    -v "$(HOST_PATH "$WORK")":/work \
    -v "$(HOST_PATH scripts/dev/scenarios)":/scenarios:ro \
    -v "$(HOST_PATH certs)":/certs:ro \
    -e NODE_EXTRA_CA_CERTS=/certs/ca.crt -e CONSOLE=https://frontend:8443 -e ADMIN_PASS -e WORK=/work \
    docker.io/library/node:22 node /scenarios/app-e2e.mjs "$@"
}

# The app's own command line, as the user the service runs as.
ctl() { $ENGINE exec "$APP" /bin/neronet-appctl -socket "$SOCKET" -service-uid 10001 "$@"; }

field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

phase() { ctl state 2> /dev/null | field phase; }

wait_phase() {
  want=$1
  limit=${2:-90}
  i=0
  while [ "$i" -lt "$limit" ]; do
    [ "$(phase)" = "$want" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Reachable: the app's tunnel dials the peer's overlay address through its own SOCKS5 and reads the echo back.
reach() { $ENGINE exec "$APP" /bin/neronet-appctl echo 127.0.0.1:1080 "$1:$ECHO_PORT" "hello-$2" > "$WORK/echo.out" 2>&1; }

until_unreachable() {
  i=0
  while [ "$i" -lt "${2:-90}" ]; do
    reach "$1" gone || return 0
    sleep 3
    i=$((i + 3))
  done
  return 1
}

echo "== stack $PROJECT (API port $((8081 + NERONET_PORT_OFFSET)))"
$STACK up
$STACK nodes relay-de client-it client-es
sh scripts/dev/smoke.sh 3 240

echo "== the app image and service"
$ENGINE build -q -f docker/Dockerfile.app -t "$IMAGE" . > /dev/null
$ENGINE run -d --name "$APP" --network "$NET" \
  -v "$(HOST_PATH certs)":/certs:ro \
  "$IMAGE" -control-url https://frontend:8443 -control-ca /certs/ca.crt -name "E2E laptop" -owner-uid 10001 > /dev/null
i=0
until ctl state > /dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || {
    $ENGINE logs "$APP" 2>&1 | tail -5
    die "the app service did not come up"
  }
  sleep 1
done
[ "$(phase)" = signed_out ] && pass "the app starts signed out" || fail "the app did not start signed out: $(phase)"

echo "== a person with an authenticator"
driver prepare > "$WORK/prepare.json" || die "preparing the person failed"
pass "a person turned on an authenticator ($(field person < "$WORK/prepare.json"))"

signin() {
  ctl signin > "$WORK/signin.json" || return 1
  code=$(field user_code < "$WORK/signin.json")
  [ -n "$code" ] || return 1
  driver approve "$code" > "$WORK/approve.json" || return 1
  wait_phase disconnected 90
}

echo "== sign in by code, approved with the authenticator"
if signin; then
  NODE=$(ctl state | field node_id)
  ACCOUNT=$(ctl state | field account)
  pass "signed in and joined as $NODE for $ACCOUNT"
else
  fail "sign in by code did not end with the app joined"
  die "cannot go on without a signed-in app"
fi

echo "== connect, and reach a peer by its overlay address"
if ctl connect > /dev/null 2>&1 && wait_phase connected 60; then
  pass "the tunnel is up (method $(ctl state | field method))"
else
  fail "connect failed: $(ctl state)"
  die "cannot go on without a tunnel"
fi
driver peers "$NODE" > "$WORK/peers.txt"
PEER=$(head -1 "$WORK/peers.txt" | cut -d' ' -f2)
[ -n "$PEER" ] || die "no peer to reach"
i=0
while [ "$i" -lt 60 ] && ! reach "$PEER" first; do
  sleep 3
  i=$((i + 3))
done
if reach "$PEER" one; then pass "real TCP to $PEER through the app's tunnel: $(cat "$WORK/echo.out")"; else fail "the peer $PEER is not reachable: $(cat "$WORK/echo.out")"; fi

echo "== by name"
NAME=$(head -1 "$WORK/peers.txt" | cut -d' ' -f3)
if [ -n "$NAME" ] && reach "$NAME.mesh" name; then
  pass "reached $NAME.mesh by name"
else
  echo "NOT DONE: mesh names are answered by a gateway for stock WireGuard devices; an app node has no resolver for them yet"
fi

echo "== suspend: an administrator revokes all of the person's sessions"
driver suspend > /dev/null
if until_unreachable "$PEER" 120; then pass "the peer no longer answers the suspended app"; else fail "the suspended app still reaches the peer"; fi
driver status > "$WORK/status.json"
grep -q '"status":"suspended"' "$WORK/status.json" && pass "the console lists the app as suspended" || fail "the app is not listed as suspended: $(cat "$WORK/status.json")"
ctl disconnect > /dev/null 2>&1 || true
if ctl connect > "$WORK/conn.out" 2>&1; then fail "a suspended app could connect"; else pass "connecting is refused for a suspended app"; fi
[ "$(phase)" = signed_out ] && pass "the app tells the person to sign in again: $(ctl state | field message)" || fail "phase after suspension: $(phase)"

echo "== re-approve: the same installation signs in again"
if signin; then
  NODE2=$(ctl state | field node_id)
  [ "$NODE2" = "$NODE" ] && pass "back as the same node $NODE2" || fail "a different node came back: $NODE2 (was $NODE)"
else
  fail "signing in again after the suspension did not work"
fi
if ctl connect > /dev/null 2>&1 && wait_phase connected 60; then pass "the tunnel is up again"; else fail "connect after re-approval failed"; fi
i=0
while [ "$i" -lt 90 ] && ! reach "$PEER" back; do
  sleep 3
  i=$((i + 3))
done
if reach "$PEER" two; then pass "the peer is reachable again: $(cat "$WORK/echo.out")"; else fail "the peer is still not reachable after re-approval: $(cat "$WORK/echo.out")"; fi

echo "== revoke: the person removes the app for good"
driver revoke > /dev/null
if until_unreachable "$PEER" 120; then pass "the revoked app is cut off"; else fail "the revoked app still reaches the peer"; fi
[ "$(driver node "$NODE")" = gone ] && pass "the console removed the app's node" || fail "the node of a revoked app is still on the console"
ctl disconnect > /dev/null 2>&1 || true
if ctl connect > "$WORK/conn.out" 2>&1; then fail "a revoked app could connect"; else pass "connecting is refused for a revoked app"; fi
[ "$(phase)" = signed_out ] && pass "the app says it was removed: $(ctl state | field message)" || fail "phase after revoke: $(phase)"

echo "== another local user of the machine"
if $ENGINE exec --user 10002 "$APP" /bin/neronet-appctl -socket "$SOCKET" -service-uid 10001 state > "$WORK/intruder.out" 2>&1; then
  fail "another local user used the app's socket: $(cat "$WORK/intruder.out")"
else
  pass "another local user cannot use the app's socket: $(head -c 120 "$WORK/intruder.out")"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  $ENGINE logs "$APP" 2>&1 | tail -30 > "app-e2e-${PROJECT}.log" || true
  echo "FAILED: $FAILED step(s); the app's log is in app-e2e-${PROJECT}.log"
  exit 1
fi
echo "PASS: every step"
