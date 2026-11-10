# ADR 0030: Permissions, roles and grants (IAM)

**Status:** Proposed
**Date:** 2026-11-10
**Deciders:** owner (Mohamed), lead engineer
**Supersedes in part:** [ADR 0019](0019-organizations-and-rbac.md) (the role hierarchy stays as the
built-in roles; the way it is enforced is replaced)

## Context

The owner's requirement: administrators give grants to ordinary users; roles are named sets of
permissions; role groups bundle roles; a user can hold one or more roles and direct permissions;
the model follows OCI IAM and its rules.

What the code does today (worktree `console-v2-nov09` at `21896a1`, every line below re-read):

- **Two functions called `requireRole`.** `middleware/auth.js:16` checks the platform field
  `users.role` only (values written by code: `super-admin`, `user`). `middleware/rbac.js:49` lets
  `super-admin` through and otherwise checks `org_role || role`. The first is used where the
  organisation role is meant: `routes/acl.js:11` (all ACL writes), `routes/devices.js:23` (gateway),
  `routes/users.js:36,56,184`, `routes/peering.js`, `modules/nuke/routes.js:218-285`.
- **Role checks are scattered** across at least nine shapes: the two `requireRole`s,
  `requireOrgRole` and `requireNotAuditor` (`rbac.js:72,94`), `requireSuperAdmin` (`rbac.js:110`),
  `requireSelfOrAdmin` (`auth.js:29`), `verifyNodeAccess` (`routes/nodes.js:126-164`),
  `requireNodeOwnership` (`middleware/ownership.js`), inline role sets (`READ_ALL_ROLES`
  `routes/acl.js:39`, `TOPOLOGY_ROLES` `routes/stats.js:40`, `ORG_WIDE_ROLES`
  `ws/topologyServer.js:190`, `ORG_READERS` `services/FleetVisibility.js:3`) and the governance check
  `CryptoShreddingService.requireGovernanceRole` (`services/CryptoShreddingService.js:373`).
  `middleware/permissionMatrix.js` describes a matrix that is mounted nowhere and disagrees with
  the routes.
- **No membership still means "member".** `services/SessionAuthority.js:87` and `rbac.js:37` give an
  account without a membership row the role `member` in `org-default`. With public registration
  this is finding C1 of the security review (`piano/reports/REVISIONE-SICUREZZA-ESPOSIZIONE-NOV10.md`).
- **Routes with no role check at all:** `POST /api/nodes` (`nodes.js:194`, auditors included),
  `POST /api/configs/generate` (`configs.js:22`), all of `/api/cloud-pc`, the `/api/risk` dashboards
  (organisation filter only, `risk.js:19`), `POST /api/devices/profile` (`devices.js:102`),
  `/api/preauth-keys` (only `requireNotAuditor`, `preauthKeys.js:22`, finding M2),
  `GET /api/organizations/:id/members` and the ACL reads (finding M3), `GET /api/stats/recovery-proof/latest`
  and `/ha-leader`, `GET /api/geofencing/policies` and `/evaluate`. `PUT /api/nodes/:id` lets the
  owner of a device set `role`, `latency_ms`, `is_healthy` and `status` (finding H3).
- **Gaps found while verifying.** An organisation `admin` can remove an `owner` who is not the last
  one: `DELETE /api/organizations/:id/members/:userId` allows owner and admin (`organizations.js:212`)
  and `OrgService.removeMember` does not compare ranks. The last-owner guard counts and then writes
  without a lock (`OrgService.js:313-330, 361-375`), so two concurrent demotions can both pass.
  `GET /api/configs/wireguard/:id` answers 403, not 404, for another organisation's device
  (`configs.js:177-181`), which tells the caller the id exists.
- **Revocation is already immediate for HTTP.** `SessionAuthority.resolveAccessToken` re-reads
  `users`, `memberships` and `console_sessions` on every request (`SessionAuthority.js:45-59`); a
  changed membership applies on the next request. An account belongs to one organisation at a
  time (`users.organization_id`, joined there).
- **SSO overwrites manual roles.** `OidcService` upserts the membership role on every login
  (`services/OidcService.js:451-456`); it may grant `admin`, `network_admin`, `auditor`, `member`,
  never `owner` (`OidcService.js:44`).
- **Hidden sub-networks are a tier, not a role.** A hidden compartment is invisible below the root
  tier for everyone, the platform super-admin included (`routes/acl.js:52-53` checks the tier before
  the super-admin shortcut; `CompartmentService.js:48,77,97`).
- **The frontend guesses.** `console/frontend/src/services/roles.ts:51-68` shows the Users page to
  owner/admin while `GET /api/users` admits only the super-admin, and shows ACL pages whose writes
  the server refuses.
- **Audit is fire-and-forget.** `logAuditEvent` is not awaited and opens its own transaction
  (`utils/audit.js:24`, `AuditChainService.appendEvent` `:227`): a grant could be written while its
  audit row is lost.

Research inputs: `piano/reports/RICERCA-IAM-NOV10.md` (OCI, AWS, GCP, Azure, Tailscale; ten
recurring rules), `piano/reports/MAPPA-AUTORIZZAZIONI-OGGI-NOV10.md` (today's map and the test files
that must stay green).

## Approach (be-ambitious, field: IAM architecture for a multi-tenant network control plane)

1. **What a top IAM architect would do that was not asked.**
   - Prove "nothing changes on day one" instead of claiming it: record today's decision for every
     route × role from the running code (a characterisation, or golden-master, table) *before* the
     refactor, and make the refactor reproduce it cell for cell.
   - Make the route inventory machine-checked: a test walks Express's router stack and fails when
     a mounted route has no permission, or has two. New routes cannot ship unguarded.
   - Define verbs by risk, not by HTTP method: **use never widens what the network can reach or
     what an identity is**; anything that adds a peer, a route, an exposure or an identity is manage.
   - Decide the disclosure rule once (when 404, when 403) so every route answers the same way.
   - Turn the security findings into reviewable data: each fix is a one-line change to a built-in
     role and flips named cells of the golden table, nothing else.
2. **Rawest material.** The Express router stack of `createApp()` (not `permissionMatrix.js`, which is
   stale); the SQL in `SessionAuthority.resolveAccessToken`; the inline checks listed above; the test
   fixtures in `console/backend/tests` that create users and memberships; the OCI policy reference
   tables that expand each verb into concrete permissions; AWS's evaluation-logic page for how a
   ceiling intersects with allows.
3. **Methods.** A pure decision function (no I/O) so it can be tested exhaustively; characterisation
   testing for parity; route introspection for coverage; model-based property testing of delegation
   (random operation sequences checked against a small reference model, seeded PRNG, no new
   dependency); PostgreSQL constraint triggers for invariants that must hold under concurrency;
   audit written in the same transaction as the change; OCI verb-to-permission expansion; an
   AWS-boundary-style subset check for delegation.
