# Console session authority

An access token identifies a console account. Its stored role and organization
are not the current authorization decision. Authenticated console requests read
the account and its home-organization membership from PostgreSQL. This applies
to ordinary HTTP routes, feature-module guards and the topology WebSocket.

The request uses the current username, platform role, organization and membership
role. A module guard and its router share that request's decision; it is not
cached across requests. Invalid or expired tokens and deleted accounts receive
401; suspended or revoked accounts receive 403. If PostgreSQL authority cannot
be read, the request receives 503 instead of falling back to token claims.
Cache entries can reject a token early; their absence never replaces the
PostgreSQL revocation decision.

## Session families and logout

Logout stores a SHA-256 digest of the presented access token in
`access_token_revocations`. The same PostgreSQL transaction revokes the authenticated
session family, including earlier access tokens and every refresh credential from
that sign-in. The access token's registered family determines scope; a refresh
credential supplied in the body cannot select a different family. Other independent
sign-ins remain active, including when no refresh cookie reaches logout. The response acknowledges success only
after commit; a failed write returns 503 without clearing cookies or recording a
successful logout. No raw access token is stored in the revocation table.

HTTP admission, full-session MFA endpoints and topology WebSocket revalidation
read this state. A second process with independent caches rejects a logged-out
token. Existing sockets stop on their next authority check; logout does not
retract a delivered event or cancel an operation already authorized.

Migrations 038 and 039 must be applied before serving the updated API.
If the required authority tables cannot be read, admission fails closed with 503.
Revocation expiry follows the verified JWT `exp`, rather than a fixed cache TTL.
An access token without `exp` retains a null tombstone expiry, but still requires
a valid registered family and cannot outlive that family's SQL deadline. Automatic
pruning is not implemented. Replay detection needs consumed refresh records for
the remaining family lifetime; do not delete them merely because they are revoked.
Deploy the migrations and all API replicas together; older replicas do not enforce
the new authority. This is a coordinated security upgrade, not a mixed-version HA proof.

Each password sign-in, completed MFA password step or OIDC sign-in creates a UUID
family. Migration 039 preserves existing refresh rows and marks credentials with no
family revoked; existing access tokens without a registered `sid` require a fresh
sign-in. There is no signed-token fallback for old clients. The session deadline is
fixed by the initial refresh JWT expiry (`REFRESH_EXPIRES_IN`, seven days by default).
Refresh, vault changes and MFA confirmation from an already authenticated session
keep the same family and cannot extend that absolute deadline.

Refresh consumes its credential and inserts its replacement in one SQL transaction.
A replay commits revocation of the affected family before returning 401. Even when
two requests race and one receives a replacement, that replacement becomes unusable
after the replay has settled. Independent sign-ins remain valid. The implementation
uses the family tracking and rotation principles in
[RFC 9700 section 4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2);
this does not claim complete OAuth conformance. OIDC network checks finish before
the SQL account/family locks are acquired.

Family transitions acquire the account lock before the family lock. Refresh locks
the consumed credential afterward. Account-wide `revoke-sessions` takes an exclusive
account lock, locks existing families in UUID order and revokes their access and
refresh credentials atomically. Its response keeps the existing `revoked_count`
meaning: refresh rows newly revoked. It does not cancel an already authorized
operation or prevent a later fresh password sign-in.

