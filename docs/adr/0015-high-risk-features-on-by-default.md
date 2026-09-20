# ADR 0015: High-risk features are working modules, on by default, removable from a build

- Status: Accepted (maintainer's decision, 2026-09-20). Supersedes the feature-flag
  paragraph of [ADR 0006](0006-target-market-banks-and-public-administration.md).
- Date: 2026-09-20
- Decision label: D0 (revision)

## Context

ADR 0006 chose banks and public administration as the target and proposed that the
features built for high-risk users be off by default. The maintainer decided the other
way round: the product keeps them, they are active by default, and an organisation that
cannot hold them, such as a bank with retention duties, switches them off.

The features are:

- NeroNuke: scheduled destruction, the personal dead man's switch, and the owner global
  cascade.
- Plausible-deniability passwords.
- Onion routing on the mesh.

## Decision

1. The features above must work, not only be present. They are on by default.
2. Each of them is a **module** with a hard boundary. The core does not import a module;
   a module registers itself with the core. A module owns its server routes, its
   migrations, its console pages, its node capability, its permissions and its audit
   events, and declares them in a manifest.
3. A module can be removed in two ways:
   - **Per organisation, at run time.** The `regulated` profile switches a module off for
     an organisation. Server-enforced, audited, and a client cannot re-enable it.
   - **From a build.** A regulated build leaves the module out entirely: its server code
     is not loaded, its migrations are not part of the schema, its console pages are not
     in the bundle, and its node code is not compiled (Go build tags). A customer who
     must not have the feature does not receive the code.
4. The modules are: `nuke` (scheduled destruction, personal dead man's switch, owner
   cascade), `deniability` (plausible-deniability passwords) and `onion` (circuit
   construction and cell routing on the node, path selection on the server).
5. Organisation-wide destruction with two approvers and a legal hold is part of the core,
   because a regulated customer needs it; the modules add the unattended and coerced
   variants on top.
6. CI builds and tests the product in both shapes, full and regulated, so removing a
   module can never break the core unnoticed.

## Consequences

- The module boundary is drawn before more code lands in these areas. Moving the existing
  NeroNuke and onion code behind it is the first module work package.
- The features must actually do what they claim before they are offered as active.
  Today NeroNuke deletes rows and provides no cryptographic erasure, and onion routing is
  implemented but not run by any node. Both are on the plan ahead of the compliance work:
  per-organisation encryption keys with key destruction, and circuits carried over the
  overlay.
- Documentation and the console state plainly which features an organisation has
  enabled, and say "not yet implemented" for whatever does not run yet.
- ADR 0006 still holds for the market priorities: single sign-on, roles, audit,
  availability, backup, accessibility and Italian.
