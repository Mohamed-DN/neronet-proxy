# ADR 0025: Versioned audit content integrity

- Status: Accepted
- Date: 2026-10-20

## Context

The existing ledger used a delimiter-separated HMAC input. Moving a delimiter
between adjacent fields preserved that input, and null and empty fields could
collide. Event identifiers and user agents were omitted. JavaScript dates lost
PostgreSQL microseconds, and decoding JSON strings or precise JSONB numbers before
verification could hide changes. Separate event and checkpoint queries could
also observe different committed states during a concurrent append.

Existing hashes cannot prove coverage of fields they never signed. Rewriting
history with new hashes would discard that distinction.

## Decision

Migration 041 labels existing records as canonical version 1 without changing
their hashes, metadata, identifiers or checkpoints. New writers reserve the event
identifier and write version 2 inside the existing serialized append transaction.

Version 2 authenticates a typed JSON tuple with a fixed domain and version,
identifier, sequence, predecessor hash, event fields including user agent,
microsecond UTC timestamp, metadata text and dedicated HMAC key identifier. Null
and empty strings remain distinct. The canonical metadata text is both signed
and used for the JSONB insertion. After checking all HMACs, verification compares
that authenticated text against stored JSONB in PostgreSQL, in batches of 1,000.
This preserves SQL numeric precision and distinguishes JSON types without trusting
JavaScript's decoding. Malformed unauthenticated text fails its MAC before any
SQL JSON cast. This is an internal format, not a claim of RFC 8785 conformance.

Verification owns one repeatable-read, read-only transaction. A borrowed-client
entry point lets disaster-recovery verification retain its existing transaction;
it never connects again, commits or releases the caller's client. Partial ranges
verify their prefix in the same snapshot. A version-1 record after version 2 is
rejected. Signed checkpoints match both the covered identifier and hash.

Reports distinguish `canonical-v2`, `legacy-partial` and `empty`. The console
shows partial or unknown coverage explicitly and exports the actual report,
without a fabricated compliance seal. The legacy JWT-key switch remains separate
from `SOVEREIGN_AUDIT_ACCEPT_LEGACY_CANONICAL=false`, which refuses version 1.
Disabling acceptance does not delete or repair historical records.

## Alternatives and trade-offs

- Rehashing old records would erase their original integrity evidence. Preserve
  their exact historical verifier and expose its limitations instead.
- Serializing decoded JSON alone cannot distinguish SQL numeric changes already
  rounded by JavaScript. Authenticated text plus SQL equivalence requires another
  column and batched reads but retains those distinctions.
- Independent pool queries are shorter-lived but can produce a false truncation
  report during concurrent appends. One snapshot gives a coherent ledger view.

## Upgrade and limits

Coordinate all API writers and migration 041. Once version-2 records exist, an
older writer cannot safely resume the version-1 format. Preserve a backup and use
a forward fix; do not rewrite the ledger to make an older binary appear compatible.
Historical format/key acceptance is a migration policy, not restored coverage.
Partial ranges inside a retired-JWT-key prefix remain conservatively rejected.

Verification currently reads the selected events and their prefix into memory;
large ledgers and long snapshots need a separate bounded verification design.
Sequence/range handling still uses JavaScript numbers. This change establishes no
arbitrary-size ledger performance guarantee or multi-host HA proof.

HMAC verifies admitted records, not delivery of every attempted action. Audit
delivery remains best effort, organization attribution and retention remain open,
and checkpoints are not automatically scheduled or externally anchored. An actor
holding both database access and signing keys can rewrite evidence. Deleting an
uncheckpointed tail is not detectable solely from the remaining rows. Protect
keys and externally retain checkpoint evidence before relying on that boundary.

## Acceptance

Behavioral tests exercise real PostgreSQL rows and the verification HTTP endpoint,
including the actual migration on a reconstructed populated 040 schema. They cover
field boundaries, identity, microseconds, JSON types/precision, authenticated text,
the second metadata batch, concurrent snapshot reads, historical preservation,
format downgrade and recovery transaction ownership.

Acceptance on 20–29 October: 54 focused checks and the complete 1,059-test backend
suite pass on Node 22/PostgreSQL 18, without skipped or cancelled tests. Twelve
backend removal mutations and two UI mutations fail; sources are restored exactly.
Frontend format, types, lint, build and all 241 Vitest tests pass, along with its
existing Node test suite.

The isolated production images match the frozen source. Migration 041 preserves
all 55 pre-upgrade audit rows and all pre-existing checkpoints. Actual authenticated
HTTP checks reject altered user agents, precise JSONB numbers, microsecond dates
and malformed signed text, then pass after each exact restoration. Two independent
processes append 20 events without breaking the ledger. Synthetic accounts are
removed; audit probe events remain. Browser checks cover Italian/English, light/dark
and widths 1,024/1,440 with actual partial-coverage responses and no page errors.
The thirteen native nodes retain their IDs/VIPs and complete all 156 directed TCP
exchanges after the update. These checks do not close the separate limits above.
