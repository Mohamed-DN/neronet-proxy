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

## Explicit logout

Logout stores a SHA-256 digest of the presented access token in
`access_token_revocations`. The same PostgreSQL transaction revokes the supplied
refresh credential belonging to the authenticated account, or that account's
refresh credentials when none is supplied. A credential belonging to another
account cannot be revoked by this request. The response acknowledges success only
after commit; a failed write returns 503 without clearing cookies or recording a
successful logout. No raw access token is stored in the revocation table.

HTTP admission, full-session MFA endpoints and topology WebSocket revalidation
read this state. A second process with independent caches rejects a logged-out
token. Existing sockets stop on their next authority check; logout does not
retract a delivered event or cancel an operation already authorized.

Migration 038 is additive and must be applied before serving the updated API.
If its table cannot be read, authenticated admission fails closed with 503.
Revocation expiry follows the verified JWT `exp`, rather than a fixed cache TTL.
Legacy signed tokens without `exp` retain a null expiry and cannot be purged on
a guessed lifetime. Automatic pruning is not implemented; expired rows may be
removed only after their signed expiry. Deploy the migration and API together;
an older API replica does not check the new table.

This implements explicit token termination following the
[OWASP JWT guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
and uses PostgreSQL's
[transaction guarantees](https://www.postgresql.org/docs/18/tutorial-transactions.html).

Organization changes have two additional boundaries:

- A root-password grant for hidden compartments remains bound to the organization
  where the token was issued. Transferring the account does not transfer that grant.
- Console enrollment keeps the token's signed organization context separate from
  the refreshed account. The existing enrollment transaction locks and checks that
  context before creating a node. After a transfer, obtain a token for the new
  organization before creating a node or generating a configuration there.

## Topology connections

The WebSocket upgrade validates current authority before sending its greeting.
The server checks authority again before each topology event, on application
pings and on its heartbeat. Demotion or membership changes therefore affect
event filtering on an already-open connection. Deleted, inactive, revoked or
unverifiable sessions stop receiving events. Idle connections also close when
their access token expires; they do not wait for a fleet event.

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
and recovery. Enrollment
tests also check that denied requests leave no node behind and that a fresh login
can enroll in the new organization.

This change does not introduce access-session families or revoke other access
tokens issued earlier in a refresh chain. Durable MFA challenge consumption,
refresh/logout concurrency, multi-host failover, every topology payload's
compartment filtering and large-fleet fanout performance remain open. Those require
separate migrations and acceptance tests. PostgreSQL/Valkey HA is a separate
deployment capability; single-node authority checks do not certify it.

See [ADR 0018](../adr/0018-console-session-hardening-and-mfa.md) for the session
and MFA design and its earlier implementation amendments.
