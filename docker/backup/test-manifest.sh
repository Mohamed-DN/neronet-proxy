#!/bin/sh
# Real PostgreSQL checks for the manifest used by backup and restore verification.
set -eu
work=$(mktemp -d /work/manifest-test.XXXXXX)
cleanup() {
  pg_ctl -D "$work/pg" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
initdb -D "$work/pg" --auth=trust --no-locale -E UTF8 >/dev/null
pg_ctl -D "$work/pg" -l "$work/pg.log" -o "-k $work -p 5545 -c listen_addresses=''" -w start >/dev/null
export PGHOST="$work" PGPORT=5545 PGDATABASE=postgres PGUSER=neronet
sql() { psql -X -q -v ON_ERROR_STOP=1 -c "$1" >/dev/null; }
digest() {
  psql -X -q -v ON_ERROR_STOP=1 -f /tests/digest-all.sql >"$work/digest" || return
  sha256sum "$work/digest" | cut -d ' ' -f 1
}
fixture() {
  sql "DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    CREATE TYPE manifest_status AS ENUM ('ready', 'stale');
    CREATE SEQUENCE manifest_seq; SELECT nextval('manifest_seq');
    CREATE TABLE manifest_rows (id integer PRIMARY KEY, payload jsonb, status manifest_status DEFAULT 'ready');
    INSERT INTO manifest_rows VALUES (1, '{\"value\":1}', 'ready'), (2, '{\"value\":2}', 'stale');
    CREATE INDEX manifest_status_idx ON manifest_rows(status);
    CREATE FUNCTION manifest_trigger() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
    CREATE TRIGGER manifest_changed BEFORE UPDATE ON manifest_rows FOR EACH ROW EXECUTE FUNCTION manifest_trigger();"
}
changed() {
  label=$1
  mutation=$2
  fixture
  before=$(digest)
  sql "$mutation"
  after=$(digest)
  [ "$before" != "$after" ] || {
    echo "FAIL: manifest ignored $label" >&2
    exit 1
  }
  echo "PASS: manifest detects $label"
}
fixture
before=$(digest)
sql "DELETE FROM manifest_rows; INSERT INTO manifest_rows VALUES (2, '{\"value\":2}', 'stale'), (1, '{\"value\":1}', 'ready');"
[ "$before" = "$(digest)" ] || { echo 'FAIL: row order changed the manifest' >&2; exit 1; }
echo 'PASS: row order does not change the manifest'
fixture
sql "ALTER TABLE manifest_rows ADD COLUMN action varchar(128) DEFAULT 'ACCEPT'
  CONSTRAINT manifest_action CHECK (action IN ('ACCEPT', 'DROP', 'QUOTE''S', '::character varying::text', '], ::text[]'))"
before=$(digest)
pg_dump -Fc --no-owner --no-acl >"$work/roundtrip.dump"
sql 'DROP SCHEMA public CASCADE; CREATE SCHEMA public'
pg_restore --exit-on-error --no-owner --no-acl -d "$PGDATABASE" "$work/roundtrip.dump"
[ "$before" = "$(digest)" ] || { echo 'FAIL: dump/restore changed an equivalent CHECK manifest' >&2; exit 1; }
echo 'PASS: dump/restore preserves the CHECK manifest'
before=$(digest)
sql "ALTER TABLE manifest_rows DROP CONSTRAINT manifest_action;
  ALTER TABLE manifest_rows ADD CONSTRAINT manifest_action CHECK (action IN ('ACCEPT', 'BLOCK'))"
[ "$before" != "$(digest)" ] || { echo 'FAIL: manifest ignored a changed CHECK value' >&2; exit 1; }
echo 'PASS: manifest detects a changed CHECK value'
changed 'row content with unchanged count' "UPDATE manifest_rows SET payload = '{\"value\":3}' WHERE id = 1"
changed 'sequence is_called' "SELECT setval('manifest_seq', 1, false)"
changed 'enum labels' "ALTER TYPE manifest_status ADD VALUE 'new'"
changed 'row security enabled' 'ALTER TABLE manifest_rows ENABLE ROW LEVEL SECURITY'
changed 'row security forced' 'ALTER TABLE manifest_rows FORCE ROW LEVEL SECURITY'
changed 'row security policy' 'CREATE POLICY manifest_read ON manifest_rows USING (id = 1)'
changed 'trigger enabled state' 'ALTER TABLE manifest_rows DISABLE TRIGGER manifest_changed'
changed 'column default' "ALTER TABLE manifest_rows ALTER COLUMN status SET DEFAULT 'stale'"
changed 'index removal' 'DROP INDEX manifest_status_idx'
echo 'manifest PostgreSQL checks passed'
