#!/bin/sh
# Usage: COMPOSE_PROJECT_NAME=neronet-backup-<test> NERONET_PORT_OFFSET=<nonzero>
#        NERONET_NODE_SERVICES='relay-de client-it' backup-drill.sh --destroy-test-data [--secondary-test]
# Destroys only this test project's neronet_db and backend_data, after taking a backup.
# Nodes stay running; their identities and credentials must resume without re-enrolment.
set -eu
NERONET_REPO_ROOT=${NERONET_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
export NERONET_REPO_ROOT
. "$(dirname "$0")/../dev/engine.sh"
case ${COMPOSE_PROJECT_NAME:-} in
  neronet-backup-*) ;;
  *) die "drill requires an explicit disposable project named neronet-backup-<test>" ;;
esac
case $COMPOSE_PROJECT_NAME in *[!a-z0-9_-]*) die "invalid project name" ;; esac
case ${NERONET_PORT_OFFSET:-0} in 0 | '' | *[!0-9]*) die "drill requires a nonzero numeric port offset" ;; esac
[ "${1:-}" = --destroy-test-data ] || die "pass --destroy-test-data to authorize destruction of this test project's data"
shift
secondary=false
if [ "${1:-}" = --secondary-test ]; then secondary=true; shift; fi
[ $# -eq 0 ] || die "unknown drill option"
export NERONET_BACKUP_IMAGE=${NERONET_BACKUP_IMAGE:-${COMPOSE_PROJECT_NAME}-backup:dev}
export NERONET_NODE_SERVICES=${NERONET_NODE_SERVICES:-relay-de client-it}
cd "$REPO_ROOT"
node_count=0
for service in $NERONET_NODE_SERVICES; do
  case $service in *[!a-z0-9_-]* | '') die "drill accepts compose node services only" ;; esac
  node_count=$((node_count + 1))
done
[ "$node_count" -ge 2 ] || die "at least two real nodes are required"

checked_id() {
  # shellcheck disable=SC2086
  id=$($COMPOSE --profile nodes ps -q "$1")
  [ -n "$id" ] || die "$1 is not running"
  project=$($ENGINE inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$id")
  [ "$project" = "$COMPOSE_PROJECT_NAME" ] || die "$1 belongs to another project"
  echo "$id"
}
postgres_id=$(checked_id postgres)
backend_id=$(checked_id backend)
mounts=$($ENGINE inspect --format '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' "$backend_id")
case $mounts in *"${COMPOSE_PROJECT_NAME}_backend_data:/app/data"*) ;;
  *) die "backend does not mount the exact test backend_data volume" ;;
esac
for service in $NERONET_NODE_SERVICES; do checked_id "$service" >/dev/null; done
echo "checked project $COMPOSE_PROJECT_NAME, database neronet_db, volume ${COMPOSE_PROJECT_NAME}_backend_data"

reenrol_count() {
  for service in $NERONET_NODE_SERVICES; do
    # shellcheck disable=SC2086
    $COMPOSE --profile nodes logs --no-color "$service"
  done | awk '/Re-enrolled after the control plane lost this node/ { n++ } END { print n+0 }'
}
tool() {
  # shellcheck disable=SC2086
  $COMPOSE --profile restore run --rm --no-deps "$@"
}
digest_hash() {
  manifest=$1
  # Preserve the database tool's failure; a pipeline would hash partial output.
  if ! tool backup-restore digest --scope all >"$manifest"; then
    rm -f "$manifest"
    return 1
  fi
  sha256sum "$manifest" | cut -d ' ' -f 1
}
constraint_manifest() {
  # Keep constraint expressions in a private temporary file, but report only
  # relation.constraint labels if they change across the restore.
  tool --entrypoint psql backup-restore -X -q -A -t -F "$(printf '\t')" -v ON_ERROR_STOP=1 \
    -c "SELECT r.relname || '.' || c.conname, c.contype::text, c.convalidated::text, pg_get_constraintdef(c.oid, true) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' ORDER BY 1" >"$1"
}
echo "before restore: TCP overlay matrix"
sh scripts/dev/scenarios/overlay.sh matrix
# shellcheck disable=SC2086
$COMPOSE exec -T -e BACKUP_FIXTURE_MODE=seed backend node < scripts/ops/backup-fixture.cjs
baseline_reenrol=$(reenrol_count)
# Stop writers before the exact source digest and backup. Node processes keep their state.
# shellcheck disable=SC2086
$COMPOSE --profile backup stop backend backup
if [ "$secondary" = true ]; then
  export NERONET_BACKUP_SECONDARY=rest:http://backup-test-rest:8000/neronet/
  # shellcheck disable=SC2086
  $COMPOSE -f docker-compose.yml -f docker/backup/docker-compose.test.yml up -d backup-test-rest
  echo "secondary test: controlled REST backend on this host; not offsite"
