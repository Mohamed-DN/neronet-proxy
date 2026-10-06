#!/bin/sh
# neronet-backup: the backup service of the compose stack, and the tool
# scripts/ops/restore.sh drives. Installed as /usr/local/bin/neronet-backup.
#
#   run              take a backup now and then every NERONET_BACKUP_INTERVAL (the service)
#   once             take one backup and exit; non-zero when any step failed
#   healthcheck      exit 0 when the last backups are recent enough
#   status           print what the last backup cycle did
#   sets             list the backup sets of a repository
#   restore-db       restore the database of a set
#   restore-volume   restore the backend data directory of a set
#   verify-volume    compare the backend data directory of a set with the live one
#   digest           print row counts and checksums of the database the PG* variables name
#
# A backup set is what one cycle writes: a snapshot of the backend data directory and a
# snapshot of the database dump, both tagged "set:<UTC timestamp>". The dump is written
# last, so a set that has a dump has everything.
#
# Environment: see the "backup" service in docker-compose.yml and the Backup and
# restore section of docs/en/admin-guide.md.
set -eu

PRIMARY=${NERONET_BACKUP_PRIMARY:-/repo}
SECONDARY=${NERONET_BACKUP_SECONDARY:-}
SOURCE=${NERONET_BACKUP_SOURCE:-/source/backend_data}
STATE=${NERONET_BACKUP_STATE:-/tmp/neronet-backup.state}
SHARE=${NERONET_BACKUP_SHARE:-/usr/local/share/neronet-backup}
LOCK=/work/neronet-backup.lock
# A constant, not the container's hostname: restic groups snapshots by host when it
# applies the retention policy, and a hostname that changes with every container would
# turn every recreation into a new group that nothing ever expires.
TAG=neronet
DUMP=neronet-db.dump
MANIFEST=neronet-db.manifest

INTERVAL=${NERONET_BACKUP_INTERVAL:-6h}
RETRY=${NERONET_BACKUP_RETRY:-15m}
KEEP_LAST=${NERONET_BACKUP_KEEP_LAST:-4}
KEEP_DAILY=${NERONET_BACKUP_KEEP_DAILY:-7}
KEEP_WEEKLY=${NERONET_BACKUP_KEEP_WEEKLY:-4}
KEEP_MONTHLY=${NERONET_BACKUP_KEEP_MONTHLY:-6}
SECONDARY_PRUNE=${NERONET_BACKUP_SECONDARY_PRUNE:-true}
CHECK_SUBSET=${NERONET_BACKUP_CHECK_SUBSET:-5%}
PGDUMP_COMPRESS=${NERONET_BACKUP_PGDUMP_COMPRESS:-0}

# Compose passes every variable it lists; an empty cloud credential is "not set", and
# some restic backends treat the two differently.
for _v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_DEFAULT_REGION \
  B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REST_USERNAME RESTIC_REST_PASSWORD RESTIC_SECONDARY_PASSWORD; do
  eval "_val=\${$_v:-}"
  [ -n "$_val" ] || unset "$_v"
done
unset _v _val

log() { printf '%s %-5s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" "$2"; }
info() { log INFO "$*"; }
warn() { log WARN "$*"; }
err() { log ERROR "$*"; }
die() {
  err "$*"
  exit 1
}

# 6h, 30m, 90s, 2d or a plain number of seconds.
to_seconds() {
  case $1 in
    '' | *[!0-9dhms]*) return 1 ;;
  esac
  _n=${1%[dhms]}
  case $_n in
    '' | *[!0-9]*) return 1 ;;
  esac
  case $1 in
    *d) echo $((_n * 86400)) ;;
    *h) echo $((_n * 3600)) ;;
    *m) echo $((_n * 60)) ;;
    *) echo "$_n" ;;
  esac
}

require_number() { # name value
  case $2 in
    '' | *[!0-9]*) die "$1 must be a whole number, got '$2'" ;;
  esac
}

