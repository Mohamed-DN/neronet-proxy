# ADR 0019: Organizations, Role-Based Access Control (RBAC), and Tenant Isolation

- Status: Accepted
- Date: 2026-09-21
- Decision label: D0, D8

## Context

Previous releases treated the individual `user` as the sole unit of tenancy. Only two roles existed (`super-admin` and `user`). This structure is insufficient for enterprise deployments, banks, and public administration where organizations consist of multiple collaborators with distinct responsibilities (security officers, network administrators, auditors).

Furthermore:
1. Obsolete commercial tier fields and quota endpoints (`GET /api/users/:id/quota`) lingered in code and schemas despite the removal of monetization (ADR 0004).
2. Authorization checks were scattered inconsistently across route handlers.
3. Accessing resources across tenant boundaries must not leak information about resource existence (must return 404 rather than 403 to prevent enumeration).

## Decision

We adopt an enterprise multi-tenant model based on `organizations` and granular Role-Based Access Control (RBAC):

1. **Organization as Primary Tenancy Boundary**:
   - `organizations` table stores tenant entities (`id`, `name`, `slug`, `default_policy`, `max_netmap_staleness_seconds`).
   - `memberships` table binds users to organizations with a specific organizational role.
   - Core tenant-owned resources (`nodes`, `acl_rules`, `preauth_keys`) strictly declare an `organization_id` foreign key.

2. **Role Hierarchy**:
   - **Platform Scope**:
     - `super-admin`: Global infrastructure administration, organization lifecycle, platform telemetry.
   - **Organization Scope** (`memberships.role`):
     - `owner`: Full control of the organization, member management, policy definitions, and cryptographic keys.
     - `admin`: Member invitation, role assignment (below owner), node management, and security controls.
     - `network_admin`: Management of nodes, pre-auth enrollment keys, and ACL rules.
     - `auditor`: Read-only access to topology, nodes, posture reports, and tamper-evident audit logs. Mutating requests are strictly denied (`403 Forbidden`).
     - `member`: Self-service enrollment and viewing of own nodes.

3. **Cross-Tenant Isolation**:
   - Query filters enforce `WHERE organization_id = req.user.organization_id`.
   - Attempting to inspect or modify another tenant's node or resource returns `404 Not Found`, eliminating existence oracle attacks.

4. **Removal of Obsolete Quotas**:
   - `GET /api/users/:id/quota` is retired. Resource limits are determined by infrastructure capacity, not commercial tiers.

## Consequences

- Organizations can manage multiple members with strict separation of duty (e.g. read-only auditors).
- Cross-tenant data leakage is cryptographically and relationally prevented.
- Complete alignment with enterprise compliance requirements (SOC2 / ISO 27001).
