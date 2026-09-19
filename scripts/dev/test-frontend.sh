#!/bin/sh
# Usage: test-frontend.sh
#
# `npm ci`, production build and unit tests of console/frontend in node:22.
# Exit status is non-zero if any step failed.
set -eu
. "$(dirname "$0")/engine.sh"

exec $ENGINE run --rm \
  -v "$(HOST_PATH "$REPO_ROOT"):/repo" \
  -v /repo/console/frontend/node_modules \
  -v neronet-npmcache:/root/.npm \
  -w /repo/console/frontend docker.io/library/node:22 sh -c '
    set -e
    npm ci --no-audit --no-fund >/dev/null
    npm run build
    npm test'