require_password() {
  [ -n "${RESTIC_PASSWORD:-}" ] ||
    die "RESTIC_PASSWORD is empty. The repositories are encrypted with it: set it in .env (scripts/dev/gen-env.sh writes one) and keep a copy outside this host, because without it no backup can be read"
}

require_project() {
  case ${NERONET_BACKUP_PROJECT:-} in
    '' | neronet | *[!a-z0-9_-]*) die "restore requires an explicit safe COMPOSE_PROJECT_NAME; the owner stack neronet is protected" ;;
  esac
}

# --- repositories -------------------------------------------------------------

# env, not VAR=value before the call: whether an assignment in front of a shell
# function outlives the call is not specified by POSIX.
primary() { env RESTIC_REPOSITORY="$PRIMARY" restic "$@"; }
secondary() {
  env RESTIC_REPOSITORY="$SECONDARY" \
    RESTIC_PASSWORD="${RESTIC_SECONDARY_PASSWORD:-$RESTIC_PASSWORD}" \
    RESTIC_FROM_REPOSITORY="$PRIMARY" RESTIC_FROM_PASSWORD="$RESTIC_PASSWORD" \
    restic "$@"
}
repo() { # primary|secondary <restic arguments>
  _which=$1
  shift
  case $_which in
    primary) primary "$@" ;;
    secondary)
      [ -n "$SECONDARY" ] || die "NERONET_BACKUP_SECONDARY is not set: there is no secondary repository"
      secondary "$@"
      ;;
    *) die "unknown repository '$_which' (primary or secondary)" ;;
  esac
}

# Initialise a repository that does not exist. Only that: a repository that cannot be
# opened for another reason (wrong password, unreachable) is an error to report, not a
# blank to overwrite.
ensure_repo() { # primary|secondary
  if _out=$(repo "$1" cat config 2>&1); then
    return 0
  fi
  case $_out in
    *"Is there a repository at the following location"*)
      info "the $1 repository does not exist yet, creating it"
      if [ "$1" = secondary ]; then
        # The same chunker parameters as the primary, so that a copy deduplicates
        # against what the secondary already holds.
        repo secondary init --copy-chunker-params
      else
        repo primary init
      fi
      ;;
    *)
      err "cannot open the $1 repository: $_out"
      return 1
      ;;
  esac
}

# Run a command, log what it printed, keep its exit status.
step() { # label command...
  _label=$1
  shift
  _rc=0
  _out=$("$@" 2>&1) || _rc=$?
  if [ "$_rc" -eq 0 ]; then
    info "$_label: ok"
  else
    err "$_label: FAILED (exit $_rc)"
  fi
  if [ -n "$_out" ]; then
    printf '%s\n' "$_out" | sed 's/^/        | /'
  fi
  return "$_rc"
}

# --- state, for the health check and for `status` ------------------------------

state_get() { sed -n "s/^$1=//p" "$STATE" 2>/dev/null | tail -n 1; }
state_put() { # key value
  { grep -v "^$1=" "$STATE" 2>/dev/null || true; } >"$STATE.new"
  printf '%s=%s\n' "$1" "$2" >>"$STATE.new"
  mv "$STATE.new" "$STATE"
}

# --- a backup cycle -----------------------------------------------------------

backup_volume() {
  [ -d "$SOURCE" ] || {
    err "the backend data directory $SOURCE is not mounted"
    return 1
  }
  if [ -z "$(ls -A "$SOURCE" 2>/dev/null)" ]; then
    warn "$SOURCE is empty: the backend has not written its keys yet, or this is not its volume"
  fi
  primary backup --host "$TAG" --tag "$TAG" --tag volume --tag "set:$SET" "$SOURCE"
}

