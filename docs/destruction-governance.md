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

Approval is not atomic with concurrent approvals, legal holds or role changes.
Its `FOR UPDATE` query currently runs outside a dedicated transaction, so the row
lock ends before the later checks and execution. A separate concurrency fix must
reproduce and serialize those races; the current scope tests do not prove that
an approval runs exactly once or that a concurrent hold/revocation stops it.