This implements explicit token termination following the
[OWASP JWT guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
and uses PostgreSQL's
[transaction guarantees](https://www.postgresql.org/docs/18/tutorial-transactions.html).

Organization changes have two additional boundaries:

- A root-password grant for hidden compartments remains bound to the organization
  where it was obtained. Its UUID and expiry must match the current SQL grant.
  Locking, refreshing or confirming MFA clears it; unlocking issues a new UUID.
  A tenant transfer or root-password change clears grants durably through a SQL
  trigger, including when the previous tenant or password is later restored.
  Password verification is checked again against the locked account before a new
  grant is issued. Vault endpoints use the same Strict HttpOnly cookies as login
  and never return the refresh credential in JSON.
- Console enrollment keeps the token's signed organization context separate from
  the refreshed account. The existing enrollment transaction locks and checks that
  context before creating a node. After a transfer, obtain a token for the new
  organization before creating a node or generating a configuration there.

## MFA password steps and enrollment

Migration 040 registers five-minute password steps in `console_mfa_challenges`.
Only the exact issued token digest, account, organization, authentication epoch
and unconsumed SQL deadline authorize completion. Signature validity alone is
insufficient. Local registration returns HTTP 201 with `mfa_required`,
`mfa_setup_required` and `mfa_token` when policy requires enrollment; it does not
return a full access token or authentication cookies at that point.

Completion locks the account exclusively before the challenge or existing family.
It consumes the challenge and recovery code, or activates the pending factor,
and persists the session using the same SQL client and transaction. Failed writes
roll back all these changes; the same proof can be retried after recovery. A second
API process without a matching cache entry cannot reuse a completed proof. An
invalid OTP does not consume it, and independent password proofs remain independent.

An authentication epoch invalidates old proofs after password, organization,
status, platform-role or active-authenticator changes, including when the previous
value is restored. Account-wide revocation invalidates outstanding password steps
too. Login rechecks its verified password snapshot under the account lock before
registering a challenge or issuing a session with a directly supplied OTP. MFA
policy is read on that transaction's client at admission; this is not retroactive
enforcement on already-open sessions after membership changes.

A pending QR setup is bound to the initiating challenge or family, its epoch and
a database deadline bounded by the proof/family lifetime and ten minutes. Another
sign-in cannot confirm it or overwrite an unexpired setup. Repeating setup from
the same proof replaces the earlier QR. A revoked initiating family's setup can
remain in conflict until its lease expires, but cannot be confirmed. Full-session
confirmation locks and rechecks the family before changing the factor, retains
the same SID and clears its root grant. A fresh root-password MFA login preserves
the root tier only while its registered password proof remains current.

Upgrade all APIs together with migration 040. Enrolled factors, remaining recovery
codes and existing session families are preserved. Old unregistered MFA tokens
and pending QR setups require a new password login and setup. Automatic challenge
pruning is not implemented. Opening/sealing organization secrets completes before
account locks; the transaction checks the prepared value again before use.

This does not track TOTP time-step replay globally across independent password
logins. It does not establish assurance for an OIDC provider's authentication or
provide an authorized resealing workflow for moving an enrolled factor to a new
organization. See [ADR 0024](../adr/0024-durable-mfa-password-proofs.md).

## Topology connections

The WebSocket upgrade validates current authority before sending its greeting.
The server checks authority again before each topology event, on application
pings and on its heartbeat. Demotion or membership changes therefore affect
event filtering on an already-open connection. Deleted, inactive, revoked or
unverifiable sessions stop receiving events. Idle connections also close when
their access token or SQL family expires; they do not wait for a fleet event.

These checks authorize each delivery. They do not retract messages already
delivered or guarantee that a database change can cancel an operation that has
already passed its authorization boundary. Enrollment retains its separate
transactional lifecycle checks.

## Verification and limits

Regression tests use password login, real HTTP handlers, PostgreSQL mutations and
real WebSocket connections. They cover account deletion/status changes, current
roles and memberships, tenant transfers, module policy, hidden-compartment grants,
database unavailability, connected-token revocation and idle expiry. Logout tests
use a second real HTTP/WebSocket process, independent caches, foreign-account
refresh credentials and PostgreSQL triggers that reject writes, verifying rollback
and recovery. Family tests also cover concurrent refresh/replay, both lock-queued
refresh/logout orderings, expiry after a lock wait, preservation of other sign-ins,
account-wide revocation, vault grant replacement and tenant/password round trips.
An isolated schema simulates an upgrade with duplicate legacy refresh hashes.
Enrollment
tests also check that denied requests leave no node behind and that a fresh login
can enroll in the new organization.

MFA tests add cross-process consumption and recovery races, rollback after session
insertion failures, both lock-queued confirmation/logout orderings, current
password snapshots, SQL deadlines despite API clock skew and a populated 039→040
upgrade with sealed and legacy factors. Audit delivery guarantees, multi-host
failover, every topology payload's compartment filtering and large-fleet fanout
performance remain open. PostgreSQL/Valkey HA is a separate
deployment capability; single-node authority checks do not certify it.

See [ADR 0018](../adr/0018-console-session-hardening-and-mfa.md) for the session
and MFA design and its earlier implementation amendments.
