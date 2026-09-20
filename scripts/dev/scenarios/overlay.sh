#!/bin/sh
# Usage: overlay.sh [matrix|rule-deny|quarantine|revoke|fail-static]
#
# Measures the overlay between the fleet nodes of a running stack. Every cell of the
# matrix is a real TCP exchange: node A dials node B's overlay address through node
# A's own SOCKS5 inbound and reads the echo back. Nothing here reads a database row
# and calls it reachability.
#
#   matrix        N x N of ok / denied / timeout with the measured round trips
#   rule-deny     deny one pair through the API, re-measure, delete the rule, re-measure
#   quarantine    quarantine one node through the API, re-measure, lift it, re-measure
#   revoke        revoke one node through the API and re-measure
#   fail-static   stop the backend, re-measure, restart it, re-measure
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

# The six compose node services, plus anything the caller started by hand. A node that
# is not a compose service is named "container:<name>", which is what the seventh-node
# scenario uses.
NODE_SERVICES=${NERONET_NODE_SERVICES:-"relay-de relay-fr relay-us relay-nl client-it client-es"}
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

api() {
  method=$1
  path=$2
  body=${3:-}
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $TOKEN"
  fi
}

# --- Reaching a node ---------------------------------------------------------
#
# A node is either a compose service or, when the caller started it by hand, a plain
# container named "container:<name>". The seventh-node scenario needs the second form:
# the card asks for that node to be started by hand, and a hand-started container has
# no compose service to exec into.

node_logs() {
  case "$1" in
    container:*) $ENGINE logs "${1#container:}" ;;
    *) $COMPOSE --profile nodes logs --no-color "$1" ;;
  esac
}

node_logs_since() {
  case "$1" in
    container:*) $ENGINE logs --since "$2" "${1#container:}" ;;
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
  out=$(node_exec "$1" /bin/sovereign-cli overlay-dial \
    "$SOCKS" "$2:$ECHO_PORT" "$DIAL_TIMEOUT" 2>/dev/null < /dev/null) && rc=0 || rc=$?
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

# --- Scenarios ---------------------------------------------------------------

api_login
build_inventory

echo "== fleet"
printf '%-12s %-16s %s\n' SERVICE OVERLAY 'NODE ID'
while read -r svc vip id; do printf '%-12s %-16s %s\n' "$svc" "$vip" "$id"; done < "$WORK/fleet"

rc=0

case "$SCENARIO" in
  matrix)
    measure_matrix "overlay matrix, no rules (the compiled policy is allow-all)"
    expect_all ok || rc=1
    ;;

  rule-deny)
    A=$(first_service)
    B=$(second_service)
    A_VIP=$(vip_of "$A")
    B_VIP=$(vip_of "$B")

    measure_matrix "before the deny rule"
    expect_all ok || rc=1

    # An empty rule set compiles to allow-all, and the first rule written replaces
    # that with exactly the rules present. Denying one pair therefore means writing
    # the deny and the allow-all it is being carved out of, which is what an operator
    # has to do and what this does.
    echo "creating the deny rules and the allow-all they are carved out of"
    DENY_AB=$(api POST /api/acl/rules "{\"priority\":10,\"source_cidr\":\"$A_VIP\",\"destination_cidr\":\"$B_VIP\",\"action\":\"DROP\",\"description\":\"WP-202 scenario\"}" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    DENY_BA=$(api POST /api/acl/rules "{\"priority\":11,\"source_cidr\":\"$B_VIP\",\"destination_cidr\":\"$A_VIP\",\"action\":\"DROP\",\"description\":\"WP-202 scenario\"}" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    ALLOW=$(api POST /api/acl/rules '{"priority":100,"source_cidr":"0.0.0.0/0","destination_cidr":"0.0.0.0/0","action":"ACCEPT","description":"WP-202 scenario mesh default"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    converge

    measure_matrix "with $A and $B denied"
    expect_all ok "$A" "$B" timeout || rc=1

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
    for id in "$DENY_AB" "$DENY_BA" "$ALLOW"; do
      [ -n "$id" ] && api DELETE "/api/acl/rules/$id" > /dev/null
    done
    converge

    measure_matrix "after deleting the rules"
    expect_all ok || rc=1
    ;;

  quarantine)
    TARGET=$(second_service)
    TARGET_ID=$(node_id_of "$TARGET")

    measure_matrix "before the quarantine"
    expect_all ok || rc=1

    echo "quarantining $TARGET ($TARGET_ID)"
    api POST "/api/nodes/$TARGET_ID/action" '{"action":"quarantine","reason":"WP-202 scenario"}' > /dev/null
    converge

    measure_matrix "with $TARGET quarantined"
    while read -r src dst state rest; do
      if [ "$src" = "$TARGET" ] || [ "$dst" = "$TARGET" ]; then
        [ "$state" = "timeout" ] || { echo "unexpected: $src -> $dst is $state, expected timeout" >&2; rc=1; }
      else
        [ "$state" = "ok" ] || { echo "unexpected: $src -> $dst is $state, expected ok" >&2; rc=1; }
      fi
    done < "$WORK/matrix"

    echo "lifting the quarantine"
    api POST "/api/nodes/$TARGET_ID/action" '{"action":"lift_quarantine"}' > /dev/null
    converge

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
    converge
    converge

    measure_matrix "after the control plane returns"
    expect_all ok || rc=1
    ;;

  *)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac

if [ "$rc" -eq 0 ]; then
  echo "scenario '$SCENARIO': every cell matched what was expected"
else
  echo "scenario '$SCENARIO': at least one cell did not match; see the lines above" >&2
fi
exit "$rc"
