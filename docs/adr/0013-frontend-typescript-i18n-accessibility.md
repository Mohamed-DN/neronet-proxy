# ADR 0013: The console moves to TypeScript, Italian and English, and WCAG 2.1 AA

- Status: Accepted (reviewer's recommendation under delegated authority, 2026-09-19)
- Date: 2026-09-19
- Decision label: D7

## Context

The console is React in JavaScript with English text only. Several people change the
same UI in parallel, and a mismatch with the API contract shows up at runtime. Public
administration requires Italian and accessibility conforming to Legge Stanca.

## Decision

- TypeScript, adopted incrementally: new and touched files are TypeScript, and existing
  files are converted as they are changed.
- Two languages, Italian and English, through an i18n layer. Text is not hard-coded in
  components.
- WCAG 2.1 level AA is a requirement, checked automatically with axe in CI, and
  reviewed by hand for the flows that automation cannot judge.

The router and the server-state library are technical choices made in the frontend
work package; the target architecture proposes `react-router` and TanStack Query.

## Consequences

- API types are generated from the contract ([ADR 0007](0007-remove-go-control-plane-server.md)),
  so a contract mismatch fails the type check.
- Every data component has explicit states for loading, empty, error, not measured and
  not implemented. A value that is not measured is shown as such and never as a default.
- The fixtures used in tests must not be part of the production bundle.
- Feature flags are decided by the server, as for Cloud PC
  ([ADR 0010](0010-freeze-cloud-pc.md)).
- The console has no automated accessibility check today.
