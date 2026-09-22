#!/bin/sh
# ==============================================================================
# Sovereign Mesh v4.0 - Automated Disaster Recovery Backup & Proof Verifier
# Usage: dr_backup_recovery_proof.sh <source_database_url>
# ==============================================================================
set -eu

SOURCE_URL="${1:-${DATABASE_URL:-postgresql://neronet:neronet_dev_password@127.0.0.1:5432/neronet_test}}"
ENGINE=podman
command -v podman >/dev/null 2>&1 || ENGINE=docker

ID="dr_proof_$(date +%s)"
RESTORE_PG="dr_restore_pg_$ID"
NET="dr_net_$ID"

echo "== [1/5] Creating isolated network for DR verification container..."
$ENGINE network create --disable-dns "$NET" >/dev/null 2>&1 || $ENGINE network create "$NET" >/dev/null

echo "== [2/5] Spawning clean ephemeral PostgreSQL 18 container..."
$ENGINE run -d --rm --name "$RESTORE_PG" --network "$NET" \
  -e POSTGRES_USER=neronet -e POSTGRES_PASSWORD=neronet_dev_password -e POSTGRES_DB=neronet_restore \
  docker.io/library/postgres:18-alpine >/dev/null

cleanup() {
  echo "== Cleaning up ephemeral DR verification container and network..."
  $ENGINE rm -f "$RESTORE_PG" >/dev/null 2>&1 || true
  $ENGINE network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Wait for PostgreSQL to be ready
i=0
until $ENGINE exec "$RESTORE_PG" pg_isready -U neronet -d neronet_restore >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -le 30 ] || { echo "ERROR: Ephemeral Postgres restore container failed to start" >&2; exit 1; }
  sleep 1
done

RESTORE_IP=$($ENGINE inspect "$RESTORE_PG" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
RESTORE_URL="postgresql://neronet:neronet_dev_password@$RESTORE_IP:5432/neronet_restore"

echo "== [3/5] Exporting source database dump..."
DUMP_FILE="/tmp/neronet_dr_dump_$ID.sql"

# Dump using pg_dump via the container or node
$ENGINE run --rm --network "$NET" \
  docker.io/library/postgres:18-alpine \
  pg_dump "$SOURCE_URL" --no-owner --no-acl --clean --if-exists > "$DUMP_FILE"

echo "== [4/5] Restoring database dump into clean ephemeral container..."
cat "$DUMP_FILE" | $ENGINE exec -i "$RESTORE_PG" psql -U neronet -d neronet_restore >/dev/null
rm -f "$DUMP_FILE"

echo "== [5/5] Executing mathematical HMAC chain verification and row count proof..."
$ENGINE run --rm --network "$NET" \
  -e DATABASE_URL="$SOURCE_URL" \
  -e RESTORE_DATABASE_URL="$RESTORE_URL" \
  -v "$(pwd)/console/backend:/repo/console/backend" -w /repo/console/backend \
  docker.io/library/node:22 \
  node scripts/dr-prover.js

echo "== [✓] Automated Disaster Recovery Proof verified with 100% integrity!"
