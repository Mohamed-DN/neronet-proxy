# ADR 0003: Remove NeroDrop

- Status: Accepted. Deferred on 2026-09-13, deleted after the confirmation of
  2026-09-19 (see [ADR 0014](0014-confirm-earlier-decisions.md)).
- Date: 2026-09-13

## Context

NeroDrop was presented as peer-to-peer encrypted file transfer with 64 KB chunks and
BLAKE3 hashing. The implementation did not do that: the route returned a fabricated
session description string, and the frontend contained no `RTCPeerConnection`. Its
routes were also never ported off SQLite, so on PostgreSQL, the production database,
the page answered 500 and the client substituted fixture transfers, showing a history
of transfers that had never taken place.

File transfer over a mesh is a solved problem (Syncthing, Magic Wormhole, scp over the
overlay) and does not differentiate the product.

## Decision

NeroDrop is deleted, not frozen. Its history stays in git.

## Consequences

- The component, the routes, the client methods and the fixtures were removed in
  `3142f50` and `68b456a`.
- The `nerodrop_sessions` table remains in the PostgreSQL schema until the database
  consolidation of [ADR 0009](0009-postgresql-only.md), which drops it.
- Engineering effort goes to the parts of the product that have no equivalent elsewhere:
  onion routing, the warrant canary, and the reworked NeroNuke described in
  [ADR 0006](0006-target-market-banks-and-public-administration.md).
