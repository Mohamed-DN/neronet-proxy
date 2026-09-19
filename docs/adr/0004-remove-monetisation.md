# ADR 0004: Remove monetisation

- Status: Accepted. Recorded in the roadmap on 2026-09-13, confirmed on 2026-09-19
  (see [ADR 0014](0014-confirm-earlier-decisions.md)).
- Date: 2026-09-13

## Context

The code and the planning documents carried a commercial model: user tiers
(`cloud_managed`, `managed_cloud`, `hybrid_byos`, `free_core`), bandwidth and node
quotas, subscription pricing, payment gateways and offline licence tokens. None of it
was in use, and it added columns, checks and UI that had to be kept consistent.

## Decision

There are no paid features, no tiers and no quotas. Authorisation stays: `users.role`
is not monetisation. Technical limits stay: rate limiting, page size and the overlay
address pool protect the infrastructure and do not gate features commercially.

## Consequences

- `users.tier`, `bandwidth_quota_gb`, `bandwidth_used_bytes`, `max_nodes` and
  `app_bundles.tier` are dropped by migration `011_remove_tiering`. The quota checks
  and the console components that displayed tiers are removed.
- The business-model chapter and the licensing section of
  [BUSINESS_AND_ROADMAP.md](../../BUSINESS_AND_ROADMAP.md) are removed.
- `GET /api/users/:id/quota` remains and reports the number of nodes an account has. It
  reports usage, not an entitlement.
- No billing, payment or licence-verification code is to be added.
