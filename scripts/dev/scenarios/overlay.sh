#!/bin/sh
# Usage: overlay.sh [matrix|telemetry|metrics|rule-deny|discovery|subnet|quarantine|revoke|fail-static|derp]
#
# Measures the overlay between the fleet nodes of a running stack. Every cell of the
# matrix is a real TCP exchange: node A dials node B's overlay address through node
# A's own SOCKS5 inbound and reads the echo back. Nothing here reads a database row
# and calls it reachability.
#
#   matrix        N x N of ok / denied / timeout with the measured round trips
#   telemetry     real TCP matrix and increasing native WireGuard device counters
#   metrics       telemetry plus overview, node DTOs and scheduled native history
#   rule-deny     deny one pair through the API, re-measure, delete the rule, re-measure
#   discovery     rule-deny plus authenticated discovery checked against real TCP
#   subnet        put two nodes in a sub-network, re-measure; connect it to the default
#                 sub-network, re-measure; delete it, re-measure
#   quarantine    quarantine one node through the API, re-measure, lift it, re-measure
#   revoke        revoke one node through the API and re-measure
#   fail-static   stop the backend, re-measure, restart it, re-measure
#   derp          register and start the two derp-v2 relays, drop UDP in one node's
#                 network namespace, and measure DERP allowed, withdrawn, restored,
#                 both relays stopped and restarted, and UDP restored; needs a backend
#                 started with NERONET_TRANSPORT_CEILING=udp,derp
#
# The stack must be running with the data plane on:
#
#   COMPOSE_PROJECT_NAME=wp202 NERONET_PORT_OFFSET=8000 NERONET_DATAPLANE=netstack \
#     sh scripts/dev/stack.sh up && ... stack.sh nodes
#
# Credentials come from the stack's own generated .env. Nothing is printed from it.
#
# Exit status: 0 when every cell matched what was expected, 1 otherwise.
set -eu

# engine.sh derives the repository root from the directory of the script that sourced
# it, and this one sits a level deeper than the rest. Say so rather than let it
# resolve to scripts/.
NERONET_REPO_ROOT=${NERONET_REPO_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}
export NERONET_REPO_ROOT
. "$(dirname "$0")/../engine.sh"

cd "$REPO_ROOT"

SCENARIO=${1:-matrix}
ECHO_PORT=${NERONET_OVERLAY_ECHO_PORT:-9999}
SOCKS=${NERONET_NODE_SOCKS:-127.0.0.1:1080}
DIAL_TIMEOUT=${NERONET_OVERLAY_DIAL_TIMEOUT:-5}
API=${NERONET_API_URL:-http://127.0.0.1:$((8081 + ${NERONET_PORT_OFFSET:-0}))}

# All thirteen compose node services, plus anything the caller started by hand. A node that
# is not a compose service is named "container:<name>", which is what the seventh-node
# scenario uses.
NODE_SERVICES=${NERONET_NODE_SERVICES:-"relay-de relay-fr relay-us relay-nl client-it client-es client-uk client-us client-de client-fr client-jp client-ch relay-se"}
NODE_SERVICES="$NODE_SERVICES ${NERONET_EXTRA_NODES:-}"

[ -f .env ] || die "no .env in $REPO_ROOT; run scripts/dev/gen-env.sh first"

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# --- API ---------------------------------------------------------------------

env_value() {
  # Reads one value out of .env without printing the file or exporting everything.
  sed -n "s/^$1=//p" .env | head -1
}

api_login() {
  pass=$(env_value SOVEREIGN_ADMIN_PASS)
  [ -n "$pass" ] || die "SOVEREIGN_ADMIN_PASS is not in .env"

  # Through a pipe rather than an argument or a temporary file: the password never
  # reaches the process arguments, where anything on the machine can read them, and
  # never lands on disk outside the .env it came from.
  printf '{"username":"%s","password":"%s"}' "${NERONET_ADMIN_USER:-admin}" "$pass" \
    | curl -sS -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
      --data-binary @- > "$WORK/login-response.json" || die "login request failed"

  TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$WORK/login-response.json")
  rm -f "$WORK/login-response.json"
  [ -n "$TOKEN" ] || die "the console API did not return a token; is the stack up on $API?"
}

# api <method> <path> [json body] -> prints the response body
#
# A console token lives 15 minutes (SOVEREIGN_JWT_EXPIRES_IN) and the longer scenarios
# run past that: a 401 signs in again once and repeats the call.
api() {
  method=$1
  path=$2
  body=${3:-}
  for attempt in 1 2; do
    if [ -n "$body" ]; then
      out=$(curl -sS -w '\n%{http_code}' -X "$method" "$API$path" -H "Authorization: Bearer $TOKEN" \
        -H 'Content-Type: application/json' -d "$body")
    else
      out=$(curl -sS -w '\n%{http_code}' -X "$method" "$API$path" -H "Authorization: Bearer $TOKEN")
    fi
    code=$(printf '%s\n' "$out" | tail -n 1)
    if [ "$code" = 401 ] && [ "$attempt" = 1 ]; then
      api_login
      continue
    fi
    printf '%s' "$(printf '%s\n' "$out" | sed '$d')"
    return 0
  done
}

# --- Reaching a node ---------------------------------------------------------
#
# A node is either a compose service or, when the caller started it by hand, a plain
# container named "container:<name>". The seventh-node scenario needs the second form:
# the card asks for that node to be started by hand, and a hand-started container has
# no compose service to exec into.

node_logs() {
  case "$1" in
    # 2>&1 because the node logs to stderr and the caller discards it.
    container:*) $ENGINE logs "${1#container:}" 2>&1 ;;
    *) $COMPOSE --profile nodes logs --no-color "$1" ;;
  esac
}