fi
before_manifest=$(mktemp)
before=$(digest_hash "$before_manifest")
before_constraints=$(mktemp)
constraint_manifest "$before_constraints"
tool backup-restore once
set_id=$(tool backup-restore resolve-set primary latest | tail -n 1)
echo "backup set $set_id; source manifest SHA-256 $before; re-enrolment baseline $baseline_reenrol"
sh scripts/ops/restore.sh --verify --set "$set_id"
if [ "$secondary" = true ]; then
  sh scripts/ops/restore.sh --verify --repo secondary --set "$set_id"
fi

# Recheck the exact container and project immediately before the irreversible SQL.
[ "$(checked_id postgres)" = "$postgres_id" ] || die "PostgreSQL container changed during backup"
echo "destroying only $COMPOSE_PROJECT_NAME neronet_db and ${COMPOSE_PROJECT_NAME}_backend_data"
# shellcheck disable=SC2086
$COMPOSE exec -T postgres psql -X -U neronet -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE neronet_db WITH (FORCE)'
tool --entrypoint sh backup-restore -c 'find /source/backend_data -mindepth 1 -delete'
repo=primary
[ "$secondary" = false ] || repo=secondary
sh scripts/ops/restore.sh --replace --repo "$repo" --set "$set_id"
after_manifest=$(mktemp)
after=$(digest_hash "$after_manifest")
after_constraints=$(mktemp)
constraint_manifest "$after_constraints"
if [ "$before" != "$after" ]; then
  echo "source/restored digest differs ($before != $after); differing schema/data objects:"
  awk -F '\t' '
    NR == FNR { source[$1] = $0; next }
    { restored[$1] = $0 }
    END {
      for (key in source) if (!(key in restored) || source[key] != restored[key]) print key
      for (key in restored) if (!(key in source)) print key
    }
  ' "$before_manifest" "$after_manifest" | sort -u
  echo "differing constraints:"
  awk -F '\t' '
    NR == FNR { source[$1] = $0; next }
    { restored[$1] = $0 }
    END {
      for (key in source) {
        if (!(key in restored)) { print key " [missing after restore]"; continue }
        split(source[key], a, FS); split(restored[key], b, FS)
        detail = ""
        if (a[2] != b[2]) detail = detail " type"
        if (a[3] != b[3]) detail = detail " validation-state"
        if (a[4] != b[4]) detail = detail " definition"
        if (detail != "") print key " differs in" detail
      }
      for (key in restored) if (!(key in source)) print key
    }
  ' "$before_constraints" "$after_constraints" | sort -u
  rm -f "$before_manifest" "$after_manifest" "$before_constraints" "$after_constraints"
  die "full source/restored schema and data digest differs"
fi
rm -f "$before_manifest" "$after_manifest" "$before_constraints" "$after_constraints"
echo "source/restored canonical SHA-256 identical: $after"
# shellcheck disable=SC2086
$COMPOSE start backend
# nginx resolves backend IP at start. Restart after the stopped backend is started.
# shellcheck disable=SC2086
$COMPOSE restart frontend
sh scripts/dev/smoke.sh "$node_count" 180
# shellcheck disable=SC2086
$COMPOSE exec -T backend node < scripts/ops/backup-fixture.cjs

deadline=$(($(date +%s) + 180))
until sh scripts/dev/scenarios/overlay.sh matrix; do
  [ "$(date +%s)" -lt "$deadline" ] || die "TCP did not resume within 180 s"
  sleep 2
done
after_reenrol=$(reenrol_count)
[ "$baseline_reenrol" = "$after_reenrol" ] || die "nodes re-enrolled during the drill"
echo "backup drill passed: canonical schema/data, sealed secret, audit keys, TCP and zero new re-enrolments ($after_reenrol)"