backup_database() {
  # Compute the manifest from this dump, not from a source that keeps changing.
  # A private local PostgreSQL also proves the dump can actually be restored.
  (
    set -e
    work=$(mktemp -d /work/backup.XXXXXX)
    trap 'pg_ctl -D "$work/pg" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"' EXIT INT TERM
    pg_dump --format=custom --compress="$PGDUMP_COMPRESS" --no-owner --no-acl --file="$work/$DUMP"
    initdb -D "$work/pg" --auth=trust --no-locale -E UTF8 >/dev/null
    pg_ctl -D "$work/pg" -l "$work/pg.log" -o "-k $work -p 5544 -c listen_addresses=''" -w start >/dev/null
    env PGHOST="$work" PGPORT=5544 PGDATABASE=postgres pg_restore \
      --no-owner --no-acl --exit-on-error --single-transaction --dbname=postgres "$work/$DUMP"
    env PGHOST="$work" PGPORT=5544 PGDATABASE=postgres psql -X -q -v ON_ERROR_STOP=1 \
      -f "$SHARE/digest-all.sql" >"$work/$MANIFEST"
    pg_ctl -D "$work/pg" -m fast -w stop >/dev/null
    primary backup --host "$TAG" --tag "$TAG" --tag db --tag "set:$SET" \
      --stdin-from-command --stdin-filename "$DUMP" -- cat "$work/$DUMP"
    primary backup --host "$TAG" --tag "$TAG" --tag manifest --tag "set:$SET" \
      --stdin-from-command --stdin-filename "$MANIFEST" -- cat "$work/$MANIFEST"
  )
}

# Read the dump back and list it. A snapshot that cannot be restored is worse than no
# snapshot, because it is believed.
check_dump() {
  _id=$(snapshot_of primary "$SET" db) || return 1
  _fifo=$(mktemp -u /tmp/dump.XXXXXX)
  mkfifo "$_fifo"
  primary dump "$_id" "/$DUMP" >"$_fifo" &
  _pid=$!
  _rc=0
  _toc=$(pg_restore --list <"$_fifo") || _rc=$?
  wait "$_pid" || _rc=$?
  rm -f "$_fifo"
  [ "$_rc" -eq 0 ] || {
    err "the dump in snapshot $_id cannot be read back"
    return 1
  }
  printf '%s\n' "$_toc" | grep -Eq 'TABLE public nodes( |$)' || {
    err "the dump in snapshot $_id has no table 'nodes': this is not a NeroNet database, or it has not been migrated yet"
    return 1
  }
  _entries=$(printf '%s\n' "$_toc" | grep -vc '^;' || true)
  echo "dump snapshot $_id lists $_entries objects, including public.nodes"
}

retention() { # primary|secondary
  if [ "$KEEP_LAST" -eq 0 ] && [ "$KEEP_DAILY" -eq 0 ] && [ "$KEEP_WEEKLY" -eq 0 ] && [ "$KEEP_MONTHLY" -eq 0 ]; then
    warn "no retention is configured (NERONET_BACKUP_KEEP_*): the $1 repository grows without limit"
    return 0
  fi
  repo "$1" forget --prune --tag "$TAG" --group-by host,paths \
    --keep-last "$KEEP_LAST" --keep-daily "$KEEP_DAILY" \
    --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY"
}

copy_to_secondary() {
  repo secondary copy --host "$TAG" --tag "$TAG"
}

secondary_has_set() {
  _n=$(secondary snapshots --tag "$TAG,set:$SET" --json | jq 'length') || return 1
  [ "$_n" -ge 3 ] || {
    echo "the secondary repository holds $_n of the 3 snapshots of set $SET"
    return 1
  }
  for _kind in volume db manifest; do
    snapshot_of secondary "$SET" "$_kind" >/dev/null || return 1
  done
}

distinct_repositories() {
  _primary_id=$(primary cat config | jq -r .id) || return 1
  _secondary_id=$(secondary cat config | jq -r .id) || return 1
  [ "$_primary_id" != "$_secondary_id" ] || {
    err "primary and secondary refer to the same repository; this is not a second copy"
    return 1
  }
}