node_logs_since() {
  case "$1" in
    container:*) $ENGINE logs --since "$2" "${1#container:}" 2>&1 ;;
    *) $COMPOSE --profile nodes logs --no-color --since "$2" "$1" ;;
  esac
}

node_exec() {
  target=$1
  shift
  case "$target" in
    container:*) $ENGINE exec "${target#container:}" "$@" ;;
    *) $COMPOSE --profile nodes exec -T "$target" "$@" ;;
  esac
}

# --- Fleet inventory ---------------------------------------------------------

# The API is the control plane's own view: node ids and overlay addresses. The
# service each node runs in is read from the node's own log line, because nothing
# in the database knows what a compose service is called.
build_inventory() {
  api GET '/api/nodes?limit=100' > "$WORK/nodes.json"

  # One "id overlay_ipv4" line per node.
  tr '}' '\n' < "$WORK/nodes.json" \
    | sed -n 's/.*"id":"\([^"]*\)".*"overlay_ipv4":"\([^"]*\)".*/\1 \2/p' \
    | sort -u > "$WORK/api-nodes"

  : > "$WORK/fleet"
  for svc in $NODE_SERVICES; do
    [ -n "$svc" ] || continue
    vip=$(node_logs "$svc" 2>/dev/null \
      | sed -n 's/.*Assigned Overlay VIP: \([0-9.]*\) .*/\1/p' | tail -1)
    if [ -z "$vip" ]; then
      echo "warning: $svc has not reported an overlay address; it is left out of the matrix" >&2
      continue
    fi
    id=$(awk -v v="$vip" '$2 == v { print $1 }' "$WORK/api-nodes" | head -1)
    printf '%s %s %s\n' "$svc" "$vip" "${id:-unknown}" >> "$WORK/fleet"
  done

  [ -s "$WORK/fleet" ] || die "no node reported an overlay address; is NERONET_DATAPLANE=netstack set?"
}

# --- The matrix --------------------------------------------------------------

# dial <service> <target vip> -> prints "ok <ms>", "denied" or "timeout"
#
# stdin comes from /dev/null: `compose exec` drains whatever it is handed, and this
# runs inside two nested loops that read the fleet file on stdin. Without it the first
# dial swallows the rest of the fleet and the matrix comes out with a single column.
dial() {
  if [ "$SCENARIO" = telemetry ] || [ "$SCENARIO" = metrics ]; then
    out=$(node_exec "$1" env NERONET_OVERLAY_PAYLOAD_BYTES=262144 /bin/sovereign-cli overlay-dial \
      "$SOCKS" "$2:$ECHO_PORT" "$DIAL_TIMEOUT" 2>/dev/null < /dev/null) && rc=0 || rc=$?
  else
    out=$(node_exec "$1" /bin/sovereign-cli overlay-dial \
      "$SOCKS" "$2:$ECHO_PORT" "$DIAL_TIMEOUT" 2>/dev/null < /dev/null) && rc=0 || rc=$?
  fi
  case "$rc" in
    0) printf 'ok %s\n' "$(printf '%s' "$out" | awk '{print $3}')" ;;
    3) printf 'timeout\n' ;;
    2) printf 'denied\n' ;;
    *) printf 'error\n' ;;
  esac
}

