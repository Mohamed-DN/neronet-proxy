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
Existing cache and persistent token-revocation checks are retained.

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
database unavailability, connected-token revocation and idle expiry. Enrollment
tests also check that denied requests leave no node behind and that a fresh login
can enroll in the new organization.

This change does not introduce durable access-session families or certify
revocation after cache loss, multi-API failover, MFA concurrency, every topology
payload's compartment filtering, or large-fleet fanout performance. Those require
separate migrations and acceptance tests. PostgreSQL/Valkey HA is a separate
deployment capability; single-node authority checks do not certify it.

See [ADR 0018](../adr/0018-console-session-hardening-and-mfa.md) for the session
and MFA design and its earlier implementation amendments.
