#!/bin/sh
# Usage: overlay.sh [matrix|telemetry|metrics|rule-deny|discovery|subnet|quarantine|revoke|fail-static|derp|profile|wss443]
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
#   profile       ADR 0029: name a relay as gateway, register a stock wg-quick device
#                 through the API, and measure real TCP to two nodes, an ACL DROP at
#                 the gateway, roaming, a second device spoofing the first's address,
#                 and the cut after deleting the device (image docker/wgclient)
#   wss443        ADR 0032 draft, wg-wss: the same device with every UDP packet dropped
#                 reaches the gateway through wstunnel behind an nginx that plays Nginx
#                 Proxy Manager; real TCP both ways, an ACL DROP next to a UDP device,
#                 probes without the secret prefix, the cut after deleting the device,
#                 and mutations of docker-compose.wss.yml. Needs the stack started with
#                   NERONET_EXTRA_COMPOSE_FILE="docker-compose.gateway.yml docker-compose.wss.yml"
#                   NERONET_WSS_PUBLIC_URL=wss://wss.neronet.test
#                 and NERONET_NODE_SERVICES="gateway relay-fr" for this script
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

# The same extra compose files stack.sh started the stack with (docker-compose.gateway.yml
# docker-compose.wss.yml for wss443): without them compose cannot name those services.
if [ -n "${NERONET_EXTRA_COMPOSE_FILE:-}" ]; then
  COMPOSE="$COMPOSE -f docker-compose.yml"
  for extra in $NERONET_EXTRA_COMPOSE_FILE; do
    [ -f "$extra" ] || die "no $extra"
    COMPOSE="$COMPOSE -f $extra"
  done
fi

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
    # Up to three reads: on a loaded Podman machine one `logs` call can come back
    # empty (a dropped connection to the machine), and a node left out of the fleet
    # for that reason looks exactly like a node that never enrolled.
    vip=
    for attempt in 1 2 3; do
      vip=$(node_logs "$svc" 2>/dev/null \
        | sed -n 's/.*Assigned Overlay VIP: \([0-9.]*\) .*/\1/p' | tail -1)
      [ -n "$vip" ] && break
      sleep 2
    done
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

# --- Profile devices (profile, wss443) ------------------------------------------
#
# A stock wg-quick device in its own container. These read GW, NET, WG_IMAGE and
# ECHO_PORT, which the scenario sets before calling them.

# api_secret <method> <path>: the JSON body comes on stdin, so a PSK never reaches
# a process argument list.
api_secret() {
  curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    --data-binary @-
}
json_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

# gw_counters -> "forwarded forward_dropped" from the gateway's latest drop report.
# The report is written every 15s and only when a counter moved, so the caller waits
# past one interval before reading it.
gw_counters() {
  node_logs_since "$GW" 30m 2>/dev/null < /dev/null | grep 'Data plane drops since start' | tail -1 \
    | sed -n 's/.*forward-dropped \([0-9]*\) .*forwarded \([0-9]*\) .*/\2 \1/p'
}
inbound_drops() {
  node_logs_since "$1" 30m 2>/dev/null < /dev/null | grep 'Data plane drops since start' | tail -1 \
    | sed -n 's/.*inbound \([0-9]*\) .*/\1/p'
}