# measure_matrix <label> -> writes $WORK/matrix and prints it
measure_matrix() {
  label=$1
  : > "$WORK/matrix"

  while read -r src_svc src_vip src_id; do
    while read -r dst_svc dst_vip dst_id; do
      [ "$src_svc" = "$dst_svc" ] && continue
      result=$(dial "$src_svc" "$dst_vip")
      printf '%s %s %s\n' "$src_svc" "$dst_svc" "$result" >> "$WORK/matrix"
    done < "$WORK/fleet"
  done < "$WORK/fleet"

  echo
  echo "== $label"
  print_matrix
}

print_matrix() {
  # Header: one column per destination.
  printf '%-12s' 'from/to'
  while read -r svc vip id; do
    printf '%-14s' "$svc"
  done < "$WORK/fleet"
  echo

  while read -r src_svc src_vip src_id; do
    printf '%-12s' "$src_svc"
    while read -r dst_svc dst_vip dst_id; do
      if [ "$src_svc" = "$dst_svc" ]; then
        printf '%-14s' '-'
      else
        cell=$(awk -v a="$src_svc" -v b="$dst_svc" '$1 == a && $2 == b { $1=""; $2=""; print substr($0,3) }' "$WORK/matrix")
        case "$cell" in
          ok\ *) printf '%-14s' "ok $(printf '%s' "$cell" | awk '{printf "%.2fms", $2}')" ;;
          *) printf '%-14s' "$cell" ;;
        esac
      fi
    done < "$WORK/fleet"
    echo
  done < "$WORK/fleet"
  echo
}

cell_of() {
  awk -v a="$1" -v b="$2" '$1 == a && $2 == b { print $3 }' "$WORK/matrix"
}

# expect_all <expected> [except-pair-a except-pair-b expected-for-that-pair]
#
# Returns non-zero and names every cell that did not match.
expect_all() {
  expected=$1
  pair_a=${2:-}
  pair_b=${3:-}
  pair_expected=${4:-}

  bad=0
  while read -r src dst state rest; do
    want=$expected
    if [ -n "$pair_a" ]; then
      if { [ "$src" = "$pair_a" ] && [ "$dst" = "$pair_b" ]; } ||
        { [ "$src" = "$pair_b" ] && [ "$dst" = "$pair_a" ]; }; then
        want=$pair_expected
      fi
    fi
    if [ "$state" != "$want" ]; then
      echo "unexpected: $src -> $dst is $state, expected $want" >&2
      bad=1
    fi
  done < "$WORK/matrix"
  return $bad
}

node_id_of() { awk -v s="$1" '$1 == s { print $3 }' "$WORK/fleet"; }
vip_of() { awk -v s="$1" '$1 == s { print $2 }' "$WORK/fleet"; }

first_service() { head -1 "$WORK/fleet" | awk '{print $1}'; }
second_service() { sed -n '2p' "$WORK/fleet" | awk '{print $1}'; }

# One heartbeat plus one fetch, plus room for the handshake to settle.
CONVERGE=${NERONET_OVERLAY_CONVERGE_SECONDS:-25}
converge() {
  echo "waiting ${CONVERGE}s for one heartbeat and one netmap fetch..."
  sleep "$CONVERGE"
}

probe_discovery() {
  [ "$SCENARIO" = discovery ] || return 0
  # The probe mints a short-lived additional credential and deletes only that
  # credential in finally. It never revokes the running node's own credentials.
  $COMPOSE exec -T backend node - "$(node_id_of "$A")" "$(node_id_of "$B")" "$1" \
    < "$REPO_ROOT/scripts/dev/scenarios/discovery-probe.cjs"
}

# Quarantine revokes the credential. Recovery needs a refused heartbeat, a new
# registration and then another heartbeat to fetch the netmap; a fixed sleep can
# measure halfway through that sequence. Wait for the actual TCP exchange in both
# directions, and for a fresh successful registration before measuring recovery.
QUARANTINE_TIMEOUT=${NERONET_OVERLAY_QUARANTINE_TIMEOUT_SECONDS:-180}
reenrol_count() {
  node_logs "$1" 2>/dev/null < /dev/null | grep -c 'Re-enrolled after the control plane lost this node:' || true
}

