# ADR 0015: High-risk features are on by default and can be switched off per organisation

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

1. The features above are enabled by default.
2. Each organisation has a profile, `standard` (default) or `regulated`. The `regulated`
   profile switches off the plausible-deniability passwords, the personal dead man's
   switch and the scheduled self-destruct of individual accounts. Organisation-wide
   destruction stays available in that profile, but only with two approvers and only when
   no legal hold is set.
3. The switches are per organisation, enforced on the server, and every change of profile
   is written to the audit log. A client cannot enable a feature the organisation has
   turned off.
4. Onion routing is a mesh-level setting per device and per organisation. The regulated
   profile can require it off or on.

## Consequences

- The feature-flag work package moves ahead of the other organisation features: the
  profile has to exist before a regulated customer is onboarded.
- The features must actually do what they claim before they are offered as active.
  Today NeroNuke deletes rows and provides no cryptographic erasure, and onion routing is
  implemented but not run by any node. Both are on the plan ahead of the compliance work:
  per-organisation encryption keys with key destruction, and circuits carried over the
  overlay.
- Documentation and the console state plainly which features an organisation has
  enabled, and say "not yet implemented" for whatever does not run yet.
- ADR 0006 still holds for the market priorities: single sign-on, roles, audit,
  availability, backup, accessibility and Italian.
