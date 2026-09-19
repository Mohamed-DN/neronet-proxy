# ADR 0006: The target market is banks and public administration

- Status: Accepted (reviewer's recommendation under delegated authority, 2026-09-19)
- Date: 2026-09-19
- Decision label: D0

## Context

Two positionings existed in the project and they conflict:

- The delivery brief names banks and public administration as the buyers.
- The handbook, written in an earlier session, positioned the product for journalists
  and law practices and stated that it is "not for corporate IT".

Both share the core (data plane, identity, CI) and diverge on everything else:

| | A: banks and public administration | B: high-risk individuals |
|---|---|---|
| Priorities | Single sign-on, roles, audit, high availability, backup, compliance, accessibility, Italian | Data plane and onion routing, deniability, mobile clients, minimal metadata |
| NeroNuke | Cryptographic erasure with two-person approval and legal hold; no destruction under coercion | As today, plus cryptographic erasure |
| Deniability passwords, personal dead man's switch | Off by default, outside the offer | Central |
| Regulation | DORA (banks), NIS2, GDPR, ACN qualification and AgID guidelines (public administration), Legge Stanca | GDPR |
| Client | Windows desktop first | Mobile first |

## Decision

Option A. The product targets banks and public administration.

## Consequences

- Priority goes to single sign-on (OIDC), a role model with an auditor role,
  tamper-evident audit, high availability, backup and restore that is proven, an Italian
  and English console, and accessibility (see
  [ADR 0013](0013-frontend-typescript-i18n-accessibility.md)).
- NeroNuke is reworked: destruction of an organisation's data means destruction of its
  encryption key, requires two people, and respects a legal hold. It does not act on
  coercion. Today NeroNuke deletes rows and provides no cryptographic erasure; see
  [the handbook](../HANDBOOK.md), section 6.
- The plausible-deniability passwords and the personal dead man's switch stay in the
  source tree but are switched off by default behind server-side feature flags and are
  outside the offer. This keeps an edition for the other audience possible later. The
  flags are not implemented yet; on `main` these features are still active.
- The handbook positioning section is rewritten to match this decision.
- The first client is Windows desktop.
- The compliance frameworks are targets. No qualification or certification has been
  applied for or obtained.