wait_quarantine_pair() {
  q_want=$1
  q_source=$2
  q_target=$3
  q_previous_reenrols=$4
  q_started=$(date +%s)
  echo "waiting up to ${QUARANTINE_TIMEOUT}s for $q_source <-> $q_target to be $q_want"

  while :; do
    if [ "$q_want" = ok ] && [ "$(reenrol_count "$q_target")" -le "$q_previous_reenrols" ]; then
      q_forward=registration-pending
      q_reverse=registration-pending
    else
      q_forward=$(dial "$q_source" "$(vip_of "$q_target")")
      q_forward=${q_forward%% *}
      q_reverse=$(dial "$q_target" "$(vip_of "$q_source")")
      q_reverse=${q_reverse%% *}
    fi

    q_elapsed=$(($(date +%s) - q_started))
    if [ "$q_forward" = "$q_want" ] && [ "$q_reverse" = "$q_want" ]; then
      echo "observed $q_source <-> $q_target $q_want after ${q_elapsed}s"
      return 0
    fi
    if [ "$q_elapsed" -ge "$QUARANTINE_TIMEOUT" ]; then
      echo "quarantine convergence timed out: $q_source -> $q_target $q_forward, reverse $q_reverse" >&2
      return 1
    fi
    sleep 2
  done
}

# --- Scenarios ---------------------------------------------------------------

api_login
build_inventory

