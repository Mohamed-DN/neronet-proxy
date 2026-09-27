# Controls relevant to DORA, NIS2, the GDPR and the AgID measures

No assessment of NeroNet against any of these frameworks has been made, and nothing
here is a claim of conformity. Conformity is a property of an operator's deployment,
processes and organisation, not of a codebase. This page lists the controls in the
code that such an assessment would look at, and states for each whether it exists and
how far it goes, so that an operator can start from facts.

States: **in place** (implemented and covered by tests), **partial** (exists with the
limits given), **missing**.

| Control | State | Notes |
|---|---|---|
| Role-based access control | in place | Platform role plus a per-organisation role (`owner`, `admin`, `network_admin`, `auditor`, `member`) |
| Multi-factor authentication | partial | TOTP. Mandatory only where configured; no hardware keys |
| Single sign-on (OIDC) | partial | Code flow with PKCE, verified ID tokens. No API or console page to configure it; not tested against a production identity provider |
| Tamper-evident audit trail | in place | HMAC chain with a dedicated key and signed checkpoints. The checkpoint public key has to be kept outside the server for the checkpoints to mean anything |
| Audit export to a SIEM | partial | UDP, TCP and webhook sinks. Platform super-admin only, because events are not tagged by organisation |
| Encryption in transit, between nodes | partial | WireGuard. The data plane status is in `docs/HANDBOOK.md` |
| Encryption in transit, to the console and API | missing | Containers serve HTTP; TLS must be terminated in front by the operator |
| Encryption at rest | partial | Organisation secrets are sealed by the application; the rest of the database is left to the operator (volume encryption) |
| Erasure of a user's data | partial | Account self-destruct deletes the account and devices and revokes device keys. Backups and the audit trail keep what they recorded |
| Crypto-shredding | partial | Organisation secrets (identity-provider secrets, TOTP seeds, identity-provider refresh tokens) are sealed with a per-organisation key that a shred destroys; other data is deleted, not encrypted. Pre-shred backups stay readable until the key-encryption key is rotated. The key-encryption key is an environment secret, not a KMS or HSM |
| Backup and restore | partial | A restore verification service and `scripts/dr_backup_recovery_proof.sh` exist. No scheduled backups, no documented procedure |
| High availability | missing | Designed (ADR 0001), not built. Periodic jobs are not yet coordinated across instances |
| Vulnerability management | partial | `govulncheck`, gitleaks and CodeQL in CI. No dependency update automation, no external audit, no penetration test |
| Software bill of materials | partial | Direct dependencies only, not generated from lockfiles |
| Build provenance and signed artefacts | missing | Releases carry SHA-256 checksums only |
| Incident response procedure | missing | |
| Threat model | missing | |
| Accessibility (WCAG 2.1 AA) | missing | Not assessed; see `accessibility-statement.md` |