4. **What shows it is right, other than us.** (a) The golden table: phase 1 passes only with zero
   changed cells; the security phase changes exactly the cells listed in §11, each tied to a finding.
   (b) The security review's scenarios C1, H3, M2, M3 written as HTTP tests that pass against today's
   code (the attack works) and fail after (the attack is refused). (c) The 23 backend and 5 frontend
   test files listed in the map stay green unmodified. (d) The property tests (§12) over at least
   10,000 random sequences. (e) A fresh reviewer, who did not write the code, re-runs the security
   review on the branch and finds no authorization path outside `can()`.

## Decision

### 1. Vocabulary: resource types × four verbs, expanded to actions

We adopt OCI's ladder of four cumulative verbs, **inspect < read < use < manage**, on a fixed list of
resource types. Like OCI, a verb is not itself checked: each (type, verb) expands to a set of
**actions**, and each route checks exactly one action. Roles may be written with verbs
(`device:manage`) or with single actions (`device.delete`); the evaluator expands verbs at load time.

Meaning of the verbs, for every type:

| Verb | Console wording | Rule |
|---|---|---|
| inspect | "Can see it exists" | Names and status in lists. No contents, no configuration. |
| read | "Can view" | Full details, history, configuration, simulations. Changes nothing. |
| use | "Can operate" | Day-to-day actions that **never widen reach or change an identity**: rename, ping, quarantine (cutting is always safe), enrol one's own device under the existing rules. |
| manage | "Can manage" | Create, delete, revoke, change roles/endpoints/health, lift quarantine, move between sub-networks, change rules. |

Identifiers: types are singular snake case, actions are `type.action`, verb bundles `type:verb`.

**Scope types.** `platform` ⊃ `organization` ⊃ `compartment` (sub-network) ⊃ `device_group` / `device`,
plus `own` (resources of the organisation whose owner is the subject). A grant at a scope applies to
everything inside it, as in OCI compartments. Each action lists the scope types it accepts.

**The catalogue** (lives in `console/backend/iam/catalogue.js`; plain-language labels are i18n keys):

| Type | Console name | Scopes | inspect | read (+inspect) | use (+read) | manage (+use) |
|---|---|---|---|---|---|---|
| `device` | Devices | org, compartment, group, device, own | `device.list` | `device.read`, `device.read_config`, `device.read_risk`, `device.read_policy` | `device.update`, `device.operate`, `device.quarantine`, `device.enrol` | `device.create`, `device.configure`, `device.unquarantine`, `device.revoke`, `device.delete` |
| `subnet` | Sub-networks | org, compartment | `subnet.list` | `subnet.read` | — | `subnet.create`, `subnet.update`, `subnet.delete`, `subnet.peer`, `subnet.assign_device` |
| `access_rule` | Access rules | org (compartment in phase 3) | `access_rule.list` | `access_rule.read`, `access_rule.simulate` | — | `access_rule.create`, `access_rule.update`, `access_rule.delete`, `access_rule.set_default`, `access_rule.preview` |
| `policy_test` | Policy tests | org | `policy_test.list` | `policy_test.run` | — | `policy_test.create`, `policy_test.delete` |
| `member` | People | org | `member.list` | `member.read` | — | `member.add`, `member.remove`, `member.set_base_role` |
| `user_account` | Accounts | platform (org in phase 4, owner question) | `user_account.list` | `user_account.read` | — | `user_account.create`, `user_account.update`, `user_account.delete`, `user_account.revoke_sessions` |
| `iam` | Roles and access | org (compartment in phase 3) | `iam.list_roles` | `iam.read_grants` | `iam.grant`, `iam.revoke` | `iam.manage_roles` |
| `enrolment_key` | Enrolment keys | org | `enrolment_key.list` | — | — | `enrolment_key.create`, `enrolment_key.revoke` |
| `gateway` | Profile gateway | org | — | `gateway.read` | — | `gateway.set` |
| `link` | Links with other networks | platform (org in ADR 0031) | `link.list` | `link.read` | — | `link.create`, `link.accept`, `link.revoke` |
| `activity_log` | Activity log | platform, org, own | — | `activity_log.read` | — | `activity_log.verify`, `activity_log.export`, `activity_log.manage_export` |
| `erasure` | Data erasure and legal hold | org | `erasure.list` | — | `erasure.request`, `erasure.reject` | `erasure.approve`, `erasure.hold`, `erasure.release_hold` |
| `organization` | Organisation settings | platform, org | — | `organization.read` | — | `organization.update`, `organization.manage_modules`, `organization.delete`, `organization.create` (platform) |
| `relay` | Relays and transports | platform | `relay.list` | — | `relay.operate` | `relay.create`, `relay.update`, `relay.rotate_credential` |
| `platform_status` | Platform health | platform, org | — | `platform_status.read` | — | `platform_status.verify_recovery` |
| `geofence` | Location rules | platform | — | `geofence.read` | — | `geofence.create`, `geofence.delete` |
| `cloud_pc` | Cloud PC (frozen, ADR 0010) | org, own | `cloud_pc.list` | `cloud_pc.read` | `cloud_pc.operate` | `cloud_pc.create`, `cloud_pc.manage_domains` |
| `emergency` | Emergency wipe | platform | — | `emergency.read` | — | `emergency.manage`, `emergency.trigger` |

**Self-service is not a permission.** Signing in, MFA, `/api/auth/me`, logout, one's own account
(`GET/PUT /api/users/:id` for oneself, quota, revoke own sessions, split tunnelling, onboarding QR),
the root-tier unlock and lock, the personal dead-man switch and self-destruct are always allowed for
the account itself and cannot be granted or taken away. They are listed in the route map with the
marker `self` so the coverage test still accounts for them. Node-authenticated routes (`/v4/control/*`,
including the onion `/circuit`) use node credentials, not console identities, and are marked `node`.

**Field escalation.** Three routes check one base action and a second action only when the body
touches privileged fields. This is the only exception to "one route, one action" and the list is
closed:

| Route | Base action | Escalates to | When |
|---|---|---|---|
| `PUT /api/nodes/:id` | `device.update` | `device.configure` | body has `role`, `latency_ms`, `is_healthy`, `status`, `endpoints` |
| `POST /api/nodes/:id/action` | `device.operate` | — (downgrades to `device.read`) | `action = ping` |
| `POST /api/organizations/:id/members` | `member.add` | `member.set_base_role` + delegation check | `role` other than `member` |

### 2. Every route mapped to one action

