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

# The console is TLS-only and its certificate is checked against the stack's CA, not
# skipped: an unverified request would pass against any certificate at all.
CA="$(HOST_PATH "$REPO_ROOT/certs")/ca.crt"
# Windows' curl (Schannel) also demands a revocation answer, which a development CA
# has no list for. Best effort keeps the chain check and skips only that lookup.
TLS_OPTS="--cacert $CA"
if curl -V 2>/dev/null | grep -qi schannel; then
  TLS_OPTS="$TLS_OPTS --ssl-revoke-best-effort"
fi

check_health() { # label url [curl options]
  label=$1
  url=$2
  shift 2
  body=$(curl -fsS --max-time 10 "$@" "$url" 2>&1) || body=""
  case "$body" in
    *'"status":"ok"'*) echo "PASS  /api/health $label" ;;
    *)
      echo "FAIL  /api/health $label did not return status ok" >&2
      rc=1
      ;;
  esac
}

rc=0
check_health "on the API port $API_PORT" "http://127.0.0.1:$API_PORT/api/health"
# shellcheck disable=SC2086 # TLS_OPTS is a list of options, split on purpose
check_health "through the console over TLS (port $CONSOLE_PORT)" "https://127.0.0.1:$CONSOLE_PORT/api/health" $TLS_OPTS

# Plain HTTP on the console port must be sent to TLS, never answered in the clear.
# The status comes after the body rather than through -o /dev/null, a path Windows'
# curl cannot open with Git Bash's path rewriting off.
code=$(curl -s --max-time 10 -w '\n%{http_code}' "http://127.0.0.1:$CONSOLE_PORT/api/health" | tail -n 1) || code=000
if [ "$code" = "301" ]; then
  echo "PASS  plain HTTP on the console port is redirected to TLS"
else
  echo "FAIL  plain HTTP on the console port answered $code, expected a 301 to https" >&2
  rc=1
fi
exit $rc
