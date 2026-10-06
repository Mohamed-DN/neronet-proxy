#!/bin/sh
# Usage: COMPOSE_PROJECT_NAME=<stack> restore.sh [--verify] [--repo primary|secondary]
#        [--set latest|SET] [--replace]
# --verify restores to a separate temporary PostgreSQL, checks the snapshot manifest
# and verifies backend key files without changing the live database or data volume.
# A live restore requires stopped backend/backup services; --replace authorizes replacing data.
set -eu
NERONET_REPO_ROOT=${NERONET_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
export NERONET_REPO_ROOT
. "$(dirname "$0")/../dev/engine.sh"

case ${COMPOSE_PROJECT_NAME:-} in
  '' | neronet | *[!a-z0-9_-]*) die "set an explicit safe COMPOSE_PROJECT_NAME; neronet is protected" ;;
esac
export NERONET_BACKUP_IMAGE=${NERONET_BACKUP_IMAGE:-${COMPOSE_PROJECT_NAME}-backup:dev}
cd "$REPO_ROOT"
verify=false
replace=false
repository=primary
set_spec=latest
while [ $# -gt 0 ]; do
  case $1 in
    --verify) verify=true; shift ;;
    --replace) replace=true; shift ;;
    --repo) repository=${2:?--repo needs primary or secondary}; shift 2 ;;
    --set) set_spec=${2:?--set needs a backup set}; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
case $repository in primary | secondary) ;; *) die "invalid repository" ;; esac

tool() {
  # shellcheck disable=SC2086
  $COMPOSE --profile restore run --rm --no-deps "$@"
}
check_service() {
  # shellcheck disable=SC2086
  id=$($COMPOSE --profile restore ps -q "$1")
  [ -n "$id" ] || die "$1 is not running in $COMPOSE_PROJECT_NAME"
  project=$($ENGINE inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$id")
  [ "$project" = "$COMPOSE_PROJECT_NAME" ] || die "container project label differs; refusing restore"
}

# Resolve once: a periodic backup finishing during a restore must not change its set.
set_id=$(tool backup-restore resolve-set "$repository" "$set_spec" | tail -n 1)
case $set_id in [0-9]*T[0-9]*Z) ;; *) die "cannot resolve a complete backup set" ;; esac
if [ "$verify" = true ]; then
  # shellcheck disable=SC2086
  $COMPOSE --profile restore up -d --wait verify-db
  check_service verify-db
  cleanup() {
    # shellcheck disable=SC2086
    $COMPOSE --profile restore rm -sf verify-db >/dev/null
  }
  trap cleanup EXIT INT TERM
  tool -e PGHOST=verify-db backup-restore restore-db --replace --repo "$repository" --set "$set_id"
  tool -e PGHOST=verify-db backup-restore verify-db --repo "$repository" --set "$set_id"
  tool backup-restore verify-volume --repo "$repository" --set "$set_id"
  echo "restore verification passed for set $set_id ($repository); target was temporary"
else
  check_service postgres
  for service in backend backup; do
    # shellcheck disable=SC2086
    [ -z "$($COMPOSE --profile backup ps --status running -q "$service")" ] || die "stop $service before a live restore"
  done
  replacement=
  [ "$replace" = false ] || replacement=--replace
  # shellcheck disable=SC2086
  tool backup-restore restore-db $replacement --repo "$repository" --set "$set_id"
  # shellcheck disable=SC2086
  tool backup-restore restore-volume $replacement --repo "$repository" --set "$set_id"
  tool backup-restore verify-db --repo "$repository" --set "$set_id"
  tool backup-restore verify-volume --repo "$repository" --set "$set_id"
  echo "restored set $set_id ($repository); restart backend and frontend after checking deployment secrets"
fi
