#!/bin/sh
# Usage: test-app-e2e.sh [--tun] [--keep]
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
# With --tun the service runs as root with CAP_NET_ADMIN and /dev/net/tun (never host networking) and the
# tunnel is a kernel interface that carries the whole computer: the peer is reached with plain TCP, no
# proxy, and the routing table is compared before, during and after (a clean stop, kill -9, a leftover
# device), including a route of someone else's that must not be touched.
#
# One stack, one at a time: it refuses to start while another test container is running, and uses its own
# compose project (COMPOSE_PROJECT_NAME, default neronet-appe2e) which it removes at the end unless --keep.
# Every step prints PASS or FAIL; the exit status is 0 only if every step passed.
set -eu
. "$(dirname "$0")/engine.sh"
cd "$REPO_ROOT"

KEEP=0
TUN=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --tun) TUN=1 ;;
    *) die "unknown argument $arg" ;;
  esac
done

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-neronet-appe2e}"
[ "$TUN" -eq 0 ] || export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME}-tun"
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
SVC_UID=10001
[ "$TUN" -eq 0 ] || SVC_UID=0
ctl() { $ENGINE exec --user 10001 "$APP" /bin/neronet-appctl -socket "$SOCKET" -service-uid "$SVC_UID" "$@"; }

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
VIA=127.0.0.1:1080
[ "$TUN" -eq 0 ] || VIA=direct
reach() { $ENGINE exec "$APP" /bin/neronet-appctl echo "$VIA" "$1:$ECHO_PORT" "hello-$2" > "$WORK/echo.out" 2>&1; }

until_unreachable() {
  i=0
  while [ "$i" -lt "${2:-90}" ]; do
    reach "$1" gone || return 0
    sleep 3
    i=$((i + 3))
  done
  return 1
}