# One cycle. Prints what it did; exits non-zero when any step failed.
cycle() {
  SET=$(date -u +%Y%m%dT%H%M%SZ)
  _failed=0
  state_put last_attempt_epoch "$(date +%s)"
  info "backup cycle $SET starting"

  if ensure_repo primary &&
    step "backend data snapshot" backup_volume &&
    step "database dump snapshot" backup_database &&
    step "dump read back" check_dump; then
    state_put primary_ok_epoch "$(date +%s)"
    state_put last_set "$SET"
  else
    _failed=1
  fi

  # Retention and integrity checks run whether or not this cycle's backup succeeded:
  # they are about what is already in the repository.
  if [ "$_failed" -eq 0 ]; then
    step "retention (primary)" retention primary || _failed=1
    step "repository check (primary)" primary check --read-data-subset="$CHECK_SUBSET" || _failed=1
  fi

  if [ -z "$SECONDARY" ]; then
    state_put secondary none
    warn "################################################################"
    warn "NERONET_BACKUP_SECONDARY is not set. These backups exist only on"
    warn "this host: a lost disk, a stolen machine or ransomware that reaches"
    warn "this volume takes them too. Set it to another disk, a NAS, sftp or"
    warn "an S3 bucket (any restic repository URL) to keep a copy elsewhere."
    warn "################################################################"
  else
    if ensure_repo secondary && distinct_repositories &&
      step "copy to the secondary repository" copy_to_secondary &&
      step "set $SET present in the secondary" secondary_has_set; then
      state_put secondary ok
      state_put secondary_ok_epoch "$(date +%s)"
      if [ "$SECONDARY_PRUNE" = true ]; then
        step "retention (secondary)" retention secondary || _failed=1
      else
        info "retention of the secondary repository is off (NERONET_BACKUP_SECONDARY_PRUNE=$SECONDARY_PRUNE)"
      fi
      step "repository check (secondary)" secondary check || _failed=1
    else
      state_put secondary failed
      _failed=1
    fi
  fi

  if [ "$_failed" -eq 0 ]; then
    state_put last_result ok
    if [ -n "$SECONDARY" ]; then
      info "backup cycle $SET finished: database and backend data are in the primary and the secondary repository"
    else
      warn "backup cycle $SET finished: database and backend data are in the primary repository ONLY"
    fi
  else
    state_put last_result failed
    err "backup cycle $SET FAILED, see the lines above"
  fi
  return "$_failed"
}

with_lock() { # a manual `once` and the service never run a cycle at the same time
  (
    flock -x 9 || exit 1
    "$@"
  ) 9>"$LOCK"
}

# --- commands -----------------------------------------------------------------

cmd_run() {
  require_password
  _interval=$(to_seconds "$INTERVAL") || die "NERONET_BACKUP_INTERVAL must look like 6h, 30m, 90s or 2d, got '$INTERVAL'"
  _retry=$(to_seconds "$RETRY") || die "NERONET_BACKUP_RETRY must look like 15m, got '$RETRY'"
  [ "$_interval" -ge 30 ] || die "NERONET_BACKUP_INTERVAL is $_interval s; the minimum is 30 s"
  require_number NERONET_BACKUP_KEEP_LAST "$KEEP_LAST"
  require_number NERONET_BACKUP_KEEP_DAILY "$KEEP_DAILY"
  require_number NERONET_BACKUP_KEEP_WEEKLY "$KEEP_WEEKLY"
  require_number NERONET_BACKUP_KEEP_MONTHLY "$KEEP_MONTHLY"

  info "backup service starting: every ${INTERVAL}, primary repository $PRIMARY"
  info "retention: last $KEEP_LAST, daily $KEEP_DAILY, weekly $KEEP_WEEKLY, monthly $KEEP_MONTHLY"
  if [ -z "$SECONDARY" ]; then
    warn "NERONET_BACKUP_SECONDARY is not set: backups will exist on this host only"
  else
    info "secondary repository configured"
  fi

  trap 'info "stopping"; exit 0' TERM INT
  while :; do
    if with_lock cycle; then
      _wait=$_interval
    else
      _wait=$_retry
      [ "$_wait" -le "$_interval" ] || _wait=$_interval
      err "next attempt in $_wait s"
    fi
    sleep "$_wait" &
    wait $! || true
  done
}

