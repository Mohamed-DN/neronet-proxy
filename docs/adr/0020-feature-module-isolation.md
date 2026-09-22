# ADR 0020: Feature Module Isolation and Build Profiles

- Status: Accepted
- Date: 2026-09-21
- Decision label: D0, D10

## Context

NeroNet contains high-risk, privacy-centric capabilities designed for investigative journalists, political dissidents, and sovereign operators:
1. **NeroNuke & Cryptographic Destruction** (account self-destruct, dead man's switch, cryptographic shredding).
2. **Plausible Deniability Passwords** (coercion defense passwords yielding decoy sessions).
3. **Onion Routing** (multi-hop layered onion cell routing across the mesh).

Certain institutional deployments (e.g. regulated banks, financial institutions, defense compliance entities) are legally prohibited from running cryptographic self-destruct engines or plausible deniability mechanisms on corporate networks. 

Previously, these features were tightly coupled to the backend monolith (`services/NukeEngine.js`, `routes/nuke.js`, `routes/auth.js`, `services/CircuitEngine.js`). Merely hiding UI elements via CSS or feature flags is insufficient for regulated compliance, as the endpoints, database tables, and binary code remain present.

## Decision

We establish a strict **Module Boundary Architecture**:

1. **Discrete Module Structure (`console/backend/modules/<id>/`)**:
   - Each high-risk capability resides in an isolated directory with a `module.json` manifest.
   - Modules implement a standard lifecycle interface: `register(core)`.
   - The core exposes narrow interfaces (`core.routes.mount`, `core.audit.write`, `core.permissions.declare`, `core.db.migrate`, `core.events`).
   - **Inviolable Invariant**: Core backend code never imports directly from `modules/`. A lint/CI gate asserts this invariant.

2. **Per-Organization Runtime Profiles (`regulated` vs `standard`)**:
   - `organizations.profile` column (`standard` | `regulated`).
   - `organization_modules(organization_id, module_id, enabled)` table.
   - When an organization has profile `regulated` or a module is disabled for that tenant, calls to module endpoints return `404 Not Found` (never 403, preventing existence leaks).

3. **Build-Time Elimination**:
   - **Backend / Environment**: The environment variable `SOVEREIGN_MODULES` dictates loaded modules (e.g. `SOVEREIGN_MODULES=""` launches a completely stripped regulated core). Unlisted modules are never mounted.
   - **Go Node Daemon**: Build tags (`-tags no_neronuke`, `-tags regulated`) compile the node without high-risk symbols and hooks.
   - **Frontend Console**: Module bundle splitting ensures that in regulated editions, high-risk code chunks and assets are not emitted into the production distribution.

## Consequences

- Financial institutions and regulated entities can audit and deploy NeroNet in full compliance with banking standards.
- Sovereign entities and journalists retain full access to high-assurance privacy and anti-coercion tools.
- Modularization improves testability, isolation, and future extensibility.
