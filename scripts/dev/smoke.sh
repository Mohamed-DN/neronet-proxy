#!/bin/sh
# Usage: smoke.sh [expected-nodes] [timeout-seconds]
#
# Waits until the stack has `expected-nodes` (default 6) nodes with a heartbeat in the
# last 60 s, then checks that /api/health answers with status "ok" on the API port and
# through the console's nginx. Run it after `stack.sh up` and `stack.sh nodes`.
#
# Uses the same COMPOSE_PROJECT_NAME and NERONET_*_PORT variables as stack.sh.
# Exits non-zero, with the last state printed, if the count is not reached in time.
set -eu
. "$(dirname "$0")/engine.sh"

EXPECTED=${1:-6}
TIMEOUT=${2:-180}

OFFSET=${NERONET_PORT_OFFSET:-0}
API_PORT=${NERONET_API_PORT:-$((8081 + OFFSET))}
CONSOLE_PORT=${NERONET_CONSOLE_PORT:-$((8443 + OFFSET))}

# `stack.sh status` prints "nodes with a heartbeat under 60 s: N of M registered".
count_alive() {
  line=$(sh "$(dirname "$0")/stack.sh" status 2>/dev/null | grep '^nodes with a heartbeat' || true)
  [ -n "$line" ] || { echo 0; return; }
  echo "$line" | sed 's/^[^:]*: *\([0-9][0-9]*\) of.*/\1/'
}

start=$(date +%s)
alive=0
while :; do
  alive=$(count_alive)
  [ "$alive" -ge "$EXPECTED" ] && break
  elapsed=$(($(date +%s) - start))
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "FAIL  $alive of $EXPECTED nodes have a heartbeat after ${TIMEOUT}s" >&2
    exit 1
  fi
  sleep 5
done
echo "PASS  $alive of $EXPECTED nodes have a heartbeat"

rc=0
for port in "$API_PORT" "$CONSOLE_PORT"; do
  body=$(curl -fsS --max-time 10 "http://127.0.0.1:$port/api/health" 2>&1) || body=""
  case "$body" in
    *'"status":"ok"'*) echo "PASS  /api/health on port $port" ;;
    *)
      echo "FAIL  /api/health on port $port did not return status ok" >&2
      rc=1
      ;;
  esac
done
exit $rc