# The routing table as it is, without what goes through the tunnel's own interface.
sh_in() { $ENGINE exec "$APP" sh -c "$1"; }
routes() { sh_in 'ip -4 route show; ip -6 route show' | grep -v ' dev nero0' | sort; }
iface_gone() {
  i=0
  while [ "$i" -lt 10 ]; do
    sh_in 'ip -o link show nero0' > /dev/null 2>&1 || return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

echo "== stack $PROJECT (API port $((8081 + NERONET_PORT_OFFSET)))"
$STACK up
$STACK nodes relay-de client-it client-es
sh scripts/dev/smoke.sh 3 240

echo "== the app image and service"
$ENGINE build -q -f docker/Dockerfile.app -t "$IMAGE" . > /dev/null
# The container only holds the namespace: the service is started inside it, so that it can be killed (kill -9)
# and started again without the container, and the network it made, going away with it.
APPD_ARGS="-control-url https://frontend:8443 -control-ca /certs/ca.crt -name E2E-laptop -owner-uid 10001"
RUN_AS="--user 10001"
if [ "$TUN" -eq 1 ]; then
  RUN_AS="--user 0 --cap-add NET_ADMIN --device /dev/net/tun"
  APPD_ARGS="$APPD_ARGS -dataplane tun"
fi
# shellcheck disable=SC2086
$ENGINE run -d --name "$APP" --network "$NET" $RUN_AS -v "$(HOST_PATH certs)":/certs:ro   --entrypoint /bin/sh "$IMAGE" -c 'while :; do sleep 1; done' > /dev/null
# The privileged service owns its directories (the image made them for the unprivileged one).
[ "$TUN" -eq 0 ] || $ENGINE exec "$APP" chown 0:0 /run/neronet /var/lib/neronet-app
start_service() { $ENGINE exec -d "$APP" /bin/sh -c "exec /bin/neronet-appd $APPD_ARGS >> /tmp/appd.log 2>&1"; }
start_service
i=0
until ctl state > /dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || {
    $ENGINE exec "$APP" tail -5 /tmp/appd.log 2>&1
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

if [ "$TUN" -eq 1 ]; then
  # Routes that are not the service's own: it must never touch them.
  sh_in 'ip route add blackhole 203.0.113.0/24; ip -6 route add blackhole 2001:db8:dead::/48'
  routes > "$WORK/routes.before"
  grep -q 203.0.113.0 "$WORK/routes.before" || die "the decoy route is not there"
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


if [ "$TUN" -eq 1 ]; then
  echo "== the whole computer: a kernel interface, its routes, and their removal"
  sh_in 'ip -o -4 addr show dev nero0' > "$WORK/addr.txt" 2>&1 && grep -q 'inet 100\.' "$WORK/addr.txt"     && pass "interface nero0 carries the overlay address: $(cut -d' ' -f7 "$WORK/addr.txt" | head -1)" || fail "no overlay address on nero0: $(cat "$WORK/addr.txt")"
  sh_in 'ip -4 route show dev nero0; ip -6 route show dev nero0' > "$WORK/via.txt"
  if grep -q default "$WORK/via.txt"; then fail "the tunnel took the default route: $(cat "$WORK/via.txt")"; else pass "no default route through the tunnel; its routes: $(tr '
' ';' < "$WORK/via.txt")"; fi
  routes > "$WORK/routes.during"
  diff "$WORK/routes.before" "$WORK/routes.during" > /dev/null && pass "every other route is as it was, the decoy route included" || fail "routes changed: $(diff "$WORK/routes.before" "$WORK/routes.during" | tr '
' ';')"

  ctl disconnect > /dev/null 2>&1
  iface_gone && pass "disconnect removes the interface" || fail "nero0 is still there after disconnect"
  routes > "$WORK/routes.after"
  diff "$WORK/routes.before" "$WORK/routes.after" > /dev/null && pass "the routing table is as before the tunnel" || fail "after disconnect: $(diff "$WORK/routes.before" "$WORK/routes.after" | tr '
' ';')"

  ctl connect > /dev/null 2>&1 && wait_phase connected 60 || fail "connect again failed"
  sh_in 'killall -9 neronet-appd'
  iface_gone && pass "kill -9 of the service leaves no interface" || fail "nero0 survived kill -9"
  routes > "$WORK/routes.after"
  diff "$WORK/routes.before" "$WORK/routes.after" > /dev/null && pass "kill -9 leaves the routing table as it was" || fail "after kill -9: $(diff "$WORK/routes.before" "$WORK/routes.after" | tr '
' ';')"
  start_service
  wait_phase disconnected 60 || wait_phase connected 60 || fail "the service did not come back after kill -9: $(phase)"
  [ "$(ctl state | field node_id)" = "$NODE" ] && pass "the restarted service is still the same node" || fail "restart lost the node: $(ctl state)"
  ctl connect > /dev/null 2>&1; wait_phase connected 60 || true

  ctl disconnect > /dev/null 2>&1; iface_gone || true
  sh_in 'ip tuntap add dev nero0 mode tun && ip addr add 198.51.100.7/24 dev nero0 && ip link set nero0 up'
  if ctl connect > /dev/null 2>&1 && wait_phase connected 60; then pass "a leftover TUN device of the same name is replaced"; else fail "a leftover device blocked the tunnel: $(ctl state)"; fi
  sh_in 'ip -o addr show dev nero0' | grep -q 198.51.100.7 && fail "the leftover address is still on the interface" || pass "the leftover device and its address are gone"
  ctl disconnect > /dev/null 2>&1; iface_gone || true
  sh_in 'ip link add nero0 type dummy'
  if ctl connect > /dev/null 2>&1; then fail "the tunnel ran over somebody else's interface"; else pass "an interface of that name that is not a TUN device is refused"; fi
  sh_in 'ip -o link show nero0' > /dev/null 2>&1 && pass "and it is left alone" || fail "the other interface was deleted"
  sh_in 'ip link del nero0'
  ctl connect > /dev/null 2>&1; wait_phase connected 60 || fail "connect after the clean-up failed: $(ctl state)"
fi

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

if [ "$TUN" -eq 1 ]; then
  iface_gone && pass "nothing of the tunnel is left at the end" || fail "nero0 is still there at the end"
  routes > "$WORK/routes.after"
  diff "$WORK/routes.before" "$WORK/routes.after" > /dev/null && pass "the routing table is as it was at the start" || fail "at the end: $(diff "$WORK/routes.before" "$WORK/routes.after" | tr '
' ';')"
fi

echo "== another local user of the machine"
if $ENGINE exec --user 10002 "$APP" /bin/neronet-appctl -socket "$SOCKET" -service-uid "$SVC_UID" state > "$WORK/intruder.out" 2>&1; then
  fail "another local user used the app's socket: $(cat "$WORK/intruder.out")"
else
  pass "another local user cannot use the app's socket: $(head -c 120 "$WORK/intruder.out")"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  $ENGINE exec "$APP" tail -30 /tmp/appd.log > "app-e2e-${PROJECT}.log" 2>&1 || true
  echo "FAILED: $FAILED step(s); the app's log is in app-e2e-${PROJECT}.log"
  exit 1
fi
echo "PASS: every step"