cmd_once() {
  require_password
  require_number NERONET_BACKUP_KEEP_LAST "$KEEP_LAST"
  require_number NERONET_BACKUP_KEEP_DAILY "$KEEP_DAILY"
  require_number NERONET_BACKUP_KEEP_WEEKLY "$KEEP_WEEKLY"
  require_number NERONET_BACKUP_KEEP_MONTHLY "$KEEP_MONTHLY"
  with_lock cycle
}

cmd_healthcheck() {
  [ "$(state_get last_result)" = ok ] || {
    echo "the latest backup cycle did not complete successfully"
    exit 1
  }
  _interval=$(to_seconds "$INTERVAL") || _interval=21600
  _max=$((_interval * 2 + 900))
  _now=$(date +%s)
  _ok=$(state_get primary_ok_epoch)
  if [ -z "$_ok" ]; then
    echo "no backup has completed yet"
    exit 1
  fi
  if [ $((_now - _ok)) -gt "$_max" ]; then
    echo "the last backup completed $((_now - _ok)) s ago, more than $_max s"
    exit 1
  fi
  if [ -n "$SECONDARY" ]; then
    _sok=$(state_get secondary_ok_epoch)
    if [ -z "$_sok" ] || [ $((_now - _sok)) -gt "$_max" ]; then
      echo "the last copy to the secondary repository is missing or older than $_max s"
      exit 1
    fi
  fi
  echo "ok"
}

cmd_status() {
  [ -f "$STATE" ] || {
    echo "no backup cycle has run yet"
    return 0
  }
  _now=$(date +%s)
  _ok=$(state_get primary_ok_epoch)
  echo "last result:      $(state_get last_result)"
  if [ -n "$_ok" ]; then
    echo "last good backup: set $(state_get last_set), $(((_now - _ok) / 60)) min ago"
  else
    echo "last good backup: none"
  fi
  case $(state_get secondary) in
    ok) echo "secondary copy:   ok, $(((_now - $(state_get secondary_ok_epoch)) / 60)) min ago" ;;
    none) echo "secondary copy:   NOT CONFIGURED, the backups exist on this host only" ;;
    failed) echo "secondary copy:   FAILED" ;;
    *) echo "secondary copy:   unknown" ;;
  esac
}

# --- choosing a set --------------------------------------------------------------

# The set tag of a snapshot object from restic's JSON
SET_TAG_JQ='(.tags // [] | map(select(startswith("set:"))) | .[0] // "") | ltrimstr("set:")'

# resolve_set <repo> <latest | set id | snapshot id>  ->  the set id
resolve_set() {
  _spec=$1
  _spec_repo=$2
  case $_spec in
    latest)
      _set=$(repo "$_spec_repo" snapshots --tag "$TAG,manifest" --json | jq -r "sort_by(.time) | last | $SET_TAG_JQ") || return 1
      [ -n "$_set" ] || {
        err "the $_spec_repo repository has no backup set yet"
        return 1
      }
      ;;
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z)
      _set=$_spec
      ;;
    *)
      _set=$(repo "$_spec_repo" snapshots --json "$_spec" | jq -r ".[0] | $SET_TAG_JQ") || return 1
      [ -n "$_set" ] || {
        err "snapshot $_spec is not part of a backup set"
        return 1
      }
      ;;
  esac
  snapshot_of "$_spec_repo" "$_set" db >/dev/null || return 1
  snapshot_of "$_spec_repo" "$_set" volume >/dev/null || return 1
  snapshot_of "$_spec_repo" "$_set" manifest >/dev/null || return 1
  echo "$_set"
}

