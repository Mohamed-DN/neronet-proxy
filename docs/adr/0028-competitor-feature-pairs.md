# ADR 0028: Competitor feature pairs for the beta

**Status:** Accepted (pair 1 in progress)
**Date:** 2026-11-09
**Deciders:** owner (Mohamed), lead engineer

## Context

The competitor survey (`piano/reports/IDEE-WEB-CONCORRENTI-NOV09.md`) lists 34 ideas from
Tailscale, Headscale, NetBird, Defined/Nebula, innernet, Firezone, Netmaker and Cloudflare
WARP. A survey says what others ship; it does not say what NeroNet lacks. Every idea below
was therefore checked against this tree before being kept, and each is paired with the
idea that shares its code path, so one change set delivers a whole capability instead of
two half-features.

What the code shows today (verified 2026-11-09 at 0ecbc68):

- ACL writes (`console/backend/routes/acl.js:120-276`) validate only role, organisation and
  CIDR syntax. No stored expectation is checked before a rule reaches every node.
  `AclEngine.simulatePacket` (`services/AclEngine.js:479`) evaluates one packet against the
  live rules only; it cannot evaluate a candidate rule set.
- ACL audit rows carry the new values in the message text only; no before/after state
  (`routes/acl.js:129-171`, `utils/audit.js:24-71` accepts `metadata` but no caller passes it
  for ACLs). `PUT /api/users/:id` (`routes/users.js:127-181`) writes no audit row at all.
- Pre-auth keys exist server side, hashed, single-use and expiring
  (`db/migrations/015_node_identity_v2.sql`, `services/PreAuthKeyService.js`,
  `routes/preauthKeys.js`), and the Go node generates its own key and proves possession
  (`pkg/control/client.go:422-450`). No console screen uses them: the "Enroll Node" dialog
  calls `/v4/configs/generate`, which generates the node's private key on the server and
  returns it to the browser (`routes/configs.js:40,154`).
- Nodes report per-peer paths (`peer_paths`, `cmd/sovereign-node/transports.go:90-141`), but
  no backend code reads them; the topology falls back to a hard-coded `'direct'`
  (`routes/stats.js:407`). No node command prints per-peer path or a netcheck report
  (`cmd/sovereign-cli/main.go`).

## Decision

Build the beta's competitive features as four pairs, in this order. A pair is done only
when its external check passes, not when its unit tests are green.

| # | Pair | From | Why paired | External check |
|---|---|---|---|---|
| 1 | **Policy guard**: policy tests checked on every ACL save + before/after audit of every ACL change | Tailscale/Headscale `tests`; Defined audit | Both hook the same five ACL write paths and the same candidate rule set | A save that breaks any stored assertion is refused with the failing list and nothing changes (rules, epoch, audit); a save that passes writes one audit row whose `before`/`after` reproduce the change |
| 2 | **Safe onboarding**: one-time invites in the console + key generated on the node | Headscale pre-auth keys; innernet/Defined | The invite is only safe if the console stops minting private keys | A node joins from one command with an invite; the reused invite is refused; no API response contains a node private key |
| 3 | **Visible path**: backend reads `peer_paths` (direct / relay per peer) + node `netcheck` | Tailscale `status`/`netcheck` | Same data: what the node measured | On the Podman stack with UDP dropped, console shows the pair as DERP within one heartbeat, and netcheck on that node names the relay |
| 4 | **Business access**: OIDC group gate + node expiry tied to the token | Headscale OIDC | Same login path | A user outside the group gets no node; a revoked token drops the node in the stated time |

Later, kept in the plan but not committed for the beta: user-managed peer relay (L),
firewall roles per group, light posture (OS, disk encryption) feeding quarantine.

### Pair 1 design

- Table `acl_policy_tests` (migration 045): `id`, `organization_id` NOT NULL, `source_ip`,
  `destination_ip` (inet), `protocol` (TCP/UDP/ICMP/ALL), `port` 0-65535, `expect`
  (ACCEPT/DROP), `description`, `created_by`, `created_at`.
- `AclEngine.simulatePacket` gains an optional `rules` argument: evaluate a candidate set
  instead of the stored one. Same code path as the simulator, so the guard and the
  simulator can never disagree.
- `services/AclPolicyGuard.js`: `failingTests({ organizationId, rules, defaultPolicy })` and
  `guardChange(change)`, which builds the candidate set for every affected organisation (an
  organisation rule: that organisation; a platform rule: every organisation with tests;
  default policy: that organisation) and returns the failures.
- Every ACL write (create, update, delete, default policy) and every test creation runs
  under one PostgreSQL advisory lock, checks, and writes only when nothing fails. A refused
  save answers `409 { error: "policy_tests_failed", failures: [...] }`.
- Routes `GET/POST /api/acl/tests`, `DELETE /api/acl/tests/:id`, `POST /api/acl/tests/run`.
  Creating a test that the current policy already fails is refused the same way.
- ACL audit rows get `metadata: { before, after }` (null on create/delete side).
- Tests are evaluated with the root access tier: they are statements about the real
  policy, not about what the author can see.

## Options considered

**A. Assertions inside a policy document (Tailscale model).** Requires replacing the
row-per-rule editor with a document editor. Rejected for the beta: large change, and the
console's strength is the per-rule editor and simulator.

**B. Stored assertions checked on every row write (chosen).** Same guarantee at save time,
fits the existing editor and simulator, one table and one service.

**C. Assertions checked only on demand ("run tests" button).** Cheapest, but it does not
stop the lockout or the leak, which is the whole value. Kept as the `/tests/run` route.

## Consequences

- An administrator can no longer save a rule that breaks a stored expectation. A platform
  rule can be refused by an organisation's test; the failure names the organisation.
- ACL writes are serialised by an advisory lock. ACL writes are rare; contention is not a
  concern.
- Rules changed outside these routes (none known today) would bypass the guard.
- Revisit when policies become documents (group-based rules, ADR 0021 follow-ups).