`console/backend/iam/routePermissions.js` exports the table below as data
(`{ method, path, action, resource }`). A test builds `createApp()`, walks the router stack
(including module routers mounted by `ModuleLoader`) and fails unless every mounted route appears
exactly once. `/api/audit/*` is the stats router mounted a second time (`server.js:97`); both paths are
listed with the same action. "Today" is who passes now (P platform super-admin, O owner, A admin,
N network_admin, Au auditor, M member, own = only own devices, "any" = any signed-in account,
legacy = `users.role='admin'`, a value no current code writes). Rows marked **unchecked** have no
role check today.

| Route | Action | Today |
|---|---|---|
| `GET /api/health`, `/features`, `/metrics`, `/api/metrics`, canary (3) | public | public |
| `POST /api/auth/register`, `/login`, `/mfa/setup`, `/mfa/verify`, `/refresh`, `/oidc/authorize`, `/oidc/callback`; `/api/auth/browser` (3) | public | public |
| `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/setup-passwords` | self | any |
| `GET /api/users` | `user_account.list` | P |
| `POST /api/users` | `user_account.create` | P |
| `GET /api/users/:id`, `GET /:id/quota`, `GET /:id/onboard-qr` | self or `user_account.read` | self, P |
| `PUT /api/users/:id`, `PUT /:id/split-tunneling` | self or `user_account.update` | self, P |
| `POST /api/users/:id/revoke-sessions` | self or `user_account.revoke_sessions` | self, P |
| `DELETE /api/users/:id` | `user_account.delete` | P |
| `GET /api/organizations` | `organization.read` (list filter) | any (P all, others own) |
| `POST /api/organizations` | `organization.create` | P |
| `GET /api/organizations/:id`, `GET /:id/transports`, `GET /:id/modules` | `organization.read` | any in org |
| `PUT /api/organizations/:id`, `PUT /:id/transports` | `organization.update` | O, A |
| `DELETE /api/organizations/:id` | `organization.delete` | O |
| `PUT /api/organizations/:id/modules/:moduleId` | `organization.manage_modules` | O |
| `GET /api/organizations/:id/members` | `member.list` | **unchecked** (any in org; M3) |
| `POST /api/organizations/:id/members` | `member.add` (+ escalation) | O, A (owner role: O) |
| `PUT /api/organizations/:id/members/:userId` | `member.set_base_role` | O |
| `DELETE /api/organizations/:id/members/:userId` | `member.remove` | O, A (A may remove an owner: gap) |
| `GET /api/nodes` | `device.list` (list filter) | O, A, N, Au org; M own |
| `POST /api/nodes` | `device.create` | **unchecked** (any, auditors included; C1, H3) |
| `GET /api/nodes/:id` | `device.read` | O, A, N, Au org; M own |
| `PUT /api/nodes/:id` | `device.update` (+ escalation) | O, A, N org; M own (H3) |
| `DELETE /api/nodes/:id` | `device.delete` | O, A, N org; M own |
| `POST /api/nodes/:id/revoke` | `device.revoke` | O, A, N org; M own |
| `POST /api/nodes/:id/quarantine` | `device.quarantine` | O, A, N org; M own |
| `POST /api/nodes/:id/unquarantine` | `device.unquarantine` | O, A, N org; M own (H3) |
| `POST /api/nodes/:id/action` | `device.operate` (ping: `device.read`) | O, A, N org; M own |
| `GET /api/nodes/:id/risk` and `/api/risk/:id`, `/api/risk/:id/risk` | `device.read_risk` | O, A, N, Au org; M own |
| `GET /api/risk/scores`, `/dashboard`, `/summary`, `/events`, `/leaderboard` (also under `/api/nodes`) | `device.read_risk` (list filter) | **unchecked** (any in org) |
| `POST /api/configs/generate` | `device.create` | **unchecked** (any) |
| `GET /api/configs/wireguard/:id`, `/noise/:id` | `device.read_config` | own only, P (403 cross-org: gap) |
| `GET /api/stats/native-telemetry`, `/`, `/overview`, `/bandwidth`, `/timeseries`, `/geo`, `/geo-matrix`, `/topology`, `/topology/links` | `device.list` (list filter) | scope filter only |
| `POST /api/stats/topology/reconnect-all` | `relay.operate` | P |
| `POST /api/stats/topology/link` | `device.configure` | O, A, N |
| `GET /api/stats/audit-logs`, `/events`, `/logs` | `activity_log.read` (list filter) | P all; O, A, Au org; others own |
| `GET /api/stats/verify`, `GET/POST /checkpoints` | `activity_log.verify` | P |
| `GET/POST/PUT/DELETE /api/stats/siem[/:id]` | `activity_log.manage_export` | P |
| `GET /api/stats/export` | `activity_log.export` | P |
| `GET /api/stats/recovery-proof/latest`, `GET /ha-leader` | `platform_status.read` | **unchecked** (any; M3) |
| `POST /api/stats/recovery-proof/verify` | `platform_status.verify_recovery` | P (inline) |
| `POST /api/peering/request` | `link.create` | P |
| `POST /api/peering/accept` | `link.accept` | P |
| `GET /api/peering`, `/agreements` | `link.list` | P |
| `GET /api/peering/nodes`, `/:id`, `/agreements/:id` | `link.read` | P |
| `DELETE /api/peering/:id`, `/agreements/:id` | `link.revoke` | P |
| `GET /api/acl/rules` | `access_rule.list` | **unchecked** (any in org; M3) |
| `POST /api/acl/rules` | `access_rule.create` | P, legacy (M4) |
| `PUT /api/acl/rules/:id` | `access_rule.update` | P, legacy |
| `DELETE /api/acl/rules/:id` | `access_rule.delete` | P, legacy |
| `GET /api/acl/default-policy` | `access_rule.read` | **unchecked** (any in org) |
| `PUT /api/acl/default-policy` | `access_rule.set_default` | P, legacy |
| `POST /api/acl/simulate` | `access_rule.simulate` | **unchecked** (any in org) |
| `GET /api/acl/compiled/:nodeId` | `device.read_policy` | O, A, N, Au org; M own |
| `POST /api/acl/preview` | `access_rule.preview` | P, legacy |
| `GET /api/acl/tests`, `POST /tests/run` | `policy_test.list`, `policy_test.run` | **unchecked** (any in org) |
| `POST /api/acl/tests`, `DELETE /tests/:id` | `policy_test.create`, `policy_test.delete` | P, legacy |
| `GET /api/geofencing/policies`, `POST /evaluate` | `geofence.read` | **unchecked** (any) |
| `POST /api/geofencing/policies`, `DELETE /policies/:id` | `geofence.create`, `geofence.delete` | P |
| `POST /api/cloud-pc` (gateway auth, line 13) | public (rate limited) | public |
| `GET /api/cloud-pc`, `GET /custom-domains` | `cloud_pc.list` | **unchecked** (any) |
| `POST /api/cloud-pc`, `POST /custom-domains` | `cloud_pc.create`, `cloud_pc.manage_domains` | **unchecked** |
| `POST /api/cloud-pc/:id/project`, `/:id/teardown` | `cloud_pc.operate` | **unchecked** |
| `POST /api/preauth-keys` | `enrolment_key.create` | O, A, N, M (not Au; M2) |
| `GET /api/preauth-keys` | `enrolment_key.list` | O, A, N, M |
| `DELETE /api/preauth-keys/:id` | `enrolment_key.revoke` | O, A, N, M |
| `GET/POST/PATCH /api/transports/relays[/:relayId]`, `POST /:relayId/rotate-credential` | `relay.list`, `relay.create`, `relay.update`, `relay.rotate_credential` | P |
| `PUT /api/devices/gateway` | `gateway.set` | P, legacy (M4) |
| `POST /api/devices/profile` | `device.enrol` (scope own) | **unchecked** (any in org) |
| `GET /api/compartments`, `GET /peerings/list` | `subnet.list` | any in org |
| `GET /api/compartments/:id` | `subnet.read` | any in org |
| `POST /api/compartments/unlock`, `/lock` | self (root-tier step-up) | any |
| `POST /api/compartments` | `subnet.create` | O, A, N |
| `PUT /api/compartments/:id` | `subnet.update` | O, A, N |
| `DELETE /api/compartments/:id` | `subnet.delete` | O, A |
| `POST /api/compartments/peerings/create`, `DELETE /peerings/:peeringId` | `subnet.peer` | O, A, N |
| `POST /api/compartments/:id/members` | `subnet.assign_device` | O, A, N |
| `GET /api/nuke/state`, `/user/*`, `/personal-dms/*` | self | any |
| `POST /api/nuke/owner-dms/setup`, `/heartbeat` | `emergency.manage` | P |
| `GET /api/nuke/owner-dms/status` | `emergency.read` | P |
| `POST /api/nuke/owner-dms/trigger` | `emergency.trigger` | P |
| `POST /api/nuke/legal-hold` | `erasure.hold` | O, A |
| `DELETE /api/nuke/legal-hold/:id` | `erasure.release_hold` | O |
| `GET /api/nuke/legal-hold`, `GET /dual-auth`, `GET /status` | `erasure.list` | any (service scopes rows) |
| `POST /api/nuke/dual-auth/request` | `erasure.request` | O, A |
| `POST /api/nuke/dual-auth/approve/:id` | `erasure.approve` | O, A (approver ≠ requester, `CryptoShreddingService.js:599`) |
| `POST /api/nuke/dual-auth/reject/:id` | `erasure.reject` | O, A |
| `/v4/control/*`, `/v4/control/circuit` | node | node credential |
| WebSocket topology events (`ws/topologyServer.js:201`) | `device.list` (event filter) | P all; O, A, N, Au org; others own |

