# ADR 0024: Durable MFA password proofs

- Status: Accepted
- Date: 2026-10-19
- Extends: ADR 0018 and ADR 0023

## Context

A five-minute signed `mfa_pending` JWT proved a password check, but its successful
consumption was recorded only in cache. Independent API processes could reuse it.
Recovery-code verification read an unlocked JSON array and replaced the whole
array afterward. Concurrent requests could spend one code twice or restore a
different code. Enrollment, factor consumption and session persistence committed
separately, leaving partial changes after a failed session write.

## Decision

Register every password-step JWT in PostgreSQL `console_mfa_challenges`, storing
its UUID, exact token digest, account, organization, authentication epoch, intended
standard/root tier and deadline. The JWT alone grants no authority. Unknown,
consumed, expired or superseded proofs require a fresh password login.

Login rechecks the verified password snapshot against the locked current account
before either registering a challenge or issuing a session directly with an OTP.
Local registration follows the same server MFA policy and returns a pending step
when enrollment is required. MFA policy is read on the transaction client at
admission. This does not enforce MFA retroactively on existing sessions after a
membership promotion. OIDC remains a separate identity-provider authentication
flow; this decision does not assert IdP authentication assurance.

MFA transitions lock the account exclusively, then the challenge or existing
session family, then session/refresh records. Challenge consumption, recovery-code
removal or authenticator activation and session persistence use one client and one
transaction. An error rolls everything back; success cookies and success audit
calls follow commit. Audit delivery itself remains best effort. Session helpers
accept an existing transaction client and never start a nested pool transaction.

An account authentication epoch increases when password hashes, organization,
status, platform role or the active authenticator change. Changing a value back
does not revive an older proof. Account-wide revocation increases the epoch too.
Recovery consumption and pending setup do not change it: independent password
proofs and distinct recovery codes must remain usable. Enrollment activation may
advance the epoch inside the successful completion transaction without invalidating
that same transaction's already-validated proof.

Pending enrollment records its initiating challenge UUID or full-session UUID,
epoch and SQL deadline. Another login cannot confirm or replace that unexpired
setup. Repeating setup from the same proof replaces its QR; the older QR no longer
confirms it. The lease is bounded by the proof deadline, family deadline and ten
minutes. Expiry and conflict checks use PostgreSQL's clock after account admission.

Organization-key opening/sealing and QR generation finish before account locks.
The transaction rechecks the prepared ciphertext, organization and epoch before
using the result. This avoids acquiring organization-key locks after the account
lock. No membership-row trigger is added: a trigger that locks the account after
locking a membership can invert existing enrollment locking order.

## Upgrade and limits

Migration 040 preserves enrolled authenticators and existing recovery hashes.
Unregistered password proofs and legacy pending QR setups require a fresh login
and setup. Deploy the migration and all API replicas together; older replicas do
not enforce this authority. Never treat a mixed deployment as an HA proof.

This change consumes each password proof and recovery code once. It does not add
global TOTP time-step replay tracking across independent password logins, certify
multi-host failover or fix relocation of organization-sealed secrets between
tenants. Moving a ciphertext from organization A to B without an authorized
resealing workflow cannot make it decryptable with B's key. Retention and pruning
of challenge records remain a separate operational gate.

## Acceptance evidence

Behavioral tests use PostgreSQL, two independent HTTP processes, actual row-lock
barriers and insertion failures. Baselines reproduced duplicate consumption,
lost updates, tenant/password/status round trips, cross-login setup confirmation,
expired setup, root-tier loss, registration policy bypass and partial factor
writes. Additional checks exercise a stale password snapshot during admission
and an API clock behind the database. Acceptance completed on 19–20 October:
42 focused checks and the complete 1,035-test backend suite pass on Node 22 and
PostgreSQL 18. Eleven removal mutations fail; final sources are restored
byte-identically. A populated 039 schema reconstructed by removing only 040's
additions preserves sealed/plain factors and existing session credentials when
the actual 040 SQL is applied. This tests the SQL upgrade, not every migrator or
deployment failure mode.

The running isolated image matches the production sources and records both
migrations. Actual API processes, including one without initialized Valkey,
demonstrate single consumption, rollback and recovery. Thirteen native nodes
retain their IDs/VIPs and complete all 156 directed TCP exchanges after the update.
These checks do not establish HA or the separate security limits above.

The locking design follows [PostgreSQL explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html).
The separate OTP replay limitation is documented against
[RFC 6238 section 5.2](https://www.rfc-editor.org/rfc/rfc6238.html#section-5.2);
this ADR makes no claim of complete authenticator conformance.
