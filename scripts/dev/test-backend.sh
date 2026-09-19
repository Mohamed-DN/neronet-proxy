#!/bin/sh
# Usage: test-backend.sh
#
# Backend suite (`npm ci && npm test`) in node:22 against a private, throw-away Valkey.
# Each run creates its own network and Valkey container, so runs started together do
# not share state. Never point the suite at another stack's Valkey: the tests key their
# data by process id, and ids collide across containers.
#
# The whole repository is mounted because some tests read files outside console/backend
# (.env.example, docker-compose.yml). node_modules sits on an anonymous volume so the
# container's Linux dependencies never land in the checkout. console/data is a tmpfs
# because the tests create SQLite files there; on a shared mount two parallel runs
# open the same files and fail with disk I/O errors.
set -eu
. "$(dirname "$0")/engine.sh"

RUN_ID="tb$$_$(date +%s)"
NET="neronet-test-$RUN_ID"
VK="neronet-valkey-$RUN_ID"

cleanup() {
  $ENGINE rm -f "$VK" >/dev/null 2>&1 || true
  $ENGINE network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

$ENGINE network create "$NET" >/dev/null
$ENGINE run -d --rm --name "$VK" --network "$NET" --network-alias valkey \
  docker.io/valkey/valkey:7.2-alpine >/dev/null

# Wait for Valkey rather than assuming it is ready.
i=0
until $ENGINE exec "$VK" valkey-cli ping 2>/dev/null | grep -q PONG; do
  i=$((i + 1))
  [ "$i" -le 30 ] || die "the throw-away Valkey did not start"
  sleep 1
done

LOG=${TEST_LOG:-${TMPDIR:-/tmp}/neronet-backend-$RUN_ID.log}
rc=0
$ENGINE run --rm --network "$NET" \
  -e VALKEY_URL=redis://valkey:6379 -e VALKEY_HOST=valkey \
  -v "$(HOST_PATH "$REPO_ROOT"):/repo" \
  -v /repo/console/backend/node_modules \
  --tmpfs /repo/console/data \
  -v neronet-npmcache:/root/.npm \
  -w /repo/console/backend docker.io/library/node:22 \
  sh -c 'npm ci --no-audit --no-fund >/dev/null && npm test' >"$LOG" 2>&1 || rc=$?

grep -E '^# (tests|pass|fail|cancelled|skipped)' "$LOG" || true
grep -E '^\s*not ok' "$LOG" | head -20 || true
echo "log: $LOG"
exit $rc
