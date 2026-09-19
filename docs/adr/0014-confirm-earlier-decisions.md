# ADR 0014: Confirm the earlier decisions and delete App Bundles

- Status: Accepted (reviewer's recommendation under delegated authority, 2026-09-19)
- Date: 2026-09-19
- Decision label: D8

## Context

Earlier work had already taken five decisions, and the plan carries them out. They are
confirmed here so that the record is complete, and one of them, App Bundles, is
recorded for the first time.

## Decision

1. NeroDrop is deleted. See [ADR 0003](0003-remove-nerodrop.md).
2. App Bundles are deleted. The routes were SQLite-only, the frontend client methods had
   no callers, and `POST /apps/:id/start` set `status = 'running'` in a table without
   starting a container, then answered success. The feature claimed provisioning of
   Nextcloud, Immich, Seafile and Guacamole that did not exist.
3. Monetisation is removed. See [ADR 0004](0004-remove-monetisation.md).
4. There is no message broker. See [ADR 0002](0002-no-message-broker.md).
5. There is no PostgreSQL multi-master. See
   [ADR 0001](0001-no-multi-master-postgresql.md).

## Consequences

- The App Bundles routes, client methods, fixtures and seeded rows were removed in
  `9dc8dc5`. The tables `app_bundles` and `app_share_links` are dropped in the database
  consolidation of [ADR 0009](0009-postgresql-only.md).
- The console component `AppBundles.jsx` was in fact the Cloud PC page. It is handled by
  [ADR 0010](0010-freeze-cloud-pc.md) and is now `CloudPc.jsx`.
- The App Bundles chapters of [BUSINESS_AND_ROADMAP.md](../../BUSINESS_AND_ROADMAP.md)
  describe a deleted feature and are kept only as a design study.