# snapshot_of <repo> <set> <db | volume>  ->  the restic snapshot id
snapshot_of() {
  _id=$(repo "$1" snapshots --tag "$TAG,$3,set:$2" --json | jq -r 'sort_by(.time) | last | .id // empty') || return 1
  [ -n "$_id" ] || {
    err "the $1 repository has no $3 snapshot in set $2"
    return 1
  }
  echo "$_id"
}

# Options shared by the restore commands.
parse_restore_args() {
  OPT_REPO=primary
  OPT_SET=latest
  OPT_REPLACE=false
  OPT_DATABASE=${PGDATABASE:-neronet_db}
  while [ $# -gt 0 ]; do
    case $1 in
      --repo) OPT_REPO=${2:?--repo needs primary or secondary}; shift 2 ;;
      --set) OPT_SET=${2:?--set needs a set id, a snapshot id or latest}; shift 2 ;;
      --replace) OPT_REPLACE=true; shift ;;
      --database) OPT_DATABASE=${2:?--database needs a name}; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  OPT_SET=$(resolve_set "$OPT_SET" "$OPT_REPO") || exit 1
}

cmd_sets() {
  require_password
  _which=${1:-primary}
  _prog=$(
    cat <<EOF
map({set: ($SET_TAG_JQ), kind: (if (.tags | index("db")) then "db" else "volume" end), id: .short_id, time: .time})
| map(select(.set != "")) | group_by(.set)
| map({set: .[0].set, time: (map(.time) | max),
       db: ([.[] | select(.kind == "db") | .id] | first // "-"),
       volume: ([.[] | select(.kind == "volume") | .id] | first // "-")})
| sort_by(.set) | reverse
| ["SET", "TIME (UTC)", "DB SNAPSHOT", "VOLUME SNAPSHOT"], (.[] | [.set, (.time | .[0:19] | sub("T"; " ")), .db, .volume])
| @tsv
EOF
  )
  repo "$_which" snapshots --tag "$TAG" --json | jq -r "$_prog" | sed 's/\t/   /g'
}

psql_admin() { psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }

cmd_restore_db() {
  require_password
  require_project
  parse_restore_args "$@"
  _db=$OPT_DATABASE
  case $_db in
    '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*) die "'$_db' is not a plain database name" ;;
  esac
  _snap=$(snapshot_of "$OPT_REPO" "$OPT_SET" db) || exit 1
  info "restoring set $OPT_SET (snapshot $_snap, $OPT_REPO repository) into database $_db on ${PGHOST:-localhost}"

  _exists=$(psql_admin -tA -c "SELECT 1 FROM pg_database WHERE datname = '$_db'")
  if [ "$_exists" = 1 ]; then
    _tables=$(psql -X -q -tA -v ON_ERROR_STOP=1 -d "$_db" \
      -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")
    if [ "$_tables" -gt 0 ]; then
      [ "$OPT_REPLACE" = true ] ||
        die "database $_db already holds $_tables tables. A restore into it would destroy them: stop what uses it and pass --replace if that is what you want"
      warn "dropping database $_db ($_tables tables) as requested by --replace"
    fi
    psql_admin -c "DROP DATABASE \"$_db\" WITH (FORCE)"
    psql_admin -c "CREATE DATABASE \"$_db\""
  else
    psql_admin -c "CREATE DATABASE \"$_db\""
  fi

  # A fifo and two exit statuses, not a pipe: with a pipe only pg_restore's status
  # survives, and a restic that failed half way would look like a short dump.
  _fifo=$(mktemp -u /tmp/dump.XXXXXX)
  mkfifo "$_fifo"
  repo "$OPT_REPO" dump "$_snap" "/$DUMP" >"$_fifo" &
  _pid=$!
  _rc=0
  pg_restore --no-owner --no-acl --exit-on-error --single-transaction --dbname "$_db" <"$_fifo" || _rc=$?
  wait "$_pid" || _rc=$?
  rm -f "$_fifo"
  [ "$_rc" -eq 0 ] || die "the restore into $_db failed (exit $_rc); the database is left as it was before pg_restore started, empty"
  info "database $_db restored from set $OPT_SET"
}

cmd_restore_volume() {
  require_password
  require_project
  parse_restore_args "$@"
  _snap=$(snapshot_of "$OPT_REPO" "$OPT_SET" volume) || exit 1
  [ -d "$SOURCE" ] || die "$SOURCE is not mounted"
  if [ -n "$(ls -A "$SOURCE" 2>/dev/null)" ]; then
    [ "$OPT_REPLACE" = true ] ||
      die "$SOURCE is not empty. A restore into it replaces its files: pass --replace if that is what you want"
    warn "emptying $SOURCE as requested by --replace"
    find "$SOURCE" -mindepth 1 -delete
  fi
  info "restoring the backend data of set $OPT_SET (snapshot $_snap) into $SOURCE"
  # snapshot:path restores the contents of that directory, not its parents.
  repo "$OPT_REPO" restore --verify "$_snap:$SOURCE" --target "$SOURCE"
  info "backend data restored from set $OPT_SET"
}

cmd_verify_volume() {
  require_password
  parse_restore_args "$@"
  _snap=$(snapshot_of "$OPT_REPO" "$OPT_SET" volume) || exit 1
  _tmp=$(mktemp -d /tmp/verify-volume.XXXXXX)
  repo "$OPT_REPO" restore --verify "$_snap:$SOURCE" --target "$_tmp" >/dev/null
  if diff -r "$_tmp" "$SOURCE" >/dev/null 2>&1; then
    echo "identical"
    _rc=0
  else
    echo "DIFFERENT"
    _rc=1
  fi
  rm -rf "$_tmp"
  return "$_rc"
}

cmd_verify_db() {
  require_password
  parse_restore_args "$@"
  _snap=$(snapshot_of "$OPT_REPO" "$OPT_SET" manifest) || exit 1
  _tmp=$(mktemp -d /tmp/verify-db.XXXXXX)
  repo "$OPT_REPO" dump "$_snap" "/$MANIFEST" >"$_tmp/expected"
  psql -X -q -v ON_ERROR_STOP=1 -f "$SHARE/digest-all.sql" >"$_tmp/actual"
  _rc=0
  if ! cmp -s "$_tmp/expected" "$_tmp/actual"; then
    err "restored schema or data differ from the backup manifest"
    _rc=1
  else
    info "restored schema, all public tables and sequences match the backup manifest"
    sha256sum "$_tmp/actual" | cut -d ' ' -f 1
  fi
  rm -rf "$_tmp"
  return "$_rc"
}

cmd_digest() {
  _scope=key
  _upto=-1
  while [ $# -gt 0 ]; do
    case $1 in
      --scope) _scope=${2:?--scope needs key or all}; shift 2 ;;
      --audit-upto) _upto=${2:?--audit-upto needs a sequence number}; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  case $_scope in key | all) ;; *) die "--scope is key or all" ;; esac
  require_number --audit-upto "${_upto#-}"
  psql -X -q -v ON_ERROR_STOP=1 -v "audit_upto=$_upto" -f "$SHARE/digest-$_scope.sql"
}

cmd=${1:-run}
[ $# -gt 0 ] && shift
case $cmd in
  run) cmd_run ;;
  once) cmd_once ;;
  healthcheck) cmd_healthcheck ;;
  status) cmd_status ;;
  sets) cmd_sets "$@" ;;
  resolve-set) require_password; resolve_set "${2:-latest}" "${1:-primary}" ;;
  restore-db) cmd_restore_db "$@" ;;
  restore-volume) cmd_restore_volume "$@" ;;
  verify-volume) cmd_verify_volume "$@" ;;
  verify-db) cmd_verify_db "$@" ;;
  digest) cmd_digest "$@" ;;
  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
