# NeroNet v4 - Compliance Mapping Summary

## DORA (Regulation EU 2022/2554)

| Article | Requirement | NeroNet Implementation |
|---------|-------------|------------------------|
| Art. 5  | ICT Risk Management Framework | RBAC + threat model (WP-101) |
| Art. 9  | Protection and prevention | WireGuard E2E, TLS 1.3, MFA |
| Art. 10 | Detection | Prometheus metrics + HMAC audit log |
| Art. 11 | Response and recovery | HA Patroni + automated backup (WP-307) |
| Art. 13 | ICT testing | Fuzzing (WP-501), load (WP-502), pentest (WP-503) |
| Art. 17 | ICT-related incident reporting | SIEM export, JSON structured logs |
| Art. 19 | Information sharing | Audit log export API |
| Art. 28 | ICT third-party risk | SBOM (WP-504), SLSA provenance |

## NIS2 (Directive EU 2022/2555)

| Measure Category | Implementation |
|-----------------|----------------|
| Risk analysis and information security policies | docs/isms/ |
| Incident handling | 24h audit trail, SIEM integration |
| Business continuity and crisis management | HA cluster + backup + runbooks |
| Supply chain security | SBOM, cosign, SLSA (WP-504) |
| Security in network and information systems | WireGuard, TLS 1.3, zero-trust |
| Policies and procedures for access control | RBAC, OIDC, MFA, session tokens |
| Use of cryptography | AES-256, Noise protocol, BLAKE2s |
| Human resources security and training | Admin guide + operator training (WP-604) |
| Multi-factor authentication | TOTP + hardware key support |

## GDPR (Regulation EU 2016/679)

| Article | Requirement | Implementation |
|---------|-------------|----------------|
| Art. 5  | Data minimization | Minimal node metadata only |
| Art. 17 | Right to erasure | NeroNuke crypto-shredding (WP-302) |
| Art. 20 | Data portability | API export endpoints |
| Art. 25 | Privacy by design | Zero-knowledge relay, no content inspection |
| Art. 32 | Security of processing | AES-256, audit log, access control |
| Art. 33 | Notification of breach | Incident response runbook (WP-604) |

## AgID - Misure Minime di Sicurezza ICT (AGID/ACSC)

| Controllo | Stato |
|-----------|-------|
| ABSC 1 - Inventario dispositivi | Controllo plane con DB nodi |
| ABSC 5 - Configurazione sicura | Hardened containers, no-new-privileges |
| ABSC 6 - Manutenzione / patching | Renovate + SBOM + Cosign |
| ABSC 8 - Difesa malware | Honeypot v2 + tarpit eBPF |
| ABSC 10 - Copie di sicurezza | Backup automatizzato (WP-306) |
| ABSC 13 - Protezione dei dati | Crypto-shredding, AES-256 |
| ABSC 14 - Accesso controllato | RBAC + MFA + OIDC |
