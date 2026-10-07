# Destruction governance authorization

Legal holds and two-person destruction use the database account's current tenant,
status and membership, independently of role and organization claims in an older
JWT. Only an active `users.role = 'super-admin'` account has platform scope.

Within the current organization, owners and admins can impose a legal hold,
request destruction, approve another administrator's request, or reject a pending
request. Releasing a legal hold requires an owner. Approval reloads both actors
before invoking the shred. A tenant change, membership removal, demotion or account
revocation before that check can therefore invalidate a pending request.

Tenant-owned holds and requests return 404 across organization boundaries. Lists
and the status overview show the authenticated account's own organization; platform
administrators can inspect all organizations. Global requests, approval and rejection
require platform administrators, including the initiating account at execution.
Legal holds and the requirement for two distinct actors remain enforced.

Migration `033_governance_memberships.sql` converts legacy `users.role = owner/admin`
accounts without a membership into members with the same role in their current
organization (`NULL` maps to `org-default`). Existing memberships are preserved,
including lower roles. The migration ledger applies this conversion once; runtime
authorization never falls back to the residual legacy role. Removing a membership
therefore revokes its mutation privileges without them returning on restart.

These checks govern authorization. The lifecycle of already connected mesh nodes
after global shredding requires a separate traffic test; this change does not
establish that global shredding stops their existing tunnels.

Approval holds a dedicated PostgreSQL transaction from its authorization lock
through the current account/membership checks, legal-hold checks, key and credential
revocations, shred, ACL/netmap epochs and final authorization status. A failure
before commit rolls back all those database effects. A competing approval cannot
execute the same authorization twice.

Requests, approvals, rejections and legal-hold mutations share one transaction-level
advisory lock, including tenant/global overlaps and holds that do not yet exist.
The first operation to acquire the lock is evaluated first. A hold that commits
first blocks a subsequent approval. An approval that owns the lock first commits
before a competing hold; a new hold on a destroyed tenant returns 404. Rejection
and approval follow the same order, so a rejected request cannot later be executed
by an approval that read an older pending state.

Locks on both current users and their authorizing memberships remain held until
commit. Earlier account/membership changes are awaited and rechecked; later changes
wait for the accepted execution to finish. Organization/user locks use
`FOR NO KEY UPDATE` to stay compatible with foreign-key references. Shred locks
nodes before users, matching the account-wipe order. The concurrency tests use
real PostgreSQL connections and scheduling latches, and verify rollback and
visibility before commit as well as both operation orders.

Audit events and notifications run after commit. Their delivery is best effort:
failure is logged and leaves the executed authorization durable; a process crash
between commit and notification can lose delivery. There is no transactional
outbox or exactly-once delivery promise. ACL/netmap epochs are already persisted
with the shred, so a failed additional notification does not undo their change.

The separate owner dead-man's-switch global wipe in `NukeEngine` does not enter
this governance transaction. Direct administrative SQL that changes legal holds
also does not participate in its advisory lock. Concurrency with every other
destructive account/organization path has not been certified deadlock-free;
PostgreSQL aborts a deadlocked transaction and its database effects roll back.
