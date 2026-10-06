#!/bin/sh
# Run after stack.sh backup built the project's backup image. No stack data is mounted.
set -eu
. "$(dirname "$0")/engine.sh"
image=${NERONET_BACKUP_IMAGE:-${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME}-backup:dev}
$ENGINE run --rm --network none --entrypoint sh \
  -v "$(HOST_PATH "$REPO_ROOT/docker/backup"):/tests:ro" \
  "$image" /tests/test-manifest.sh
