# ADR 0009: PostgreSQL only, in production and in tests

- Status: Accepted (reviewer's recommendation under delegated authority, 2026-09-19)
- Date: 2026-09-19
- Decision label: D3

## Context

The backend supports two dialects, PostgreSQL and SQLite, maintained by hand in
parallel: the PostgreSQL schema is in `console/backend/db/migrations/*.sql` and the
SQLite DDL is in `db/migrator.js`. Every query has two implementations. A parity test
compares the two schemas and they had drifted three times before it existed. The audit
ledger recorded nothing on PostgreSQL until `72d2ef3`, while the tests, which run on
SQLite, passed.

Options:

- PostgreSQL only, including the tests, with an ephemeral database per test file
  (chosen). The cost is one large migration and a somewhat slower suite.
- Keep both. Every future change costs twice, and the class of defect above can recur.

## Decision

PostgreSQL 16 is the only database. The tests run against a real PostgreSQL instance,
one throw-away database per test file.

## Consequences

- The SQLite code paths, the SQLite DDL and the schema parity test are removed.
- Migrations form a single sequence and are applied as a set. The runner already does
  this.
- The `nerodrop_sessions`, `app_bundles` and `app_share_links` tables, whose code was
  deleted ([ADR 0003](0003-remove-nerodrop.md), [ADR 0014](0014-confirm-earlier-decisions.md)),
  are dropped in the same work. A migration that drops data must not swallow an error
  before the drop.
- Until this lands, `main` still supports both dialects, and the backend suite runs on
  SQLite.
- The database of the compose stack can move from the PostGIS image to plain
  `postgres:16` once migration `004_drop_postgis` has run everywhere.