# start_device <container> <name> -> sets REG to the API's answer. The key pair and
# the PSK are generated inside the container; the private key never leaves it.
start_device() {
  $ENGINE rm -f "$1" > /dev/null 2>&1 || true
  $ENGINE run -d --name "$1" --network "$NET" --cap-add NET_ADMIN --cap-add NET_RAW \
    "$WG_IMAGE" 'sleep infinity' > /dev/null ||
    die "starting $1 failed"
  pub=$($ENGINE exec "$1" sh -c 'umask 077; wg genkey > /etc/wireguard/private &&
    wg genpsk > /etc/wireguard/psk && wg pubkey < /etc/wireguard/private')
  [ -n "$pub" ] || die "no key pair in $1"
  REG=$( { printf '{"name":"%s","public_key":"%s","preshared_key":"' "$2" "$pub";
           $ENGINE exec "$1" cat /etc/wireguard/psk | tr -d '\n'; printf '"}'; } | api_secret POST /api/devices/profile)
  printf '%s' "$REG" | grep -q '"device_id"' || die "registering $2 failed: $(printf '%s' "$REG" | sed 's/"preshared[^,]*,//')"
}

# wg_up <container> <overlay address> <gateway public key> <endpoint> [keepalive] [mtu]:
# the profile exactly as ADR 0029 defines it, from the API's answer. wss443 passes the
# alternative profile's keepalive and MTU.
wg_up() {
  $ENGINE exec -e ADDR="$2" -e GWPUB="$3" -e EP="$4" -e KA="${5:-25}" -e MTU_LINE="${6:+MTU = $6}" "$1" sh -c 'umask 077; cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $(cat /etc/wireguard/private)
Address = $ADDR/32
$MTU_LINE

[Peer]
PublicKey = $GWPUB
PresharedKey = $(cat /etc/wireguard/psk)
Endpoint = $EP
AllowedIPs = 100.64.0.0/10
PersistentKeepalive = $KA
EOF
wg-quick up wg0 > /tmp/wg-quick.log 2>&1 || { grep -v -i key /tmp/wg-quick.log; exit 1; }
grep -i "userspace" /tmp/wg-quick.log || echo "  wg-quick up on the kernel WireGuard"' || die "wg-quick up failed in $1"
}

# dev_tcp <container> <vip> -> "ok <ms> <bytes>" or "fail <reason>". 64 KiB of random
# bytes go to the node's echo and must come back with the same SHA-256.
dev_tcp() {
  $ENGINE exec "$1" sh -c '
    head -c 65536 /dev/urandom > /tmp/payload
    want=$(sha256sum < /tmp/payload | cut -d" " -f1)
    t0=$(date +%s%N)
    { printf E; cat /tmp/payload; } | timeout 8 socat -t 4 - TCP:'"$2"':'"$ECHO_PORT"',connect-timeout=4 > /tmp/back 2>/dev/null
    t1=$(date +%s%N)
    got=$(sha256sum < /tmp/back | cut -d" " -f1)
    bytes=$(wc -c < /tmp/back)
    if [ "$got" = "$want" ]; then echo "ok $(( (t1 - t0) / 1000000 )) $bytes"; else echo "fail got-$bytes-bytes"; fi' < /dev/null
}

expect_tcp() { # <want ok|fail> <container> <vip> <label>
  r=$(dev_tcp "$2" "$3")
  echo "  $4: $r"
  [ "${r%% *}" = "$1" ] || { echo "unexpected: $4 is '$r', expected $1" >&2; rc=1; }
}

# wait_tcp <want> <container> <vip> <limit seconds> -> echoes the elapsed seconds
wait_tcp() {
  w_start=$(date +%s)
  while :; do
    r=$(dev_tcp "$2" "$3")
    [ "${r%% *}" = "$1" ] && { echo "$(($(date +%s) - w_start))"; return 0; }
    [ "$(($(date +%s) - w_start))" -ge "$4" ] && { echo "timeout"; return 1; }
    sleep 1
  done
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
    # Homes in the database are not homes in every node's netmap: a peer reaches
    # another over DERP only once it has fetched a netmap that names that node's new
    # home. On 9 November relay-de applied netmap 185 without relay-us's home, reached
    # relay-fr, and was measured against relay-us two seconds before netmap 195
    # arrived. Wait the same bound as every other phase before judging the matrix.
    converge
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

  profile)
    # ADR 0029 A5: a stock WireGuard client (wg-quick, the protocol of the official
    # iOS and Android apps) joins through the organisation's gateway and exchanges
    # real TCP with mesh nodes. Every claim below is a measurement: a payload whose
    # hash comes back intact, a capture of what crossed each interface, and the
    # gateway's own forwarding counters. Nothing is read from a database and called
    # reachability.
    [ -n "${COMPOSE_PROJECT_NAME:-}" ] && [ "$COMPOSE_PROJECT_NAME" != neronet ] \
      || die "profile requires a dedicated stack (COMPOSE_PROJECT_NAME other than neronet)"

    WG_IMAGE=${NERONET_WGCLIENT_IMAGE:-localhost/neronet-wgclient:dev}
    $ENGINE image inspect "$WG_IMAGE" > /dev/null 2>&1 ||
      $ENGINE build -t "$WG_IMAGE" -f docker/wgclient/Containerfile docker/wgclient ||
      die "building $WG_IMAGE failed"

    GW=${NERONET_PROFILE_GATEWAY:-relay-de}
    T1=${NERONET_PROFILE_TARGET1:-relay-fr}
    T2=${NERONET_PROFILE_TARGET2:-client-it}
    for svc in "$GW" "$T1" "$T2"; do
      [ -n "$(vip_of "$svc")" ] || die "$svc is not in the fleet"
    done
    GW_ID=$(node_id_of "$GW")
    T1_VIP=$(vip_of "$T1")
    T2_VIP=$(vip_of "$T2")
    DEV1="${COMPOSE_PROJECT_NAME}-a5-dev1"
    DEV2="${COMPOSE_PROJECT_NAME}-a5-dev2"
    DEV1_ID=
    DEV2_ID=
    DROP_ID=

    container_of() { $COMPOSE --profile nodes ps -q "$1" | head -1; }
    GW_CID=$(container_of "$GW")
    NET=$($ENGINE inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$GW_CID" | awk '{print $1}')
    GW_IP=$($ENGINE inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$GW_CID")
    [ -n "$NET" ] && [ -n "$GW_IP" ] || die "cannot read the gateway's network address"

    profile_cleanup() {
      for c in "$DEV1" "$DEV2"; do $ENGINE rm -f -t 0 "$c" > /dev/null 2>&1 || true; done
      [ -n "$DROP_ID" ] && api DELETE "/api/acl/rules/$DROP_ID" > /dev/null 2>&1 || true
      for id in $DEV1_ID $DEV2_ID; do api DELETE "/api/nodes/$id" > /dev/null 2>&1 || true; done
      rm -rf "$WORK"
    }
    trap profile_cleanup EXIT INT TERM

    echo "== profile gateway: $GW ($GW_ID) at $GW_IP:51820; targets $T1 ($T1_VIP) and $T2 ($T2_VIP)"
    api PUT /api/devices/gateway "{\"node_id\":\"$GW_ID\",\"endpoint\":\"$GW_IP:51820\"}" > "$WORK/gw.json"
    grep -q '"gateway"' "$WORK/gw.json" || die "naming the gateway failed: $(cat "$WORK/gw.json")"

    start_device "$DEV1" a5-phone
    DEV1_ID=$(printf '%s' "$REG" | json_field device_id)
    DEV1_VIP=$(printf '%s' "$REG" | json_field overlay_ipv4)
    GW_PUB=$(printf '%s' "$REG" | sed -n 's/.*"gateway":{"public_key":"\([^"]*\)".*/\1/p')
    GW_EP=$(printf '%s' "$REG" | sed -n 's/.*"gateway":{[^}]*"endpoint":"\([^"]*\)".*/\1/p')
    echo "registered $DEV1_ID at $DEV1_VIP; the answer names gateway endpoint $GW_EP"
    printf '%s' "$REG" | grep -qi private && { echo "the API answer contains a private key field" >&2; rc=1; }

    echo "waiting for $GW to serve the device..."
    i=0
    until node_logs_since "$GW" 5m 2>/dev/null < /dev/null | grep -q 'Profile gateway: forwarding for'; do
      i=$((i + 2)); [ "$i" -le 60 ] || die "$GW never switched forwarding on"
      sleep 2
    done
    echo "$GW forwards after ${i}s: $(node_logs_since "$GW" 5m 2>/dev/null < /dev/null | grep 'Profile gateway' | tail -1 | sed 's/.*Profile gateway: //')"
    # The mesh nodes learn the route to the device on their own next fetch.
    converge

    wg_up "$DEV1" "$DEV1_VIP" "$GW_PUB" "$GW_EP"

    echo
    echo "== (a) real TCP from the device to two mesh nodes and back, captured on both interfaces"
    $ENGINE exec -d "$DEV1" sh -c 'tcpdump -i eth0 -n -U -w /tmp/eth0.pcap ip 2>/tmp/eth0.err' > /dev/null
    $ENGINE exec -d "$DEV1" sh -c 'tcpdump -i wg0 -n -U -w /tmp/wg0.pcap 2>/tmp/wg0.err' > /dev/null
    sleep 2
    t=$(wait_tcp ok "$DEV1" "$T1_VIP" 60) || true
    echo "  first exchange with $T1 succeeded after ${t}s (handshake included)"
    expect_tcp ok "$DEV1" "$T1_VIP" "device -> $T1 ($T1_VIP)"
    expect_tcp ok "$DEV1" "$T2_VIP" "device -> $T2 ($T2_VIP)"
    sleep 1
    $ENGINE exec "$DEV1" sh -c 'pkill tcpdump; sleep 1' || true
    $ENGINE exec -e GW_IP="$GW_IP" -e T1="$T1_VIP" -e T2="$T2_VIP" -e P="$ECHO_PORT" "$DEV1" sh -c '
      tcpdump -n -r /tmp/eth0.pcap 2>/dev/null > /tmp/eth0.txt
      total=$(wc -l < /tmp/eth0.txt)
      wgudp=$(grep -c -E "IP [0-9.]+ > $GW_IP\.51820: |IP $GW_IP\.51820 > [0-9.]+: " /tmp/eth0.txt)
      plain=$(grep -c -E "100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\." /tmp/eth0.txt)
      echo "  eth0 capture (IPv4): $total packets, $wgudp of them WireGuard UDP with $GW_IP:51820, $plain carrying an overlay address in clear"
      tcpdump -n -r /tmp/wg0.pcap 2>/dev/null > /tmp/wg0.txt
      for n in $T1 $T2; do
        out=$(grep -c "> $n\.$P:" /tmp/wg0.txt); back=$(grep -c "IP $n\.$P >" /tmp/wg0.txt)
        syn=$(grep "> $n\.$P: Flags \[S\]" /tmp/wg0.txt | head -1 | cut -c1-90)
        echo "  wg0 capture, $n:$P: $out packets out, $back back; first SYN: $syn"
        [ "$out" -gt 0 ] && [ "$back" -gt 0 ] || { echo "  no plaintext exchange with $n captured on wg0: $(cat /tmp/wg0.err)"; exit 1; }
      done
      [ "$total" -gt 0 ] || { echo "  nothing captured on eth0: $(cat /tmp/eth0.err)"; exit 1; }
      [ "$plain" = 0 ] && [ "$wgudp" = "$total" ]' || { echo "unexpected: the captures do not show plaintext only inside wg0 and WireGuard only on eth0" >&2; rc=1; }
    $ENGINE exec "$DEV1" wg show wg0 transfer | sed 's/^[^\t]*\t/  device wg counters (rx tx bytes): /'
    echo "  waiting 16s for the gateway's counter report..."
    sleep 16
    set -- $(gw_counters)
    FWD_A=${1:-0}; FDROP_A=${2:-0}
    echo "  gateway counters: forwarded $FWD_A, forward-dropped $FDROP_A"
    [ "$FWD_A" -gt 100 ] || { echo "unexpected: the gateway reports $FWD_A forwarded packets for two 64 KiB exchanges" >&2; rc=1; }

    echo
    echo "== (b) an ACL DROP for the device, enforced at the gateway"
    T1_IN_BEFORE=$(inbound_drops "$T1"); T1_IN_BEFORE=${T1_IN_BEFORE:-0}
    DROP_ID=$(api POST /api/acl/rules "{\"priority\":5,\"source_cidr\":\"$DEV1_VIP/32\",\"destination_cidr\":\"100.64.0.0/10\",\"action\":\"DROP\",\"description\":\"A5 profile scenario\"}" \
      | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    [ -n "$DROP_ID" ] || die "creating the DROP rule failed"
    t=$(wait_tcp fail "$DEV1" "$T1_VIP" 60) || rc=1
    echo "  device -> $T1 blocked ${t}s after the rule was written"
    expect_tcp fail "$DEV1" "$T2_VIP" "device -> $T2 with the DROP"
    sleep 16
    set -- $(gw_counters)
    T1_IN_AFTER=$(inbound_drops "$T1")
    echo "  gateway forward-dropped: $FDROP_A -> ${2:-0}; $T1 inbound drops: $T1_IN_BEFORE -> ${T1_IN_AFTER:-0}"
    [ "${2:-0}" -gt "$FDROP_A" ] || { echo "unexpected: the gateway dropped nothing; the DROP was not enforced on the forwarded path" >&2; rc=1; }
    api DELETE "/api/acl/rules/$DROP_ID" > /dev/null
    DROP_ID=
    t=$(wait_tcp ok "$DEV1" "$T1_VIP" 60) || rc=1
    echo "  rule deleted: device -> $T1 restored after ${t}s"
    expect_tcp ok "$DEV1" "$T2_VIP" "device -> $T2 after the rule"

    echo
    echo "== (d) roaming: the device's network address changes under the tunnel"
    OLD_IP=$($ENGINE inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$DEV1")
    NEW_IP=$(echo "$OLD_IP" | awk -F. '{ last = ($4 == 250) ? 249 : 250; print $1"."$2"."$3"."last }')
    $ENGINE network disconnect "$NET" "$DEV1" > /dev/null
    $ENGINE network connect --ip "$NEW_IP" "$NET" "$DEV1" > /dev/null || die "reconnecting $DEV1 at $NEW_IP failed"
    echo "  $DEV1 moved from $OLD_IP to $($ENGINE inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$DEV1")"
    t=$(wait_tcp ok "$DEV1" "$T1_VIP" 120) || rc=1
    echo "  traffic resumed after ${t}s (a stock client re-handshakes when replies stop)"
    expect_tcp ok "$DEV1" "$T2_VIP" "device -> $T2 after roaming"

    echo
    echo "== (e) a second profile device sourcing the first device's address"
    start_device "$DEV2" a5-spoofer
    DEV2_ID=$(printf '%s' "$REG" | json_field device_id)
    DEV2_VIP=$(printf '%s' "$REG" | json_field overlay_ipv4)
    echo "  registered $DEV2_ID at $DEV2_VIP; its interface is given $DEV1_VIP instead"
    converge
    SPOOF_SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    sleep 16
    set -- $(gw_counters)
    FWD_E=${1:-0}
    wg_up "$DEV2" "$DEV1_VIP" "$GW_PUB" "$GW_EP"
    expect_tcp fail "$DEV2" "$T1_VIP" "spoofer -> $T1 with source $DEV1_VIP"
    expect_tcp fail "$DEV2" "$T2_VIP" "spoofer -> $T2 with source $DEV1_VIP"
    hs=$($ENGINE exec "$DEV2" wg show wg0 latest-handshakes | awk '{print $2}')
    tx=$($ENGINE exec "$DEV2" wg show wg0 transfer | awk '{print $3}')
    echo "  spoofer's WireGuard session: latest handshake $hs, $tx bytes sent"
    [ "${hs:-0}" -gt 0 ] && [ "${tx:-0}" -gt 0 ] || { echo "unexpected: the spoofer never reached the gateway; this proves nothing" >&2; rc=1; }
    sleep 16
    set -- $(gw_counters)
    disallowed=$(node_logs_since "$GW" "$SPOOF_SINCE" 2>/dev/null < /dev/null | grep -c 'disallowed source address' || true)
    echo "  gateway: forwarded $FWD_E -> ${1:-0}; 'disallowed source address' lines since the attempt: $disallowed"
    [ "${1:-0}" = "$FWD_E" ] || { echo "unexpected: the gateway forwarded packets while only the spoofer was sending" >&2; rc=1; }
    [ "$disallowed" -gt 0 ] || { echo "unexpected: the gateway logged no source-check drop" >&2; rc=1; }
    expect_tcp ok "$DEV1" "$T1_VIP" "the real device -> $T1 meanwhile"
    $ENGINE rm -f "$DEV2" > /dev/null
    api DELETE "/api/nodes/$DEV2_ID" > /dev/null
    DEV2_ID=

    echo
    echo "== (c) deleting the device cuts it within one netmap fetch"
    expect_tcp ok "$DEV1" "$T1_VIP" "device -> $T1 before"
    api DELETE "/api/nodes/$DEV1_ID" > "$WORK/delete.json"
    grep -q '"success":true\|revoked\|deleted' "$WORK/delete.json" || echo "  (delete answered: $(head -c 200 "$WORK/delete.json"))"
    DEV1_ID=
    t=$(wait_tcp fail "$DEV1" "$T1_VIP" 60) || rc=1
    echo "  device cut ${t}s after the delete (heartbeat and fetch every 15s)"
    case "$t" in ''|timeout) rc=1 ;; *) [ "$t" -le 25 ] || { echo "unexpected: the cut took ${t}s, more than one fetch" >&2; rc=1; } ;; esac
    node_logs_since "$GW" 2m 2>/dev/null < /dev/null | grep -E 'revoked|Netmap version [0-9]+ applied' | tail -2 | sed 's/^/  gateway: /'
    sleep 20
    expect_tcp fail "$DEV1" "$T1_VIP" "device -> $T1 20s later"
    expect_tcp fail "$DEV1" "$T2_VIP" "device -> $T2 20s later"
    ;;

  wss443)
    # ADR 0032 draft, phase 1a (method wg-wss): a stock wg-quick device on a network that
    # drops every UDP packet reaches the profile gateway through wstunnel over TCP 443,
    # behind a TLS-terminating reverse proxy, as on an installation where Nginx Proxy
    # Manager holds 443. Every claim is a measurement: a payload whose SHA-256 comes back,
    # iptables counters, captures in the device's and the gateway's network namespaces,
    # and the gateway's own counters. The secret path prefix comes from the API answer
    # and is never printed.
    [ -n "${COMPOSE_PROJECT_NAME:-}" ] && [ "$COMPOSE_PROJECT_NAME" != neronet ] \
      || die "wss443 requires a dedicated stack (COMPOSE_PROJECT_NAME other than neronet)"
    WSS_FILE=docker-compose.wss.yml
    case " ${NERONET_EXTRA_COMPOSE_FILE:-} " in
      *" docker-compose.gateway.yml "*"$WSS_FILE "*) ;;
      *) die "wss443 needs NERONET_EXTRA_COMPOSE_FILE=\"docker-compose.gateway.yml $WSS_FILE\" for stack.sh and this script" ;;
    esac

    WG_IMAGE=${NERONET_WGCLIENT_IMAGE:-localhost/neronet-wgclient:dev}
    $ENGINE image inspect "$WG_IMAGE" > /dev/null 2>&1 ||
      $ENGINE build -t "$WG_IMAGE" -f docker/wgclient/Containerfile docker/wgclient ||
      die "building $WG_IMAGE failed"
    NETFAULT_IMAGE=${NERONET_NETFAULT_IMAGE:-localhost/neronet-netfault:dev}
    $ENGINE image inspect "$NETFAULT_IMAGE" > /dev/null 2>&1 ||
      $ENGINE build -t "$NETFAULT_IMAGE" -f docker/netfault/Containerfile docker/netfault ||
      die "building $NETFAULT_IMAGE failed"
    # The client runs the same pinned upstream image as the server, read from the compose
    # file so the two cannot drift apart.
    WST_IMAGE=$(sed -n 's/^    image: \(ghcr\.io\/erebe\/wstunnel:[^ ]*\)$/\1/p' "$WSS_FILE")
    [ -n "$WST_IMAGE" ] || die "no wstunnel image in $WSS_FILE"
    # Stands in for Nginx Proxy Manager: TLS for the public name, one location for the
    # tunnel, everything else to the console.
    PROXY_IMAGE=${NERONET_WSS443_PROXY_IMAGE:-docker.io/library/nginx:1.27-alpine}
    PUBLIC_NAME=wss.neronet.test
    DIRECT_NAME=wss-direct.neronet.test

    GW=${NERONET_WSS443_GATEWAY:-gateway}
    T1=${NERONET_WSS443_TARGET1:-relay-fr}
    # One mesh node is enough; a second one only repeats the measurement.
    T2=${NERONET_WSS443_TARGET2:-$T1}
    for svc in "$GW" "$T1" "$T2"; do
      [ -n "$(vip_of "$svc")" ] || die "$svc is not in the fleet (NERONET_NODE_SERVICES must name it)"
    done
    GW_ID=$(node_id_of "$GW")
    T1_VIP=$(vip_of "$T1")
    T2_VIP=$(vip_of "$T2")

    P=$COMPOSE_PROJECT_NAME
    DEV1="$P-wss-dev1"     # the device behind the UDP block, through wstunnel
    DEV2="$P-wss-dev2"     # a control device on plain UDP
    PROBE="$P-wss-probe"   # an outsider on the same network
    PROXY="$P-wss-proxy"
    CAP="$P-wss-cap"       # a capture in the gateway's network namespace
    DEV1_ID=
    DEV2_ID=
    RULE_IDS=
    MUT_BACKUP=
    WSS_DIRTY=0

    container_of() { $COMPOSE --profile nodes ps -q "$1" | head -1; }
    ip_of() { $ENGINE inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$1"; }
    GW_CID=$(container_of "$GW")
    [ -n "$GW_CID" ] || die "$GW is not running"
    NET=$($ENGINE inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$GW_CID" | awk '{print $1}')
    GW_IP=$(ip_of "$GW_CID")
    [ -n "$NET" ] && [ -n "$GW_IP" ] || die "cannot read the gateway's network address"
    # Empty when the service is not running (podman inspect with no name lists everything).
    wss_ip() { _cid=$(container_of wstunnel); [ -n "$_cid" ] && ip_of "$_cid"; }
    wss_up() {
      WSS_IP=$(wss_ip) || true
      [ -n "$WSS_IP" ] || die "wstunnel did not start: $($COMPOSE logs --no-color --tail 5 wstunnel 2>&1)"
    }
    wss_up

    wss_cleanup() {
      for c in "$DEV1-wst" "$PROBE-wst" "$DEV1" "$DEV2" "$PROBE" "$PROXY" "$CAP"; do
        $ENGINE rm -f -t 0 "$c" > /dev/null 2>&1 || true
      done
      for id in $RULE_IDS; do api DELETE "/api/acl/rules/$id" > /dev/null 2>&1 || true; done
      for id in $DEV1_ID $DEV2_ID; do api DELETE "/api/nodes/$id" > /dev/null 2>&1 || true; done
      # A mutation interrupted half-way leaves the original file in place, byte for byte.
      # An interruption in the direct TLS part leaves the server as the stack started it.
      if [ -n "$MUT_BACKUP" ] && [ -f "$MUT_BACKUP" ]; then
        cp "$MUT_BACKUP" "$WSS_FILE"
        WSS_DIRTY=1
      fi
      if [ "$WSS_DIRTY" = 1 ]; then
        $COMPOSE up -d --no-deps --force-recreate wstunnel > /dev/null 2>&1 || true
      fi
      rm -rf "$WORK"
    }
    trap wss_cleanup EXIT INT TERM

    RESULTS="$WORK/results"
    : > "$RESULTS"
    # result <name> <pass|fail> <detail>: one line per named test, summarised at the end.
    result() {
      printf '%-28s %-4s %s\n' "$1" "$2" "$3" >> "$RESULTS"
      echo "  [$2] $1: $3"
      [ "$2" = pass ] || rc=1
    }

    # netfault <container> <script>: iptables inside that container's network namespace only.
    netfault() {
      $ENGINE run --rm --network "container:$1" --cap-add NET_ADMIN "$NETFAULT_IMAGE" "$2"
    }
    udp_block() {
      netfault "$1" 'iptables -I OUTPUT 1 -o eth0 -p udp -j DROP -m comment --comment neronet-wss443 &&
                     iptables -I INPUT 1 -i eth0 -p udp -j DROP -m comment --comment neronet-wss443'
    }
    udp_dropped() {
      netfault "$1" 'iptables -L -v -x -n | grep neronet-wss443' | awk '{p+=$1} END {print p+0}'
    }

    # Datagrams the gateway received on 51820 from the wstunnel server, counted by a
    # capture in the gateway's own network namespace.
    wss_datagrams() {
      $ENGINE exec "$CAP" sh -c "grep -c 'IP $WSS_IP\.[0-9]* > $GW_IP\.51820: UDP' /tmp/cap.txt || true" < /dev/null
    }
    restart_capture() {
      $ENGINE rm -f -t 0 "$CAP" > /dev/null 2>&1 || true
      $ENGINE run -d --name "$CAP" --network "container:$GW_CID" --cap-add NET_RAW --cap-add NET_ADMIN \
        "$WG_IMAGE" 'tcpdump -i eth0 -n -l udp dst port 51820 > /tmp/cap.txt 2>/tmp/cap.err' > /dev/null ||
        die "starting the gateway capture failed"
      sleep 2
    }

    # host_file <path>: the path in the notation the engine expects (--env-file).
    host_file() { printf '%s/%s' "$(HOST_PATH "$(dirname "$1")")" "$(basename "$1")"; }

    # A WireGuard handshake initiation has this shape: type 1, three zero bytes, 148 bytes.
    send_wg_like() { # <container> <udp port>
      $ENGINE exec "$1" sh -c "for i in 1 2 3; do { printf '\\001\\000\\000\\000'; head -c 144 /dev/urandom; } |
        socat -u - UDP:127.0.0.1:$2; sleep 1; done" < /dev/null
    }

    # probe_client <prefix env file> <server url> <-L spec>...: a wstunnel client in the
    # outsider's network namespace. The prefix is read from a file inside $WORK so it
    # never reaches a process argument list.
    probe_client() {
      pc_env=$1; pc_url=$2; shift 2
      $ENGINE rm -f -t 0 "$PROBE-wst" > /dev/null 2>&1 || true
      $ENGINE run -d --name "$PROBE-wst" --network "container:$PROBE" --entrypoint /home/app/wstunnel \
        -e NO_COLOR=true --env-file "$(host_file "$pc_env")" "$WST_IMAGE" client "$@" "$pc_url" > /dev/null ||
        die "starting the probe client failed"
      sleep 2
    }

    # http_probe <container> <socat address> <request> -> the status line and a verdict
    # on the answer: "banner" when anything in it names wstunnel. The Server header, if
    # any, is shown so the handbook can say what each port gives away.
    http_probe() {
      $ENGINE exec -e REQ="$3" "$1" sh -c "printf \"\$REQ\" | timeout 6 socat -t 3 - '$2' > /tmp/http.out 2>/dev/null
        first=\$(head -1 /tmp/http.out | tr -d '\r' | cut -c1-60)
        srv=\$(grep -i '^server:' /tmp/http.out | head -1 | tr -d '\r' | cut -c1-40)
        size=\$(wc -c < /tmp/http.out)
        if grep -qi wstunnel /tmp/http.out; then v=banner; else v=clean; fi
        echo \"\$v \${size}B '\${first:-<closed>}' \${srv:-no Server header}\"" < /dev/null
    }

    echo "== wss443: gateway $GW ($GW_ID) at $GW_IP:51820, wstunnel at $WSS_IP:8444, targets $T1 ($T1_VIP) and $T2 ($T2_VIP)"
    api PUT /api/devices/gateway "{\"node_id\":\"$GW_ID\",\"endpoint\":\"$GW_IP:51820\"}" > "$WORK/gw.json"
    grep -q '"gateway"' "$WORK/gw.json" || die "naming the gateway failed: $(cat "$WORK/gw.json")"

    start_device "$DEV1" wss-laptop
    DEV1_ID=$(printf '%s' "$REG" | json_field device_id)
    DEV1_VIP=$(printf '%s' "$REG" | json_field overlay_ipv4)
    GW_PUB=$(printf '%s' "$REG" | sed -n 's/.*"gateway":{"public_key":"\([^"]*\)".*/\1/p')
    GW_EP=$(printf '%s' "$REG" | sed -n 's/.*"gateway":{[^}]*"endpoint":"\([^"]*\)".*/\1/p')
    STRICT=$(printf '%s' "$REG" | sed -n 's/.*"strict_network":{\([^}]*\)}.*/\1/p')
    WSS_URL=$(printf '{%s}' "$STRICT" | json_field url)
    WSS_REMOTE=$(printf '{%s}' "$STRICT" | json_field remote)
    WSS_LOCAL=$(printf '{%s}' "$STRICT" | json_field local_endpoint)
    WSS_MTU=$(printf '{%s}' "$STRICT" | sed -n 's/.*"mtu":\([0-9]*\).*/\1/p')
    WSS_KA=$(printf '{%s}' "$STRICT" | sed -n 's/.*"persistent_keepalive":\([0-9]*\).*/\1/p')
    # The secret goes to files in $WORK (mode 600) and nowhere else.
    ( umask 077
      printf '{%s}' "$STRICT" | json_field path_prefix > "$WORK/secret"
      printf 'WSTUNNEL_HTTP_UPGRADE_PATH_PREFIX=%s\n' "$(cat "$WORK/secret")" > "$WORK/secret.env"
      printf 'WSTUNNEL_HTTP_UPGRADE_PATH_PREFIX=%s\n' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$WORK/wrong.env"
      printf 'WSTUNNEL_HTTP_UPGRADE_PATH_PREFIX=v1\n' > "$WORK/default.env" )
    SECRET_LEN=$(tr -d '\n' < "$WORK/secret" | wc -c | tr -d ' ')
    echo "registered $DEV1_ID at $DEV1_VIP; strict_network: url $WSS_URL, remote $WSS_REMOTE, local $WSS_LOCAL, MTU $WSS_MTU, keepalive $WSS_KA, path prefix $SECRET_LEN characters (not shown)"
    if [ "$WSS_URL" = "wss://$PUBLIC_NAME" ] && [ "$SECRET_LEN" -ge 32 ] && [ "$WSS_LOCAL" = 127.0.0.1:51820 ] &&
       [ "$WSS_MTU" = 1380 ] && [ "$WSS_KA" = 20 ]; then
      result api-strict-network pass "the signed-in answer carries the tunnel address, the remote and a $SECRET_LEN-character prefix"
    else
      result api-strict-network fail "strict_network is missing or not what docker-compose.wss.yml configures (start the stack with NERONET_WSS_PUBLIC_URL=wss://$PUBLIC_NAME)"
    fi

    # The reverse proxy, configured the way Nginx Proxy Manager writes a custom location
    # with "Websockets support" on: same headers, nginx's default 60 s read timeout.
    mkdir -p "$WORK/proxy"
    ( cd "$WORK/proxy" && umask 077 &&
      openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=wss443 test CA" \
        -keyout ca.key -out ca.crt > /dev/null 2>&1 &&
      openssl req -newkey rsa:2048 -nodes -subj "/CN=$PUBLIC_NAME" -keyout proxy.key -out proxy.csr > /dev/null 2>&1 &&
      printf 'subjectAltName=DNS:%s,DNS:%s\n' "$PUBLIC_NAME" "$DIRECT_NAME" > san.ext &&
      openssl x509 -req -in proxy.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -extfile san.ext \
        -out proxy.crt > /dev/null 2>&1 ) || die "making the proxy's test certificate failed"
    { cat <<EOF
server {
    listen 443 ssl;
    server_name $PUBLIC_NAME;
    ssl_certificate /etc/nginx/conf.d/proxy.crt;
    ssl_certificate_key /etc/nginx/conf.d/proxy.key;

    location /$(cat "$WORK/secret") {
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Scheme \$scheme;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$http_connection;
        proxy_http_version 1.1;
        proxy_pass http://wstunnel:8444;
    }

    location / {
        proxy_set_header Host \$host;
        proxy_pass https://frontend:8443;
    }
}
EOF
    } > "$WORK/proxy/default.conf"
    chmod 644 "$WORK/proxy/proxy.crt" "$WORK/proxy/proxy.key" "$WORK/proxy/default.conf" "$WORK/proxy/ca.crt"
    $ENGINE rm -f "$PROXY" > /dev/null 2>&1 || true
    $ENGINE run -d --name "$PROXY" --network "$NET" -v "$(HOST_PATH "$WORK/proxy"):/etc/nginx/conf.d:ro" \
      "$PROXY_IMAGE" > /dev/null || die "starting the reverse proxy failed"
    sleep 2
    PROXY_IP=$(ip_of "$PROXY")
    [ -n "$PROXY_IP" ] || die "the reverse proxy has no address: $($ENGINE logs "$PROXY" 2>&1 | tail -3)"
    echo "reverse proxy $PROXY at $PROXY_IP:443 for $PUBLIC_NAME: /<prefix> -> wstunnel:8444, / -> the console"
    $ENGINE exec "$DEV1" sh -c "echo '$PROXY_IP $PUBLIC_NAME' >> /etc/hosts"

    echo "waiting for $GW to serve the device..."
    i=0
    until node_logs_since "$GW" 5m 2>/dev/null < /dev/null | grep -q 'Profile gateway: forwarding for'; do
      i=$((i + 2)); [ "$i" -le 90 ] || die "$GW never switched forwarding on"
      sleep 2
    done
    converge
    restart_capture

    echo
    echo "== (1) all UDP dropped on the device's network; only TCP is left"
    udp_block "$DEV1"
    echo "  -- negative control: the ordinary profile (Endpoint $GW_EP) with UDP dropped"
    wg_up "$DEV1" "$DEV1_VIP" "$GW_PUB" "$GW_EP"
    expect_tcp fail "$DEV1" "$T1_VIP" "device -> $T1 over plain UDP, blocked"
    sleep 12
    hs=$($ENGINE exec "$DEV1" wg show wg0 latest-handshakes | awk '{print $2}')
    dropped=$(udp_dropped "$DEV1")
    if [ "${hs:-0}" = 0 ] && [ "$dropped" -gt 0 ]; then
      result 1-negative-control pass "no handshake in 20 s; iptables dropped $dropped UDP packets on eth0"
    else
      result 1-negative-control fail "handshake $hs, dropped $dropped: the UDP block does not hold, so test 1 proves nothing"
    fi
    $ENGINE exec "$DEV1" wg-quick down wg0 > /dev/null 2>&1 || true

    echo "  -- the same device through wstunnel and the reverse proxy"
    dropped_before=$(udp_dropped "$DEV1")
    dg_before=$(wss_datagrams)
    $ENGINE exec -d "$DEV1" sh -c 'tcpdump -i eth0 -n -U -w /tmp/eth0.pcap ip 2>/tmp/eth0.err' > /dev/null
    $ENGINE rm -f "$DEV1-wst" > /dev/null 2>&1 || true
    $ENGINE run -d --name "$DEV1-wst" --network "container:$DEV1" --entrypoint /home/app/wstunnel \
      -e NO_COLOR=true --env-file "$(host_file "$WORK/secret.env")" -e SSL_CERT_FILE=/ca/ca.crt \
      -v "$(HOST_PATH "$WORK/proxy"):/ca:ro" "$WST_IMAGE" \
      client --tls-verify-certificate -L "udp://$WSS_LOCAL:$WSS_REMOTE?timeout_sec=0" "$WSS_URL" > /dev/null ||
      die "starting the device's wstunnel client failed"
    sleep 2
    wg_up "$DEV1" "$DEV1_VIP" "$GW_PUB" "$WSS_LOCAL" "$WSS_KA" "$WSS_MTU"
    t=$(wait_tcp ok "$DEV1" "$T1_VIP" 60) || true
    echo "  first exchange with $T1 after ${t}s (handshake included)"
    r1=$(dev_tcp "$DEV1" "$T1_VIP"); r2=$(dev_tcp "$DEV1" "$T2_VIP")
    echo "  device -> $T1: $r1; device -> $T2: $r2 (64 KiB random, SHA-256 compared)"
    hs=$($ENGINE exec "$DEV1" wg show wg0 latest-handshakes | awk '{print $2}')
    # The other way: a mesh node opens the connection to the device's overlay address.
    $ENGINE exec -d "$DEV1" sh -c "socat TCP-LISTEN:$ECHO_PORT,bind=$DEV1_VIP,fork,reuseaddr SYSTEM:'tail -c +2'" > /dev/null
    sleep 1
    # The node may still be setting up its session to the gateway for this new peer; the
    # first answer within 45 s counts, and the wait is reported.
    w_start=$(date +%s)
    while :; do
      back=$(node_exec "$T1" env NERONET_OVERLAY_PAYLOAD_BYTES=65536 /bin/sovereign-cli overlay-dial \
        "$SOCKS" "$DEV1_VIP:$ECHO_PORT" 10 2>/dev/null < /dev/null) || true
      case "$back" in ok*) break ;; esac
      [ "$(($(date +%s) - w_start))" -ge 45 ] && break
      sleep 2
    done
    echo "  $T1 -> device ($DEV1_VIP:$ECHO_PORT), 64 KiB: ${back:-no answer} after $(($(date +%s) - w_start))s"
    sleep 1
    $ENGINE exec "$DEV1" sh -c 'pkill tcpdump; sleep 1' || true
    eth0=$($ENGINE exec -e PIP="$PROXY_IP" "$DEV1" sh -c '
      tcpdump -n -r /tmp/eth0.pcap 2>/dev/null > /tmp/eth0.txt
      total=$(wc -l < /tmp/eth0.txt)
      tls=$(grep -c -E "IP [0-9.]+ > $PIP\.443: |IP $PIP\.443 > [0-9.]+: " /tmp/eth0.txt)
      udp=$(grep -c " UDP" /tmp/eth0.txt)
      echo "$total $tls $udp"' < /dev/null)
    # shellcheck disable=SC2086 # three numbers, split on purpose
    set -- $eth0
    dropped_after=$(udp_dropped "$DEV1")
    dg_after=$(wss_datagrams)
    echo "  device eth0 capture: $1 IPv4 packets, $2 of them TCP with the proxy's 443, $3 UDP; iptables UDP drops $dropped_before -> $dropped_after"
    echo "  gateway capture: datagrams from wstunnel ($WSS_IP) to 51820: $dg_before -> $dg_after"
    if [ "${r1%% *}" = ok ] && [ "${r2%% *}" = ok ] && [ "${hs:-0}" -gt 0 ]; then
      result 1-tcp-device-to-mesh pass "handshake done, 64 KiB echoed intact by $T1 and $T2 (${r1#ok }, ${r2#ok })"
    else
      result 1-tcp-device-to-mesh fail "handshake $hs; $T1 '$r1'; $T2 '$r2'"
    fi
    case "$back" in
      ok*) result 1-tcp-mesh-to-device pass "$T1 opened TCP to the device and got its 64 KiB back ($back)" ;;
      *) result 1-tcp-mesh-to-device fail "$T1 -> device: '${back:-no answer}'" ;;
    esac
    if [ "$1" -gt 0 ] && [ "$2" = "$1" ] && [ "$dg_after" -gt "$dg_before" ]; then
      result 1-path-is-tcp-443 pass "every packet on the device's wire was TCP with the proxy's 443; the gateway got $((dg_after - dg_before)) datagrams from wstunnel"
    else
      result 1-path-is-tcp-443 fail "eth0 $1 packets, $2 with the proxy; gateway datagrams $dg_before -> $dg_after"
    fi

    echo
    echo "== (2) an ACL DROP cuts the device over wss exactly as it cuts a device over UDP"
    start_device "$DEV2" udp-laptop
    DEV2_ID=$(printf '%s' "$REG" | json_field device_id)
    DEV2_VIP=$(printf '%s' "$REG" | json_field overlay_ipv4)
    converge
    wg_up "$DEV2" "$DEV2_VIP" "$GW_PUB" "$GW_EP"
    t=$(wait_tcp ok "$DEV2" "$T1_VIP" 60) || true
    echo "  control device $DEV2_ID ($DEV2_VIP) on plain UDP reaches $T1 after ${t}s"
    expect_tcp ok "$DEV1" "$T1_VIP" "wss device -> $T1 before the rules"
    sleep 16
    # shellcheck disable=SC2046 # two numbers, split on purpose
    set -- $(gw_counters)
    FDROP_BEFORE=${2:-0}
    for vip in "$DEV1_VIP" "$DEV2_VIP"; do
      id=$(api POST /api/acl/rules "{\"priority\":5,\"source_cidr\":\"$vip/32\",\"destination_cidr\":\"100.64.0.0/10\",\"action\":\"DROP\",\"description\":\"wss443 scenario\"}" \
        | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
      [ -n "$id" ] || die "creating the DROP rule for $vip failed"
      RULE_IDS="$RULE_IDS $id"
    done
    t1=$(wait_tcp fail "$DEV1" "$T1_VIP" 60) || true
    t2=$(wait_tcp fail "$DEV2" "$T1_VIP" 60) || true
    r_wss=$(dev_tcp "$DEV1" "$T2_VIP"); r_udp=$(dev_tcp "$DEV2" "$T2_VIP")
    sleep 16
    # shellcheck disable=SC2046 # two numbers, split on purpose
    set -- $(gw_counters)
    FDROP_AFTER=${2:-0}
    echo "  blocked after the rule: wss ${t1}s, udp ${t2}s; to $T2: wss '$r_wss', udp '$r_udp'; gateway forward-dropped $FDROP_BEFORE -> $FDROP_AFTER"
    if [ "${r_wss%% *}" = fail ] && [ "${r_udp%% *}" = fail ] && [ "$t1" != timeout ] && [ "$t2" != timeout ] &&
       [ "$FDROP_AFTER" -gt "$FDROP_BEFORE" ]; then
      result 2-deny-rule pass "both devices cut (wss ${t1}s, udp ${t2}s), the gateway's forward-dropped rose by $((FDROP_AFTER - FDROP_BEFORE))"
    else
      result 2-deny-rule fail "wss ${t1}/'$r_wss', udp ${t2}/'$r_udp', forward-dropped $FDROP_BEFORE -> $FDROP_AFTER"
    fi
    for id in $RULE_IDS; do api DELETE "/api/acl/rules/$id" > /dev/null; done
    RULE_IDS=
    t1=$(wait_tcp ok "$DEV1" "$T1_VIP" 60) || true
    t2=$(wait_tcp ok "$DEV2" "$T1_VIP" 60) || true
    if [ "$t1" != timeout ] && [ "$t2" != timeout ]; then
      result 2-rule-deleted pass "both devices back after the rules went: wss ${t1}s, udp ${t2}s"
    else
      result 2-rule-deleted fail "wss $t1, udp $t2"
    fi
    $ENGINE rm -f -t 0 "$DEV2" > /dev/null
    api DELETE "/api/nodes/$DEV2_ID" > /dev/null
    DEV2_ID=

    echo
    echo "== (4) probes from an outsider: nothing without the prefix reaches the gateway"
    # The device's tunnel is paused so that every datagram counted now is a probe's.
    $ENGINE exec "$DEV1" wg-quick down wg0 > /dev/null 2>&1 || true
    $ENGINE stop -t 1 "$DEV1-wst" > /dev/null
    $ENGINE rm -f "$PROBE" > /dev/null 2>&1 || true
    $ENGINE run -d --name "$PROBE" --network "$NET" "$WG_IMAGE" 'sleep infinity' > /dev/null || die "starting $PROBE failed"
    $ENGINE exec "$PROBE" sh -c "echo '$PROXY_IP $PUBLIC_NAME' >> /etc/hosts"
    sleep 3
    UPGRADE='GET /%s/events HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'

    # probe_4c: the wstunnel port itself (reachable on the LAN in production), with a
    # wrong prefix: refused, no datagram. Removing the path check turns it red.
    probe_4c() {
      wrong=$(sed -n 's/^WSTUNNEL_HTTP_UPGRADE_PATH_PREFIX=//p' "$WORK/wrong.env")
      # shellcheck disable=SC2059 # the request template is the format
      ans=$(http_probe "$PROBE" "TCP:wstunnel:8444" "$(printf "$UPGRADE" "$wrong" "wstunnel:8444")")
      before=$(wss_datagrams)
      probe_client "$WORK/wrong.env" ws://wstunnel:8444 -L "udp://127.0.0.1:51830:$WSS_REMOTE?timeout_sec=0"
      send_wg_like "$PROBE" 51830
      sleep 3
      after=$(wss_datagrams)
      echo "    direct to wstunnel:8444 with a wrong prefix: answer $ans; gateway datagrams $before -> $after"
      [ "$after" = "$before" ] && [ "${ans%% *}" = clean ] && ! printf '%s' "$ans" | grep -q ' 101 '
    }
    # probe_4d: the right prefix but a destination other than the gateway's 51820 (the
    # console's API): refused. Removing --restrict-to turns it red.
    probe_4d() {
      probe_client "$WORK/secret.env" ws://wstunnel:8444 -L tcp://127.0.0.1:18081:backend:8081
      # stdin stays open for 3 s: wstunnel closes the whole tunnel on a half-close, which
      # would make an opened tunnel look refused.
      got=$($ENGINE exec "$PROBE" sh -c "(printf 'GET /api/health HTTP/1.0\r\n\r\n'; sleep 3) |
        timeout 8 socat -t 3 - TCP:127.0.0.1:18081 2>/dev/null | head -1 | tr -d '\r'" < /dev/null)
      echo "    right prefix, destination backend:8081: '${got:-<closed>}'"
      [ -z "$got" ]
    }
    # probe_4d_control: the same client to the allowed destination does deliver datagrams,
    # so a zero above is the server refusing, not a capture that sees nothing.
    probe_4d_control() {
      before=$(wss_datagrams)
      probe_client "$WORK/secret.env" ws://wstunnel:8444 -L "udp://127.0.0.1:51831:$WSS_REMOTE?timeout_sec=0"
      send_wg_like "$PROBE" 51831
      sleep 3
      after=$(wss_datagrams)
      echo "    right prefix, allowed destination $WSS_REMOTE: gateway datagrams $before -> $after"
      [ "$after" -gt "$before" ]
    }

    before=$(wss_datagrams)
    ans=$(http_probe "$PROBE" "OPENSSL:$PUBLIC_NAME:443,verify=0" "GET / HTTP/1.1\r\nHost: $PUBLIC_NAME\r\nConnection: close\r\n\r\n")
    echo "    HTTPS GET / through the proxy: $ans"
    case "$ans" in clean*" 200 OK"*) result 4a-no-prefix-page pass "the console's own page ($ans), nothing from wstunnel" ;;
      *) result 4a-no-prefix-page fail "$ans" ;; esac

    # shellcheck disable=SC2059 # the request template is the format
    ans=$(http_probe "$PROBE" "OPENSSL:$PUBLIC_NAME:443,verify=0" "$(printf "$UPGRADE" v1 "$PUBLIC_NAME")")
    probe_client "$WORK/default.env" "wss://$PUBLIC_NAME" -L "udp://127.0.0.1:51832:$WSS_REMOTE?timeout_sec=0"
    send_wg_like "$PROBE" 51832
    sleep 3
    after=$(wss_datagrams)
    echo "    WebSocket upgrade on wstunnel's default path /v1/events through the proxy: $ans; gateway datagrams $before -> $after"
    if [ "$after" = "$before" ] && [ "${ans%% *}" = clean ] && ! printf '%s' "$ans" | grep -q ' 101 '; then
      result 4b-wrong-path-proxy pass "no upgrade ($ans), no datagram at the gateway"
    else
      result 4b-wrong-path-proxy fail "$ans, datagrams $before -> $after"
    fi

    if probe_4c; then result 4c-wrong-path-direct pass "refused with no banner, no datagram"
    else result 4c-wrong-path-direct fail "the wstunnel port accepted a wrong prefix or named itself"; fi
    if probe_4d; then result 4d-restrict-to pass "a tunnel to backend:8081 was refused"
    else result 4d-restrict-to fail "a tunnel to backend:8081 was opened"; fi
    if probe_4d_control; then result 4d-capture-control pass "the allowed destination does deliver datagrams to the gateway"
    else result 4d-capture-control fail "no datagram even on the allowed path: the counts above prove nothing"; fi

    before=$(wss_datagrams)
    $ENGINE exec "$PROBE" sh -c 'head -c 512 /dev/urandom > /tmp/garbage' < /dev/null
    g1=$($ENGINE exec "$PROBE" sh -c "timeout 6 socat -t 3 - TCP:$PUBLIC_NAME:443 < /tmp/garbage > /tmp/g1 2>/dev/null;
      if grep -qi wstunnel /tmp/g1; then v=banner; else v=clean; fi;
      echo \"\$v \$(wc -c < /tmp/g1)B '\$(head -1 /tmp/g1 | tr -d '\r' | tr -cd '[:print:]' | cut -c1-40)'\"" < /dev/null)
    g2=$($ENGINE exec "$PROBE" sh -c "timeout 6 socat -t 3 - TCP:wstunnel:8444 < /tmp/garbage > /tmp/g2 2>/dev/null;
      if grep -qi wstunnel /tmp/g2; then v=banner; else v=clean; fi;
      echo \"\$v \$(wc -c < /tmp/g2)B '\$(head -1 /tmp/g2 | tr -d '\r' | tr -cd '[:print:]' | cut -c1-40)'\"" < /dev/null)
    after=$(wss_datagrams)
    echo "    512 random bytes to the proxy's 443: $g1; to wstunnel:8444: $g2; gateway datagrams $before -> $after"
    if [ "${g1%% *}" = clean ] && [ "${g2%% *}" = clean ] && [ "$after" = "$before" ]; then
      result 4e-raw-garbage pass "no banner from either port, no datagram"
    else
      result 4e-raw-garbage fail "proxy $g1; wstunnel $g2; datagrams $before -> $after"
    fi
    leaks=$($COMPOSE logs --no-color wstunnel 2>&1 | grep -c -F -f "$WORK/secret" || true)
    if [ "$leaks" = 0 ]; then result 4f-secret-not-logged pass "the prefix appears in none of the wstunnel server's log lines"
    else result 4f-secret-not-logged fail "the prefix appears in $leaks wstunnel log lines"; fi
    $ENGINE rm -f -t 0 "$PROBE-wst" > /dev/null 2>&1 || true

    echo
    echo "== (3) deleting the device cuts it within one netmap fetch, tunnel or not"
    $ENGINE start "$DEV1-wst" > /dev/null
    sleep 2
    wg_up "$DEV1" "$DEV1_VIP" "$GW_PUB" "$WSS_LOCAL" "$WSS_KA" "$WSS_MTU"
    t=$(wait_tcp ok "$DEV1" "$T1_VIP" 60) || true
    expect_tcp ok "$DEV1" "$T1_VIP" "device -> $T1 before (back after ${t}s)"
    api DELETE "/api/nodes/$DEV1_ID" > /dev/null
    DEV1_ID=
    t=$(wait_tcp fail "$DEV1" "$T1_VIP" 60) || true
    sleep 20
    late1=$(dev_tcp "$DEV1" "$T1_VIP"); late2=$(dev_tcp "$DEV1" "$T2_VIP")
    echo "  cut ${t}s after the delete; 20 s later: $T1 '$late1', $T2 '$late2'"
    case "$t" in
      ''|timeout) result 3-revoke fail "still reachable 60 s after the delete" ;;
      *) if [ "$t" -le 25 ] && [ "${late1%% *}" = fail ] && [ "${late2%% *}" = fail ]; then
           result 3-revoke pass "cut ${t}s after the delete (one fetch is 15 s), still cut 20 s later"
         else
           result 3-revoke fail "cut after ${t}s; later $late1 / $late2"
         fi ;;
    esac
    $ENGINE rm -f -t 0 "$DEV1-wst" "$DEV1" > /dev/null

    echo
    echo "== (1d) without a proxy: wstunnel terminates TLS itself (docker-compose.wss-tls.yml)"
    WSS_DIRTY=1
    NERONET_WSS_TLS_CERT="$(HOST_PATH "$WORK/proxy")/proxy.crt" NERONET_WSS_TLS_KEY="$(HOST_PATH "$WORK/proxy")/proxy.key" \
      $COMPOSE -f docker-compose.wss-tls.yml up -d --no-deps --force-recreate wstunnel > /dev/null 2>&1 ||
      die "recreating wstunnel in direct TLS mode failed"
    sleep 3
    wss_up
    restart_capture
    $ENGINE exec "$PROBE" sh -c "echo '$WSS_IP $DIRECT_NAME' >> /etc/hosts"
    # direct_client <env file> <udp port>: a certificate-checking client straight to the
    # wstunnel port, which now holds the certificate for $DIRECT_NAME.
    direct_client() {
      $ENGINE rm -f -t 0 "$PROBE-wst" > /dev/null 2>&1 || true
      $ENGINE run -d --name "$PROBE-wst" --network "container:$PROBE" --entrypoint /home/app/wstunnel \
        -e NO_COLOR=true --env-file "$(host_file "$1")" -e SSL_CERT_FILE=/ca/ca.crt -v "$(HOST_PATH "$WORK/proxy"):/ca:ro" \
        "$WST_IMAGE" client --tls-verify-certificate -L "udp://127.0.0.1:$2:$WSS_REMOTE?timeout_sec=0" \
        "wss://$DIRECT_NAME:8444" > /dev/null || die "starting the direct client failed"
      sleep 2
    }
    before=$(wss_datagrams)
    direct_client "$WORK/secret.env" 51833
    send_wg_like "$PROBE" 51833
    sleep 3
    mid=$(wss_datagrams)
    direct_client "$WORK/wrong.env" 51834
    send_wg_like "$PROBE" 51834
    sleep 3
    after=$(wss_datagrams)
    echo "  wss://$DIRECT_NAME:8444 with the certificate checked: right prefix $before -> $mid datagrams, wrong prefix $mid -> $after"
    if [ "$mid" -gt "$before" ] && [ "$after" = "$mid" ]; then
      result 1d-direct-tls pass "TLS by wstunnel itself: the right prefix delivers, a wrong one does not"
    else
      result 1d-direct-tls fail "right prefix $before -> $mid, wrong prefix $mid -> $after"
    fi
    $ENGINE rm -f -t 0 "$PROBE-wst" > /dev/null 2>&1 || true
    $COMPOSE up -d --no-deps --force-recreate wstunnel > /dev/null 2>&1 || die "recreating wstunnel failed"
    sleep 3
    WSS_DIRTY=0
    wss_up
    restart_capture

    echo
    echo "== (9) mutations of $WSS_FILE: each must turn a named test red"
    ORIG_SHA=$(sha256sum < "$WSS_FILE" | cut -d' ' -f1)
    # mutate <label> <sed program> <probe function> <test name>
    mutate() {
      MUT_BACKUP="$WORK/wss.orig"
      cp "$WSS_FILE" "$MUT_BACKUP"
      sed -i "$2" "$WSS_FILE"
      if cmp -s "$WSS_FILE" "$MUT_BACKUP"; then
        result "9-$1" fail "the sed program changed nothing; the mutation is not applied"
      else
        $COMPOSE up -d --no-deps --force-recreate wstunnel > /dev/null 2>&1 || die "recreating wstunnel failed"
        sleep 3
        wss_up
        restart_capture
        if "$3"; then
          result "9-$1" fail "$4 stayed green with the mutation: it does not guard this line"
        else
          result "9-$1" pass "$4 turned red with the mutation"
        fi
      fi
      cp "$MUT_BACKUP" "$WSS_FILE"
      MUT_BACKUP=
      sha=$(sha256sum < "$WSS_FILE" | cut -d' ' -f1)
      $COMPOSE up -d --no-deps --force-recreate wstunnel > /dev/null 2>&1 || die "recreating wstunnel failed"
      sleep 3
      wss_up
      restart_capture
      if [ "$sha" = "$ORIG_SHA" ] && git diff --quiet -- "$WSS_FILE" && "$3"; then
        result "9-$1-restored" pass "file byte-identical (sha256 ${sha%"${sha#????????????}"}...), $4 green again"
      else
        result "9-$1-restored" fail "restore incomplete: sha $sha, $4 after restore failed"
      fi
    }
    mutate no-restrict-to '/^      - --restrict-to$/,/^      - \${NERONET_WSS_UPSTREAM/d' probe_4d 4d-restrict-to
    mutate no-path-check '/^      WSTUNNEL_RESTRICT_HTTP_UPGRADE_PATH_PREFIX:/d' probe_4c 4c-wrong-path-direct
    $ENGINE rm -f -t 0 "$PROBE-wst" "$PROBE" > /dev/null 2>&1 || true

    echo
    echo "== wss443 results"
    cat "$RESULTS"
    ;;

  *)
    sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac

if [ "$rc" -eq 0 ]; then
  echo "scenario '$SCENARIO': every cell matched what was expected"
else
  echo "scenario '$SCENARIO': at least one cell did not match; see the lines above" >&2
fi
exit "$rc"
