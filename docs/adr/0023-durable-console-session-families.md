# ADR 0023: Durable console session families

- Status: Accepted
- Date: 2026-10-19
- Supersedes: ADR 0018's account-wide refresh replay scope

## Context

Explicit access-token tombstones survive cache loss, but cannot identify earlier
access tokens in a refresh chain. Refresh consumption and replacement were separate
commits. Vault lock did not invalidate an earlier root token, and a successful
full-session MFA confirmation created an independent sign-in. A signed JWT alone
cannot provide durable termination of these credentials across API processes.

## Decision

One sign-in creates one PostgreSQL `console_sessions` family, named by the signed
UUID `sid`. Current account and membership authority remain in PostgreSQL. Access
admission requires ownership of an active, unexpired family; unknown and legacy
families fail closed. Upgrade preserves historical refresh rows and requires fresh
sign-in for credentials issued without a family. All API replicas must be upgraded
together before admission resumes.

Refresh consumes and replaces a credential in one transaction. Replaying a consumed
credential terminates its whole family, including previous access tokens, while
other sign-ins remain independent. A concurrent refresh winner is also terminated
when replay commits. Logout takes its family from the authenticated access token;
the presence or content of a supplied refresh credential does not broaden scope.
Account-wide revocation locks the account exclusively and closes all existing
families. A later fresh sign-in is allowed.

Transitions lock the account, then the family, then refresh records. Account-wide
revocation locks families in UUID order. OIDC checks perform network I/O before
these locks. A failed replacement or revocation write rolls back the whole
transition; 503 is returned without success cookies. Replay returns an error
decision after commit rather than throwing inside a transaction and undoing its
own revocation.

The first refresh JWT sets the absolute family deadline, seven days by default.
Rotation, full-session MFA confirmation and vault changes cannot extend it.
WebSocket admission and revalidation use the family too; idle expiry is bounded
by both the JWT and SQL deadlines. Already authorized operations and delivered
messages are not retracted.

Hidden-compartment access requires a matching SQL root grant UUID, deadline and
tenant. Lock or ordinary refresh clears the grant. Unlock replaces it after
rechecking the verified password hash against the locked account. Tenant and
root-password changes invalidate grants through a SQL trigger, so returning to a
previous value cannot resurrect an old proof. Vault issuance uses the shared
Strict HttpOnly cookie policy and omits refresh credentials from JSON.

## Alternatives

- Keep JWT tombstones only: small change, but it misses earlier access tokens and
  requires enumerating credentials that the server did not store.
- Revoke every sign-in on any replay: limits blast radius of a stolen credential
  by logging out the account everywhere, but couples otherwise independent devices.
  The chosen family scope tracks the compromised chain explicitly.
- Keep legacy signed-token admission temporarily: smoother rollout, but leaves a
  path that cannot enforce the new revocation guarantees. Require fresh sign-in.

## Consequences and limits

PostgreSQL availability is required for admission and transitions. Records grow
until a separate retention job is implemented; consumed refresh credentials must
remain until their family deadline so replay can be detected. Older API replicas
cannot participate in a mixed-version security rollout.

Password-step MFA challenge consumption, recovery-code concurrency, audit delivery,
restoring an older backup without resurrecting later revocations, and database/API
HA remain separate work. This decision does not certify those capabilities.

Behavioral tests exercise actual PostgreSQL transactions, two HTTP processes,
WebSockets, lock queues, rejected SQL writes, tenant/root-password changes and
upgrade fixtures. Removal mutations and a dedicated running stack are delivery
gates alongside exact-commit CI.

## Sources

- [RFC 9700, refresh protection](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)
  informs family tracking and rotation; NeroNet does not claim full OAuth conformance.
- [PostgreSQL 18 explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html)
  describes the row locks and consistent acquisition order used here.