if [ "$SCENARIO" = discovery ]; then
  [ -n "${COMPOSE_PROJECT_NAME:-}" ] && [ "$COMPOSE_PROJECT_NAME" != neronet ] \
    && [ "${NERONET_PORT_OFFSET:-0}" -ne 0 ] || die "discovery requires a dedicated stack and nonzero port offset"
  backend_id=$($COMPOSE ps -q backend)
  [ -n "$backend_id" ] || die "backend is not running"
  backend_project=$($ENGINE inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$backend_id")
  [ "$backend_project" = "$COMPOSE_PROJECT_NAME" ] || die "backend project label does not match"
fi

echo "== fleet"
printf '%-12s %-16s %s\n' SERVICE OVERLAY 'NODE ID'
while read -r svc vip id; do printf '%-12s %-16s %s\n' "$svc" "$vip" "$id"; done < "$WORK/fleet"

rc=0

metrics_probe() {
  api GET /api/stats/timeseries > "$WORK/metrics-history.json"
  api GET /api/stats/overview > "$WORK/metrics-overview.json"
  api GET '/api/nodes?limit=100' > "$WORK/metrics-nodes.json"
  api GET /api/stats/native-telemetry > "$WORK/metrics-after.json"
  { cat "$WORK/metrics-baseline.json"; printf '\n';
    cat "$WORK/metrics-history.json"; printf '\n';
    cat "$WORK/telemetry-before.json"; printf '\n';
    cat "$WORK/metrics-overview.json"; printf '\n';
    cat "$WORK/metrics-nodes.json"; printf '\n';
    cat "$WORK/metrics-after.json"; printf '\n'; cat "$WORK/fleet";
  } | $ENGINE exec -i "$backend_id" node -e "$(cat "$REPO_ROOT/scripts/dev/probes/check-native-metrics.cjs")" "$1" 262144
}

wait_metrics() {
  mode=$1
  started=$(date +%s)
  while ! metrics_probe "$mode" > "$WORK/metrics-probe.log" 2>&1; do
    if [ "$(($(date +%s)-started))" -ge 180 ]; then
      cat "$WORK/metrics-probe.log" >&2
      return 1
    fi
    sleep 5
  done
  cat "$WORK/metrics-probe.log"
}

case "$SCENARIO" in
  telemetry|metrics)
    # Wait for a native observation after the whole fleet has stabilized. The two
    # snapshots must be different heartbeat sequences from one counter epoch.
    converge
    api GET /api/stats/native-telemetry > "$WORK/telemetry-before.json"
    backend_id=$($COMPOSE ps -q backend)
    [ -n "$backend_id" ] || die "backend is not running"
    if [ "$SCENARIO" = metrics ]; then
      printf '[]\n' > "$WORK/metrics-baseline.json"
      echo "waiting for scheduled native history baseline..."
      wait_metrics baseline || die "native history baseline unavailable"
      cp "$WORK/metrics-history.json" "$WORK/metrics-baseline.json"
      api GET /api/stats/native-telemetry > "$WORK/telemetry-before.json"
    fi
    measure_matrix "real TCP for the native telemetry measurement"
    expect_all ok || rc=1
    converge
    api GET /api/stats/native-telemetry > "$WORK/telemetry-after.json"
    backend_id=$($COMPOSE ps -q backend)
    [ -n "$backend_id" ] || die "backend is not running"
    { cat "$WORK/telemetry-before.json"; printf '\n';
      cat "$WORK/telemetry-after.json"; printf '\n'; cat "$WORK/fleet";
    } | $ENGINE exec -i "$backend_id" node -e "$(cat "$REPO_ROOT/scripts/dev/probes/check-native-telemetry.cjs")" 262144 || rc=1
    if [ "$SCENARIO" = metrics ]; then
      echo "waiting for scheduled history covering the real TCP payload..."
      wait_metrics final || rc=1
    fi
    ;;
  matrix)
    measure_matrix "overlay matrix, no rules (the compiled policy is allow-all)"
    expect_all ok || rc=1
    ;;

  rule-deny|discovery)
    A=$(first_service)
    B=$(second_service)
    A_VIP=$(vip_of "$A")
    B_VIP=$(vip_of "$B")

    measure_matrix "before the deny rule"
    expect_all ok || rc=1
    probe_discovery allowed || rc=1

    # The two DROPs alone, as the console's "cut connection" writes them. An open
    # organisation whose rules only drop stays open around them; until that was fixed
    # this exact rule set took every pair of the mesh down, and this scenario hid it by
    # also writing an allow-all.
    echo "creating the deny rules, one each way"
    DENY_AB=$(api POST /api/acl/rules "{\"priority\":10,\"source_cidr\":\"$A_VIP\",\"destination_cidr\":\"$B_VIP\",\"action\":\"DROP\",\"description\":\"WP-202 scenario\"}" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    DENY_BA=$(api POST /api/acl/rules "{\"priority\":11,\"source_cidr\":\"$B_VIP\",\"destination_cidr\":\"$A_VIP\",\"action\":\"DROP\",\"description\":\"WP-202 scenario\"}" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    converge

    measure_matrix "with $A and $B denied"
    expect_all ok "$A" "$B" timeout || rc=1
    probe_discovery blocked || rc=1

    # Read the peer set from the node itself rather than from the control plane: what
    # the node holds is what decides, and it is the only place the two can be seen to
    # agree.
    echo "the peer sets the denied pair hold:"
    for svc in "$A" "$B"; do
      echo "  $svc holds:"
      node_exec "$svc" sh -c 'cat /var/lib/neronet/netmap.json' 2>/dev/null \
        | tr ',' '\n' | sed -n 's/.*"node_id":"\(pk_[^"]*\)".*/    \1/p' | sort -u
    done

    echo "the drop counters the denied pair report:"
    for svc in "$A" "$B"; do
      # --since rather than --tail: wireguard-go's own logging is verbose enough that
      # a few thousand lines do not reach back to the start of the scenario.
      line=$(node_logs_since "$svc" 10m 2>/dev/null | grep 'Data plane drops since start' | tail -1 | sed 's/.*\(Data plane drops\)//')
      echo "  $svc: ${line:-no drop counted}"
    done

    echo "deleting the scenario rules"
    for id in "$DENY_AB" "$DENY_BA"; do
      [ -n "$id" ] && api DELETE "/api/acl/rules/$id" > /dev/null
    done
    converge

    measure_matrix "after deleting the rules"
    expect_all ok || rc=1
    probe_discovery allowed || rc=1
    ;;

  subnet)
    A=$(first_service)
    B=$(second_service)

    measure_matrix "before the sub-network"
    expect_all ok || rc=1

    # The organisation's default compartment, which every enrolled node starts in.
    api GET /api/compartments > "$WORK/compartments.json"
    DEFAULT_CMP=$(tr '}' '\n' < "$WORK/compartments.json" | grep '"slug":"default"' \
      | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
    [ -n "$DEFAULT_CMP" ] || die "no default compartment in the API's answer"

    echo "creating a sub-network with $A and $B"
    LAB=$(api POST /api/compartments '{"name":"overlay scenario"}' \
      | sed -n 's/.*"compartment":{"id":"\([^"]*\)".*/\1/p')
    [ -n "$LAB" ] || die "the sub-network was not created"
    api POST "/api/compartments/$LAB/members" \
      "{\"node_ids\":[\"$(node_id_of "$A")\",\"$(node_id_of "$B")\"]}" > /dev/null
    converge

    # Inside each side the mesh is whole; across the boundary nothing passes.
    measure_matrix "with $A and $B in their own sub-network"
    while read -r src dst state rest; do
      in_src=0
      in_dst=0
      { [ "$src" = "$A" ] || [ "$src" = "$B" ]; } && in_src=1
      { [ "$dst" = "$A" ] || [ "$dst" = "$B" ]; } && in_dst=1
      want=ok
      [ "$in_src" = "$in_dst" ] || want=timeout
      [ "$state" = "$want" ] || { echo "unexpected: $src -> $dst is $state, expected $want" >&2; rc=1; }
    done < "$WORK/matrix"

    echo "connecting the sub-network to the default one"
    api POST /api/compartments/peerings/create \
      "{\"src_compartment_id\":\"$LAB\",\"dst_compartment_id\":\"$DEFAULT_CMP\",\"policy\":\"allow\"}" > /dev/null
    converge

    measure_matrix "with the two sub-networks connected"
    expect_all ok || rc=1

    # Deleting it removes its peering with it and returns its nodes to the default.
    echo "deleting the sub-network"
    api DELETE "/api/compartments/$LAB" > /dev/null
    converge

    measure_matrix "after deleting the sub-network"
    expect_all ok || rc=1
    ;;

  quarantine)
    SOURCE=$(first_service)
    TARGET=$(second_service)
    TARGET_ID=$(node_id_of "$TARGET")

    measure_matrix "before the quarantine"
    expect_all ok || rc=1

    echo "quarantining $TARGET ($TARGET_ID)"
    api POST "/api/nodes/$TARGET_ID/action" '{"action":"quarantine","reason":"WP-202 scenario"}' > /dev/null
    wait_quarantine_pair timeout "$SOURCE" "$TARGET" 0 || rc=1

    measure_matrix "with $TARGET quarantined"
    while read -r src dst state rest; do
      if [ "$src" = "$TARGET" ] || [ "$dst" = "$TARGET" ]; then
        [ "$state" = "timeout" ] || { echo "unexpected: $src -> $dst is $state, expected timeout" >&2; rc=1; }
      else
        [ "$state" = "ok" ] || { echo "unexpected: $src -> $dst is $state, expected ok" >&2; rc=1; }
      fi
    done < "$WORK/matrix"

    # Take the baseline at the lift, so an earlier registration during the initial
    # matrix cannot be mistaken for this recovery.
    TARGET_REENROLS=$(reenrol_count "$TARGET")
    echo "lifting the quarantine"
    api POST "/api/nodes/$TARGET_ID/action" '{"action":"lift_quarantine"}' > /dev/null
    wait_quarantine_pair ok "$SOURCE" "$TARGET" "$TARGET_REENROLS" || rc=1

    measure_matrix "after lifting the quarantine"
    expect_all ok || rc=1
    ;;

  revoke)
    TARGET=$(second_service)
    TARGET_ID=$(node_id_of "$TARGET")

    measure_matrix "before the revocation"
    expect_all ok || rc=1

    echo "revoking $TARGET ($TARGET_ID)"
    api DELETE "/api/nodes/$TARGET_ID" > /dev/null
    converge

    echo "peer counts after the revocation:"
    while read -r svc vip id; do
      [ "$svc" = "$TARGET" ] && continue
      echo "  $svc: $(node_logs_since "$svc" 10m 2>/dev/null | grep -c 'revoked' || true) revocation lines"
    done < "$WORK/fleet"

    NODE_SERVICES=$(echo "$NODE_SERVICES" | sed "s/\b$TARGET\b//")
    build_inventory
    measure_matrix "after the revocation, without $TARGET"
    expect_all ok || rc=1
    ;;

  fail-static)
    measure_matrix "before the control plane stops"
    expect_all ok || rc=1

    echo "stopping the backend"
    $COMPOSE stop backend > /dev/null
    sleep 30

    measure_matrix "with the control plane stopped (fail-static)"
    expect_all ok || rc=1

    echo "waiting for the staleness bound to pass"
    sleep "${NERONET_OVERLAY_STALENESS_WAIT:-45}"

    measure_matrix "past the staleness bound (fail-closed)"
    expect_all timeout || rc=1

    echo "restarting the backend"
    $COMPOSE start backend > /dev/null
    # nginx resolves the backend once, at start, and a container that was stopped and
    # started again comes back on a different address. Without this the console is
    # reachable and every node gets an HTML 502 where it expects JSON, which looks
    # exactly like a node that refuses to recover.
    $COMPOSE restart frontend > /dev/null
    sleep 10
    # Recovery from a fail-closed is slower than an ordinary change: every peer on
    # every node has to handshake again at the same moment, and wireguard-go backs
    # off between attempts. On the six-node fleet it took about three minutes.
    converge
    converge
    converge
    converge
    converge

    measure_matrix "after the control plane returns"
    expect_all ok || rc=1
    ;;

  derp)
    # T0: DERP through the two derp-v2 relays under the control plane's policy, with
    # UDP really dropped in one node's network namespace (not a flag in the node).
    # Requires a stack whose backend runs with NERONET_TRANSPORT_CEILING=udp,derp.
    A=$(first_service)
    B=$(second_service)
    ORG=${NERONET_OVERLAY_ORG:-org-default}

    psql_q() { $COMPOSE exec -T postgres psql -U neronet -d neronet_db -tA -F ' ' -c "$1"; }
    org_policy() {
      api PUT "/api/organizations/$ORG/transports" "{\"allowed_transports\":$1}" > "$WORK/policy.json"
      grep -q '"effective_transports"' "$WORK/policy.json" || die "setting the transport policy failed: $(cat "$WORK/policy.json")"
      echo "transport policy of $ORG: $(sed -n 's/.*"effective_transports":\(\[[^]]*\]\).*/\1/p' "$WORK/policy.json") effective"
    }
    container_of() { $COMPOSE --profile nodes ps -q "$1" | head -1; }
    netfault() {
      # Runs iptables inside the node container's own network namespace. Only that
      # namespace is touched; the host and the other containers are not.
      $ENGINE run --rm --network "container:$(container_of "$1")" --cap-add NET_ADMIN \
        "$NETFAULT_IMAGE" "$2"
    }
    NETFAULT_IMAGE=${NERONET_NETFAULT_IMAGE:-localhost/neronet-netfault:dev}
    $ENGINE image inspect "$NETFAULT_IMAGE" > /dev/null 2>&1 ||
      $ENGINE build -t "$NETFAULT_IMAGE" -f docker/netfault/Containerfile docker/netfault ||
      die "building $NETFAULT_IMAGE failed"
    udp_block() {
      netfault "$1" 'iptables -I OUTPUT 1 -p udp ! --dport 53 -j DROP -m comment --comment neronet-t0 &&
                     iptables -I INPUT 1 -p udp ! --sport 53 -j DROP -m comment --comment neronet-t0'
    }
    udp_unblock() {
      netfault "$1" 'while iptables -D OUTPUT -p udp ! --dport 53 -j DROP -m comment --comment neronet-t0 2>/dev/null; do :; done;
                     while iptables -D INPUT -p udp ! --sport 53 -j DROP -m comment --comment neronet-t0 2>/dev/null; do :; done'
    }
    udp_counters() {
      netfault "$1" 'iptables -L -v -x -n | grep neronet-t0' | awk '{p+=$1} END {print p+0}'
    }
    admission_keys() {
      # The API port, like every other call here: the console's TLS port would need the
      # host curl to trust the development CA, and Windows' schannel also wants a
      # revocation answer that CA cannot give.
      curl -sS -X POST "$API/v4/control/relay/admission" \
        -H "Authorization: Bearer $(cat "certs/relays/$1/credential")" | tr ',' '\n' | grep -c '[0-9a-f]\{64\}' || true
    }
    homes_ready() {
      # Every fleet node reports both relays as homes.
      want=$(wc -l < "$WORK/fleet")
      got=$(psql_q "SELECT count(*) FROM nodes WHERE jsonb_array_length(relay_homes) = 2 AND relay_homes_reported_at > now() - interval '60 seconds'")
      [ "${got:-0}" -ge "$want" ]
    }
    expect_isolated() {
      bad=0
      while read -r src dst state rest; do
        want=ok
        { [ "$src" = "$1" ] || [ "$dst" = "$1" ]; } && want=$2
        if [ "$state" != "$want" ]; then
          echo "unexpected: $src -> $dst is $state, expected $want" >&2
          bad=1
        fi
      done < "$WORK/matrix"
      return $bad
    }
    reaches() { [ "$(dial "$1" "$2" | awk '{print $1}')" = ok ]; }
    unreachable() { ! reaches "$1" "$2"; }
    wait_for() {
      what=$1; shift
      i=0
      until "$@"; do
        i=$((i + 5)); [ "$i" -le "${NERONET_DERP_WAIT:-180}" ] || { echo "timed out waiting for $what" >&2; return 1; }
        sleep 5
      done
      echo "$what after ${i}s"
    }

    # Every fleet node must be one the control plane still lists. After `revoke` the
    # revoked node keeps its overlay address in its log but has no node id: measuring
    # DERP against it reports a revocation as a transport failure.
    if grep -q ' unknown$' "$WORK/fleet"; then
      die "the fleet holds a node the control plane no longer lists ($(awk '$3 == "unknown" { print $1 }' "$WORK/fleet" | tr '\n' ' ')); run derp on a fresh fleet, before revoke"
    fi

    echo "registering the relays with the control plane"
    sh scripts/dev/gen-relay-certs.sh "$REPO_ROOT/certs" derp-a derp-b
    for r in derp-a derp-b; do
      api POST /api/transports/relays "{\"relay_id\":\"$r\",\"url\":\"https://$r:8443/derp\"}" > "$WORK/relay.json"
      if ! grep -q '"credential"' "$WORK/relay.json"; then
        api POST "/api/transports/relays/$r/rotate-credential" > "$WORK/relay.json"
        api PATCH "/api/transports/relays/$r" '{"enabled":true}' > /dev/null
      fi
      # World-readable inside a directory only the developer can enter: see gen-relay-certs.sh.
      (umask 022; sed -n 's/.*"credential":"\(nrr1_[0-9a-f]*\)".*/\1/p' "$WORK/relay.json" > "certs/relays/$r/credential")
      [ -s "certs/relays/$r/credential" ] || die "no credential for $r"
      chmod 644 "certs/relays/$r/credential"
      rm -f "$WORK/relay.json"
    done
    # Through stack.sh: it names the per-stack node image and the stack's ports. A bare
    # `compose up` from here would reconcile the console and backend with the default
    # ports and run the relays from a shared image tag.
    sh "$REPO_ROOT/scripts/dev/stack.sh" relays derp-a derp-b

    org_policy '["udp","derp"]'
    wait_for "both relays homed on every node" homes_ready || rc=1
    echo "admission snapshot: $(admission_keys derp-a) keys"
    measure_matrix "UDP and DERP allowed"
    expect_all ok || rc=1

    echo "dropping UDP in $A's network namespace, both directions (DNS excepted)"
    udp_block "$A"
    rules=$(netfault "$A" 'iptables -S | grep -c neronet-t0 || true')
    [ "$rules" = 2 ] || die "the UDP block is not in place at $A ($rules of 2 rules); nothing below would be measured without UDP"
    wait_for "$A reaching $B without UDP" reaches "$A" "$(vip_of "$B")" || rc=1
    measure_matrix "UDP dropped at $A, DERP allowed"
    expect_all ok || rc=1
    dropped=$(udp_counters "$A")
    echo "UDP packets dropped at $A so far: $dropped"
    # A run on 9 November measured every cell "without UDP" with the rules reported
    # in place and not one packet dropped: the block was not in effect, and the
    # matrix said nothing about DERP. Such a run is void, not green or red.
    [ "$dropped" -gt 0 ] || die "no UDP packet was dropped at $A: the block is not in effect, so this run cannot judge DERP; rerun it"

    echo "withdrawing DERP from $ORG"
    org_policy '["udp"]'
    wait_for "$A cut off from $B" unreachable "$A" "$(vip_of "$B")" || rc=1
    echo "admission snapshot: $(admission_keys derp-a) keys"
    measure_matrix "UDP dropped at $A, DERP withdrawn"
    expect_isolated "$A" timeout || rc=1

    echo "allowing DERP again"
    org_policy '["udp","derp"]'
    wait_for "$A reaching $B again over DERP" reaches "$A" "$(vip_of "$B")" || rc=1
    measure_matrix "UDP dropped at $A, DERP allowed again"
    expect_all ok || rc=1

    echo "stopping both relays"
    $COMPOSE --profile relays stop derp-a derp-b
    wait_for "$A cut off without relays" unreachable "$A" "$(vip_of "$B")" || rc=1
    measure_matrix "UDP dropped at $A, no relay"
    expect_isolated "$A" timeout || rc=1
    $COMPOSE --profile relays start derp-a derp-b
    wait_for "both relays homed again" homes_ready || rc=1
    wait_for "$A reaching $B through the restarted relays" reaches "$A" "$(vip_of "$B")" || rc=1
    measure_matrix "UDP dropped at $A, relays back"
    expect_all ok || rc=1

    echo "restoring UDP at $A"
    before=$(udp_counters "$A")
    udp_unblock "$A"
    converge
    measure_matrix "UDP restored"
    expect_all ok || rc=1
    echo "UDP drops counted while blocked: $before; rules left: $(netfault "$A" 'iptables -S | grep -c neronet-t0 || true')"
    org_policy '["udp"]'
    ;;

  *)
    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac

if [ "$rc" -eq 0 ]; then
  echo "scenario '$SCENARIO': every cell matched what was expected"
else
  echo "scenario '$SCENARIO': at least one cell did not match; see the lines above" >&2
fi
exit "$rc"