The table is reproduced from code reading; the golden table (§11) is the authority. Where it and this
table disagree, the golden table wins and this ADR is corrected.

### 3. Roles, role groups and built-in roles

- A **role** is a named set of permissions (actions or verb bundles), defined per organisation.
- A **role group** (console: "role bundle") is a named set of roles. A bundle contains roles only,
  never other bundles: one level, no cycles, simple to explain.
- **Built-in roles** are defined in code, cannot be edited or deleted, and reproduce today exactly
  (phase 1). They are seeded as rows so grants can reference them, but their permissions are read
  from code only; a trigger refuses permission rows for a built-in role.

Built-in roles at phase 1 (parity; `@own` means scope `own`, otherwise the grant's scope):

| Built-in | Permissions (phase 1, parity) |
|---|---|
| `platform_admin` | every action at scope `platform` (derived from `users.role='super-admin'`) |
| `owner` | every organisation action of every type except platform-only actions |
| `admin` | `owner` minus `organization.delete`, `organization.manage_modules`, `member.set_base_role`, `erasure.release_hold` |
| `network_admin` | `device:manage`, `subnet:manage` minus `subnet.delete`, `device.configure` (topology link), `enrolment_key:manage`, read of organisation, people, rules, tests, risk, erasure list |
| `auditor` | `device:read`, `subnet:read`, `access_rule:read`, `policy_test:read`, `member:inspect`, `organization.read`, `activity_log.read`, `erasure.list`, `device.create` and `device.enrol` (today's unchecked routes; removed in §11) |
| `member` | `device:manage@own` (configure and unquarantine included: H3), `device.read_config@own`, `device.create` at org (unchecked route), `device.enrol@own`, `device.read_risk` at org (dashboards), `subnet:read`, `access_rule:read`, `policy_test:read`, `member:inspect`, `organization.read`, `enrolment_key:manage`, `activity_log.read@own`, `erasure.list`, `cloud_pc:manage`, `platform_status.read`, `geofence.read` |
| `legacy_admin` (virtual) | `access_rule:manage`, `policy_test:manage`, `gateway.set` in the account's organisation, for `users.role='admin'` only; removed in §11 |

Known irregularity to reproduce in phase 1: `device.read_config` (`/api/configs/wireguard|noise/:id`)
is own-device-only for every organisation role today, owners included (`configs.js:177-181`), so every
parity built-in holds it at scope `own` only.

The exact sets are whatever makes the golden table pass; the list above is the starting hypothesis.
After the security phase (§11) the built-ins become the intended model:

| Built-in | Intended (after phase 1-S) |
|---|---|
| `owner` | everything in the organisation |
| `admin` | `owner` minus `organization.delete`, `organization.manage_modules`, `erasure.release_hold`. Because it lacks `organization.delete`, an admin can never grant `owner` (subset rule, D7). |
| `network_admin` | `device:manage`, `subnet:manage` minus `subnet.delete`, `access_rule:manage`, `policy_test:manage`, `enrolment_key:manage`, `gateway:manage`, `member:inspect`, `organization.read`, `activity_log.read` |
| `auditor` | `*:read` on every organisation type, `activity_log.read`, `erasure.list`, `iam.read_grants`. Nothing at use or manage. |
| `member` | `device:use@own`, `device.revoke@own`, `device.delete@own`, `device.read@own` (via use), `activity_log.read@own`, `organization.read` |

**Custom roles** are per organisation, built from the catalogue in the console. A custom role cannot
contain platform-scope actions.

**Base role and extra grants.** Every member keeps exactly one **base role** (today's
`memberships.role`, unchanged column). Additional roles and direct permissions are **grants** on top.
This keeps every existing fixture and the SSO path working: the base role is a grant of a built-in
role at organisation scope, read from `memberships` instead of `iam_grants`.

### 4. Grants

A grant is: **subject** × (**role** or **bundle** or **single action**) × **scope** × optional
**expiry** × **granted by** × **reason**.

- Subject: `user` now; `group` (console group) and `sso_group` are reserved values of
  `subject_type` for phase 3+.
- Scope: `organization`, `own` (phase 2), `compartment`, `device_group`, `device` (phase 3).
- Expiry: optional `expires_at`; an expired grant stops counting at the instant it expires (the
  evaluator filters by time); a sweeper writes one `iam.grant.expired` audit row afterwards.
- Granted by and reason: mandatory (reason 3-500 characters), shown in the explainer.
- Revocation is a soft delete (`revoked_at`, `revoked_by`, `revoke_reason`), so the explainer can say
  "revoked by X on date".
- **No cascade.** Grants belong to the organisation, not to the granter: when an admin leaves, the
  grants they gave stay. The access review (phase 4) lists grants whose granter no longer holds
  what they gave. SQL's `WITH GRANT OPTION` cascade was rejected: removing one departing admin would
  silently strip access from everyone they ever helped.

**Default deny, no explicit deny.** Access exists only when a grant (or the base role) gives it.
There is no configurable deny statement. Three fixed guards always intersect with the grants and no
grant can override them: the **organisation boundary**, the **hidden-tier gate** and, for IAM writes,
the **delegation ceiling** (§5). Reasons: the research's first rule and its documented mistakes 3, 4
and 6 (deny ordering, boundary traps, conditions not narrowing unconditional grants) all come from
deny statements; non-technical administrators cannot reason about allow-minus-deny; an allow-only
union makes the explainer exact ("this grant gives it"). Carve-outs are expressed by scoping grants
to sub-networks instead of granting the organisation and denying a part. Revisit when group subjects
arrive (phase 3+): if a member of a group must be excluded, add GCP-style **exception principals on
the grant**, not a deny policy.

### 5. Delegation without escalation

Model chosen: **holder-ceiling** (an administrator's own effective permissions are their ceiling) plus
an `iam` permission that says whether they may delegate at all. No separate grantable flag, no
separate boundary object.

To create a grant G (subject S, permission set P expanded to actions, scope X), the actor A needs all of:

- **D1 Delegation right:** A holds `iam.grant` at a scope containing X.
- **D2 Subset:** for every action in P, A holds that action at a scope containing X. "You cannot give
  what you do not have."
- **D3 Not oneself:** S ≠ A. Self-changes are allowed only when they strictly reduce (resigning a
  grant, stepping down from a base role while another owner exists).
- **D4 Same organisation:** S has a membership in A's organisation; otherwise 404.
- **D5 Revoking is granting in reverse:** to revoke or change a grant, or change a base role, A must
  be able to create both the grant being removed and the one replacing it. So an admin cannot remove
  or demote an owner (closes the gap found above).
- **D6 Role definitions:** creating or editing a custom role needs `iam.manage_roles` at organisation
  scope, and every action in the new definition must be held by A at organisation scope. Holding a
  permission organisation-wide already covers every narrower scope, so editing a role A holds gives
  A nothing new.
- **D7 Owner by owners:** falls out of D2, because `owner` holds `organization.delete`, which no other
  built-in holds. A test asserts that property of the catalogue.
- **D8 Last owner:** every organisation that is not destroyed keeps at least one owner. Enforced by a
  deferred constraint trigger on `memberships` (fires at commit, so concurrent demotions cannot both
  succeed) and by locking the organisation row (`SELECT … FOR UPDATE`) in every IAM write.
- **D9 SSO cannot hand out power:** a role is SSO-assignable only if it has no `iam.*`,
  `erasure.approve`, `erasure.release_hold`, `organization.delete`, `organization.manage_modules`.

Rejected: a **grantable flag** per grant (two concepts, "hold" and "may pass on", double the UI and
the explainer for no gain over D1); a separate **permission boundary** object (AWS; the research's
boundary traps; D2 already makes the holder's permissions the boundary); Azure-style **conditions on
assignment** (powerful, but too abstract for the target administrators).

**Break-glass.** `POST /api/iam/break-glass` (phase 4): the platform super-admin, after a fresh MFA
step-up (≤ 5 minutes old), with a mandatory reason, receives the `owner` role in one organisation for
at most 240 minutes (`source='break_glass'`, `expires_at` mandatory). It writes a `critical` audit row,
shows a red banner to every member of that organisation while active, and appears first on the
"Who can do what" page. It is also the recovery path if an organisation ever has no owner.

**Separation of duties.**
- Erasure stays dual-control: request and approval by two different people (already enforced,
  `CryptoShreddingService.js:599`), now expressed as two actions (`erasure.request`, `erasure.approve`)
  so an organisation can give them to different roles.
- The activity log is append-only and hash-chained (ADR 0025); no permission can edit it.
  `activity_log.manage_export` (where copies go) stays platform-only.
- Optional organisation policy "strict separation" (phase 4): an auditor role cannot be combined with
  any use or manage action on the same person; the grant is refused.

### 6. Evaluation: one function

```
can(actor: ActorContext, action: string, resource: ResourceRef) -> Decision
listScope(actor: ActorContext, action: string) -> ScopeFilter
```

- `ActorContext = { userId, platformRole, organizationId, tier: 'standard'|'root', grants: Grant[] }`,
  built once per request by `getActorContext(req)`, memoised on `req`. Never cached across requests.
- `ResourceRef = { type, organizationId, compartmentId?, deviceId?, groupIds?, ownerUserId?, hidden }`,
  resolved by the route (one query it already makes). `can` does no I/O; it is a pure function.
- `Decision = { allowed, status: 200|403|404, reason, grant? }`.

Order of evaluation:

1. Self-service actions are decided by the route (`self`), not by `can`.
2. **Organisation boundary:** a resource of another organisation, without a `platform` grant covering
   the action, is **404**.
3. **Hidden gate:** a hidden resource below the root tier is **404**, for everyone, the platform
   super-admin included (today's behaviour).
4. Allowed if any non-expired grant (base role included) gives the action at a scope containing the
   resource.
5. Otherwise: **403** if the actor holds any action of that type at inspect or above in a scope
   containing the resource (they can see it exists); **404** if not. This one rule reproduces
   today's split (auditor mutating a node: 403; member touching someone else's node: 404). Routes whose
   current status differs carry `legacyDenyStatus` in the route map until §11 removes it.

`listScope` returns the SQL-ready filter that list endpoints and the WebSocket event filter use
(`{ all }`, `{ organizationId }`, `{ organizationId, ownerUserId }`, and in phase 3 compartment and
device sets). It replaces `resolveMetricsScope`, `nodeVisibility`'s scope part, `READ_ALL_ROLES`,
`TOPOLOGY_ROLES`, `ORG_WIDE_ROLES`, `ORG_READERS`.

Express adapter: `authorize(action, resolveResource?)`. It replaces both `requireRole`s,
`requireOrgRole`, `requireNotAuditor`, `requireSuperAdmin`, `requireSelfOrAdmin`, `verifyNodeAccess`,
`requireNodeOwnership`, `requireGovernanceRole` and the inline sets. `permissionMatrix.js` is deleted;
`routePermissions.js` is the matrix, and it is enforced.

**Platform super-admin** is a virtual grant of `platform_admin` at scope `platform`, derived from
`users.role='super-admin'` (no data migration). It keeps today's implicit access to every
organisation in phases 1-3. Whether operator access to an organisation should instead require
break-glass is an owner question (see "Questions for the owner").

**Performance.**
- Phase 1: zero extra queries. The actor is built from `req.user`, which SessionAuthority already
  loads (base role, platform role, tier).
- Phase 2: one indexed query per request that authorises, loading the subject's active grants with
  their custom role versions and permissions (`json_agg`), typically fewer than 20 rows. Built-in
  role expansion is a constant in code; custom role expansion is memoised in-process by
  `(role_id, version)`, so a stale definition is impossible (the version comes from the same query).
- Revocation: the next HTTP request (no cross-request cache). WebSocket streams re-check the actor
  when the organisation's `iam_epoch` (bumped by every IAM write) changes; checked at most every
  5 seconds per socket, so a revoked viewer stops receiving events within 5 seconds.
- Budget: `can` under 50 µs for a 50-grant actor (micro-benchmark in the test suite); the grant query
  under 2 ms at p99 on the CI database.

**Audit.** Every IAM write (grant created/revoked/expired, base role changed, role created/edited/
deleted, bundle changed, SSO reconciliation diff, break-glass start/end) writes one audit row with
`metadata: { before, after, reason, delegation: { granter_scope, checked_actions } }` **in the same
transaction** as the change; if the audit row cannot be written, the change is refused.
`AuditChainService.appendEvent` gains an optional `client` argument for this. Denied attempts on
`iam.*` and `erasure.*` are audited (rate-limited to one row per actor per action per minute) as an
escalation signal; other denials are not.

### 7. SSO

- Grants carry `source`: `manual`, `sso`, `break_glass`, `system`. SSO login reconciles only
  `source='sso'` grants and never touches `manual` ones.
- Per organisation, `sso_base_role_authority`: `idp` (today: the IdP sets the base role at every
  login; default for existing organisations, so nothing changes) or `console` (the IdP sets it at the
  first login only; afterwards the console decides). This answers "the next SSO login overwrites a
  manual role": choose `console`, or give the extra power as a manual grant, which SSO never removes.
- Phase 3: `iam_sso_group_mappings (organization_id, idp_group, role_id, scope)` replaces the
  hard-coded `ROLE_HIERARCHY`; only SSO-assignable roles (D9) can be mapped.

### 8. Data model (phase 2: `048_iam_roles_grants.sql`; the owner trigger ships earlier in phase 1-S S8 as `047_memberships_keep_an_owner.sql`; renumber to the next free numbers at implementation)

```sql
CREATE TABLE iam_roles (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = built-in
  key VARCHAR(64) NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name VARCHAR(128) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind VARCHAR(8) NOT NULL DEFAULT 'role' CHECK (kind IN ('role', 'bundle')),
  is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
  sso_assignable BOOLEAN NOT NULL DEFAULT FALSE,
  version INT NOT NULL DEFAULT 1,
  created_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (is_builtin = (organization_id IS NULL))
);
CREATE UNIQUE INDEX iam_roles_key ON iam_roles (COALESCE(organization_id, '*'), key);

CREATE TABLE iam_role_permissions (
  role_id VARCHAR(64) NOT NULL REFERENCES iam_roles(id) ON DELETE CASCADE,
  permission VARCHAR(64) NOT NULL CHECK (permission ~ '^[a-z_]+([.:])[a-z_]+$'),
  PRIMARY KEY (role_id, permission)
);  -- trigger: refuse rows whose role is built-in or a bundle; refuse unknown permissions (catalogue check in service)

CREATE TABLE iam_role_bundle_members (
  bundle_id VARCHAR(64) NOT NULL REFERENCES iam_roles(id) ON DELETE CASCADE,
  role_id VARCHAR(64) NOT NULL REFERENCES iam_roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (bundle_id, role_id)
);  -- trigger: bundle_id must be kind 'bundle', role_id kind 'role', same organisation or built-in

CREATE TABLE iam_grants (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_type VARCHAR(16) NOT NULL CHECK (subject_type IN ('user')),
  subject_id VARCHAR(64) NOT NULL,
  role_id VARCHAR(64) REFERENCES iam_roles(id) ON DELETE RESTRICT,
  permission VARCHAR(64),
  CHECK ((role_id IS NULL) <> (permission IS NULL)),
  scope_type VARCHAR(16) NOT NULL CHECK (scope_type IN ('organization', 'own', 'compartment', 'device_group', 'device')),
  scope_id VARCHAR(64),
  CHECK ((scope_type IN ('organization', 'own')) = (scope_id IS NULL)),
  expires_at TIMESTAMPTZ,
  source VARCHAR(16) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sso', 'break_glass', 'system')),
  CHECK (source <> 'break_glass' OR expires_at IS NOT NULL),
  granted_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason TEXT
);
CREATE UNIQUE INDEX iam_grants_active_unique ON iam_grants
  (organization_id, subject_type, subject_id, COALESCE(role_id, permission), scope_type, COALESCE(scope_id, ''))
  WHERE revoked_at IS NULL;
CREATE INDEX iam_grants_subject ON iam_grants (subject_type, subject_id, organization_id) WHERE revoked_at IS NULL;
CREATE INDEX iam_grants_org ON iam_grants (organization_id) WHERE revoked_at IS NULL;
CREATE INDEX iam_grants_expiry ON iam_grants (expires_at) WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

ALTER TABLE organizations
  ADD COLUMN iam_epoch BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN sso_base_role_authority VARCHAR(8) NOT NULL DEFAULT 'idp'
    CHECK (sso_base_role_authority IN ('idp', 'console'));

-- D8 (shipped by S8 in migration 047): at least one owner per organisation that is not destroyed, checked at commit.
CREATE CONSTRAINT TRIGGER memberships_keep_an_owner
  AFTER UPDATE OR DELETE ON memberships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION iam_assert_owner_remains();

-- Removing a membership (directly, or by deleting the account) revokes every active grant of that
-- person in that organisation, in the same transaction: re-adding them later starts from nothing.
CREATE TRIGGER memberships_revoke_grants AFTER DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION iam_revoke_grants_of_removed_member();
```

`memberships.role` stays as the base role. `users.role` stays as the platform role. Nothing is
backfilled into `iam_grants`; an organisation that never creates a grant behaves exactly as today.

### 9. API (phase 2 unless stated)

| Route | Action | Body / answer |
|---|---|---|
| `GET /api/iam/catalogue` | any member | types, verbs, actions with i18n keys, scope types, built-in roles |
| `GET /api/iam/roles` | `iam.list_roles` | built-in and custom roles with permissions and grant counts |
| `POST /api/iam/roles` | `iam.manage_roles` | `{ key, name, description, kind, permissions?: string[], roles?: string[] }` → 201 role |
| `PUT /api/iam/roles/:id` | `iam.manage_roles` | same + `version` (409 on mismatch) |
| `DELETE /api/iam/roles/:id` | `iam.manage_roles` | 409 `{ error: 'role_in_use', grants: n }` while granted |
| `GET /api/iam/grants?subject_id=&scope_type=&scope_id=` | `iam.read_grants` | active grants; hidden-scope grants omitted below root tier |
| `POST /api/iam/grants` | `iam.grant` | `{ subject: { type: 'user', id }, role_id? , permission?, scope: { type, id? }, expires_at?, reason }` → 201; 403 `{ error: 'exceeds_your_access', missing: [actions] }`; 403 `{ error: 'self_grant' }` |
| `DELETE /api/iam/grants/:id` | `iam.revoke` | `{ reason }` → 200; 403 `exceeds_your_access` (D5) |
| `PUT /api/organizations/:id/members/:userId` | `member.set_base_role` | unchanged route, now runs D2/D3/D5/D8 |
| `GET /api/iam/effective?user_id=&action=&resource_type=&resource_id=` | `iam.read_grants` (self allowed for own id) | `{ allowed, because: [{ grant_id, role, scope, granted_by, granted_at, expires_at }], missing?, closest? }` |
| `GET /api/iam/who-can?action=&resource_type=&resource_id=` | `iam.read_grants` | subjects and the grant giving each |
| `GET /api/auth/me` | self | adds `permissions: Record<action, 'platform'|'organization'|'partial'|'own'>`, `iam_epoch` |
| `POST /api/iam/break-glass` (phase 4) | platform, fresh MFA | `{ organization_id, reason, minutes ≤ 240 }` |

### 10. Console: plain language

**"Who can do what"** page (owner, admin, auditor read-only):
- *People*: one row per person: base role, extra access (chips: "Network admin · Finance · until 10 Dec"),
  who gave it. Button **Give access**.
- *Roles*: built-in roles (locked, with a sentence each: "Network admin: manages devices, sub-networks
  and access rules; cannot manage people") and custom roles. **New role** opens a checklist grouped by
  area (Devices, Sub-networks, Access rules, People, …) with four columns *See / View / Operate /
  Manage* and an "individual actions" expander.
- *History*: every access change with before/after, filterable by person.

**Give access** dialog, five steps on one sheet: *Who* → *What* (a role, a bundle, or one permission)
→ *Where* (Whole organisation / A sub-network / Only their own devices; phase 3 adds groups and single
devices) → *Until* (No end date / a date; extra access suggests 30 days) → *Why* (required). The last
step reads the result back as one sentence: "Anna will be able to operate devices in Finance until
10 December. Given by you: 'covering on-call for Marco'." Anything the administrator cannot give is
shown disabled with "You can't give this because you don't have it yourself."

**Effective access explainer** (from a person's row: "Check what Anna can do"): pick an action and a
target. Answers are one of:
- "Yes. Anna can delete srv-01 because she has *Network admin* for the whole organisation, given by
  Marco on 3 November."
- "No. Nobody gave Anna *delete devices* for sub-network Finance. She can *operate* devices there
  (role Operator, given by Marco)."
- "No. srv-01 belongs to another organisation." is never shown: another organisation's resources are
  not offered as targets. Hidden sub-networks are not offered below the root tier.

**Frontend guard.** `/api/auth/me` returns `permissions`. `roles.ts` keeps its public functions but
`ACCESS` becomes `PAGE_REQUIRES: Record<PageId, Action[]>` (any-of) checked against `permissions`.
Action names are typed by `console/frontend/src/services/permissions.generated.ts`, generated from the
backend catalogue; a backend test fails if the generated file is stale. When `permissions` is absent
(older backend), the console derives it from `role`/`org_role` with the same generated built-in table,
so the existing frontend tests keep passing.

UI work in phases 2-4 loads the project's design skills first (frontend-design, ux-copy,
accessibility-review, design-critique), as the project requires.

### 11. Migration in phases

**Phase 1: one evaluator, today's behaviour (pure refactor).**
1. Catalogue, built-in roles, pure `can`/`listScope`, unit tests.
2. `routePermissions.js` and the coverage test (every mounted route exactly once).
3. **Golden table captured from the current code before any route changes**: every route × fixture
   (P, O, A, N, Au, M on own resource, M on another's resource, account without membership,
   other-organisation owner, legacy `users.role='admin'`, root and standard tier on a hidden device),
   HTTP status recorded into `tests/fixtures/iam_golden_decisions.json` and committed.
4. Route files switched to `authorize()` one file per task; the golden test must stay identical.
5. Old middleware, inline role sets and `permissionMatrix.js` deleted.

**Phase 1-S: security deltas.** Each is one change to a built-in role or the route map, one commit,
and flips only the golden cells it names:

| # | Finding | Change |
|---|---|---|
| S1 | C1 | No membership → no organisation permissions (remove the `member` fallback at `SessionAuthority.js:87`, `rbac.js:37`, `EnrollmentService.js:68`, `DuressService.js:51`). |
| S2 | C1, H3 | `device.create` (`POST /api/nodes`, `/api/configs/generate`) only owner, admin, network_admin. |
| S3 | H3 | `device.configure` and `device.unquarantine` removed from `member@own`. |
| S4 | M2 | `enrolment_key:*` removed from member. |
| S5 | M3 | `member.list`, `access_rule.list/read/simulate`, `policy_test.list/run`, `platform_status.read` removed from member. |
| S6 | — | `device.read_risk` dashboards scoped to own for member. |
| S7 | gap | `member.remove` and `member.set_base_role` run D5: an admin cannot remove or demote an owner. |
| S8 | gap | Last-owner rule moved to the deferred trigger + organisation row lock (D8). |
| S9 | gap | `GET /api/configs/wireguard/:id` cross-organisation answers 404. |
| S10 | — | Auditor loses `device.create`, `device.enrol`. |

Widening changes are **not** in phase 1-S and wait for the owner: S11 (M4) owner/admin/network_admin
manage access rules, policy tests and the gateway of their organisation, replacing `legacy_admin`;
S12 admin may set base roles below their own (subset rule).

**Phase 2: custom roles, bundles and grants (organisation and own scope).** Tables, loader, IAM
service with D1-D9, API, in-transaction audit, SSO `source` and `sso_base_role_authority`,
`/me.permissions`, frontend guard from permissions, "Who can do what" (owners and admins) and the
explainer.

**Phase 3: scopes below the organisation.** `compartment`, `device`, `device_group` (after ADR 0031
creates groups); `listScope` returns compartment and device sets; access rules optionally owned by a
sub-network; SSO group mapping table; group subjects.

**Phase 4: delegation UI and governance.** Scoped administrators use "Give access" within their
scope; break-glass; access review (grants whose granter lost the permission, grants expiring in 7
days, people with no activity in 90 days); organisation policies (maximum duration of extra access,
strict separation); operator-access setting if the owner wants it.

Test files that must stay green, unmodified, at every phase: backend `security_auth_matrix`,
`org_escalation`, `organizations_rbac`, `tenant_isolation`, `tenant_overlay_isolation`,
`risk_tenant_scope`, `ws_topology_scope`, `stats_route_roles`, `stats_scope`, `acl_routes`, `acl_scope`,
`acl_policy_tests`, `m2_engines`, `compartments`, `compartment_isolation`, `compartment_scope`,
`duress_scope`, `session_authority`, `session_families`, `ws_session_authority`, `console_truth_fields`,
`oidc_sso`, `profile_devices`; frontend `RequireRole`, `AclsRoute`, `UsersRoute`, `PeeringRoute`,
`routing`. Exception: a phase 1-S delta may change an assertion in one of these files only when that
assertion encodes the finding being fixed; the commit names the finding and the line.

### 12. Security properties as tests

| # | Invariant | Test |
|---|---|---|
| I1 | No sequence of grants by a non-owner yields a permission the granter lacked at that scope. | Model-based: 10,000 seeded random sequences of create/revoke grant, change base role, edit role, by random actors, against the pure checker and an in-memory reference model; after each accepted step, every grant's actions ⊆ its granter's holdings at creation. |
| I2 | No actor increases their own effective permissions. | Same generator: effective(A) after any step A performs ⊆ effective(A) before. |
| I3 | Revocation takes effect on the next request. | HTTP: grant, use (200), revoke, use again immediately (403/404). No sleep. |
| I4 | Cross-organisation is 404. | Generated from `routePermissions.js`: for every route with a resource, an org-B owner with every permission gets 404 on org-A ids. |
| I5 | An organisation always keeps an owner. | Concurrency test: two parallel demotions of the two owners; exactly one commits. |
| I6 | Hidden stays hidden. | Below root tier, no IAM response (grants, explainer, who-can, catalogue targets) contains a hidden compartment id or a device inside one. |
| I7 | Default deny. | An account with no membership is refused on every non-public, non-self route. |
| I8 | Every IAM write is audited atomically. | Make the audit insert fail: the grant is not written. Every accepted write has exactly one row with before/after. |
| I9 | Monotonic evaluation. | Pure: adding a grant never removes an allowed decision; revoking never adds one. |
| I10 | SSO never touches manual grants. | Login reconciliation with changed IdP groups leaves every `source='manual'` row byte-identical. |
| I11 | Owner is only granted by owners. | Catalogue property: some action is held by `owner` and no other built-in. |

## Options considered

### Option A: OCI verbs over a fixed type list, roles as sets, holder-ceiling delegation (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: one catalogue, one pure function, four tables |
| Cost | Phase 1 ~2 weeks of agent work, mostly mechanical route edits |
| Scalability | One indexed query per request; fine far beyond the target fleets |
| Team familiarity | High: same shapes as today's roles, plus data |

**Pros:** exact parity is provable; administrators learn four words; explainer is exact; delegation
rule is one sentence. **Cons:** verbs are coarse, so a few routes need field escalation; adding an
action to a verb widens custom roles that use the verb (mitigated: catalogue snapshot test, release
notes list every added action).

### Option B: AWS-style JSON policies with explicit deny and conditions

| Dimension | Assessment |
|---|---|
| Complexity | High: a policy language, evaluation order, condition keys |
| Cost | High; editor and validator |
| Scalability | Good |
| Team familiarity | Low for the target administrators |

**Pros:** maximal expressiveness. **Cons:** the research's documented mistakes come from exactly this
(deny ordering, boundary traps); unexplainable to non-technical administrators.

### Option C: Relationship-based (OpenFGA / SpiceDB, Zanzibar)

| Dimension | Assessment |
|---|---|
| Complexity | High: a second datastore or service |
| Cost | Operational (another component; contradicts ADR 0002/0009 minimalism) |
| Scalability | Excellent |
| Team familiarity | Low |

**Pros:** natural for per-object sharing and "everything X can reach". **Cons:** NeroNet's admin
functions are coarse; an extra service for the beta is not justified. Revisit if per-device sharing
across organisations (ADR 0031) grows into a general sharing model.

### Option D: Keep fixed roles, just fix the checks

Cheapest, but does not meet the requirement (custom roles, grants, delegation).

## Trade-off analysis

Option A trades expressiveness for explainability and provable parity. The cases A cannot express
directly (deny a part of a scope; conditions on time of day or posture) are handled by narrower
scopes, expiry, and later by exception principals and posture gates on access rules (ADR 0031), not
by the IAM language. The pure evaluator plus golden table makes the refactor a mechanical,
reviewable change rather than a rewrite of security behaviour in one step.

## Consequences

- Easier: one place to read who can do what; new routes cannot ship without a permission; security
  fixes are data changes with a visible diff; the console stops showing pages the server refuses.
- Harder: every route file is touched in phase 1; the golden table needs care to keep cases
  independent (fresh resources per case).
- To revisit: explicit exception principals when group subjects arrive; operator access requiring
  break-glass; organisation-scoped account management; whether `use` should include enrolment of own
  devices for every member or only with an invitation (ADR 0029).
- Not done by this ADR: closing public registration (C1's other half, an environment switch),
  `max_uses` enforcement (M2's other half), CORS (M1), and the onion circuit organisation filter (H3's
  data-plane half). They are independent fixes in the security review's list.

## Action items

1. [ ] Owner decisions listed under "Questions for the owner".
2. [ ] Phase 1 and 1-S: `piano/PIANO_IAM_NOV10.md` waves 1-5.
3. [ ] Phase 2: same plan, waves 6-9.
4. [ ] Phases 3-4: separate plan after ADR 0031 groups land.

## Questions for the owner

1. Approve the widening deltas S11 (organisation admins manage their own access rules and gateway)
   and S12 (admins set base roles below their own)?
2. Should the platform operator (super-admin) keep silent access to every organisation, or should
   access to an organisation's data require break-glass with a banner the organisation sees?
3. Should organisation owners manage the accounts (create, reset password) of their own people, or
   does that stay with the platform operator?
4. May a member add their own device without an invitation (`device.enrol@own` in the base `member`
   role), or only through an invitation key?
5. Deleting an organisation is one owner's decision today. Should it become dual-control like erasure?
