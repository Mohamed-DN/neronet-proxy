# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 4.x     | YES (current)      |
| 3.x     | Critical fixes only|
| < 3.0   | No                 |

## Reporting a Vulnerability

**DO NOT** open a public GitHub issue for security vulnerabilities.

### Private Disclosure

Send an encrypted report to: **security@neronet.io**
PGP Key: Available at `/.well-known/pgp-key.txt`

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact assessment
- Your suggested remediation (optional)

### Response Timeline

| Stage                  | Target       |
|------------------------|--------------|
| Acknowledgment         | 24 hours     |
| Initial assessment     | 72 hours     |
| Patch available        | 14 days      |
| Public disclosure      | 90 days      |

We follow **coordinated disclosure**. We will not pursue legal action
against researchers acting in good faith under these guidelines.

## Scope

**In scope:**
- All NeroNet v4 server components (`console/`, `pkg/`, `cmd/`)
- Control plane API (`/api/v4/`)
- WireGuard data plane (`pkg/dataplane/`)
- Authentication & authorization (RBAC, OIDC, JWT)
- Cryptographic implementations

**Out of scope:**
- Third-party dependencies (report to upstream)
- Social engineering
- Physical attacks
- DoS/DDoS without exploitable vulnerability

## Security Architecture

NeroNet v4 implements defense-in-depth:

### Transport Security
- **WireGuard** (Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s) for data plane
- **TLS 1.3** for control plane API with HSTS
- **REALITY camouflage** for active probing resistance

### Authentication
- **RBAC** with `admin`, `operator`, `auditor` roles
- **OIDC/SSO** integration with group mapping
- **JWT** (HS256, 15-minute access tokens, 7-day refresh)
- **MFA** support via TOTP

### Data Protection
- **AES-256-GCM** for data at rest
- **Crypto-shredding** (NeroNuke) for GDPR right-to-erasure
- **HMAC-SHA256** audit log integrity chain

### Supply Chain
- **SLSA v1.0** Build Level 3 provenance
- **Cosign** image signing (keyless via Sigstore)
- **CycloneDX + SPDX SBOM** on every release
- Reproducible builds (SOURCE_DATE_EPOCH, hermetic containers)

## DORA Compliance (EU 2022/2554)

NeroNet v4 addresses DORA requirements:

| Requirement                    | Implementation                                |
|-------------------------------|-----------------------------------------------|
| ICT Risk Management (Art. 5)  | RBAC, audit logs, crypto-shredding            |
| Incident Classification       | Severity matrix in `docs/incident-response.md`|
| Incident Reporting            | SIEM export, Prometheus alerting              |
| Resilience Testing            | WP-501 fuzzing, WP-502 load testing           |
| Third-party Risk              | SBOM + Renovate dependency tracking           |
| Information Sharing           | TLPT-ready audit trail                        |

## NIS2 Compliance (EU 2022/2555)

| Category             | Measure                                     |
|---------------------|---------------------------------------------|
| Policies (Art. 21a)  | ISMS documented in `docs/isms/`             |
| Incident handling    | 24h reporting capability via audit log      |
| Business continuity  | HA Patroni/etcd + automated backup          |
| Supply chain         | SLSA, SBOM, cosign                          |
| Access control       | MFA, RBAC, OIDC, session management         |
| Cryptography         | AES-256, WireGuard, TLS 1.3                 |
| Asset management     | Node inventory in control plane DB          |

## GDPR Compliance (EU 2016/679)

| Requirement              | Implementation                            |
|-------------------------|-------------------------------------------|
| Data minimization        | Only required node metadata stored        |
| Right to erasure         | NeroNuke crypto-shredding (Art. 17)       |
| Data portability         | API export endpoints                      |
| Privacy by design        | Zero-knowledge relay architecture         |
| Audit trail              | HMAC-chained immutable audit log          |
| DPA Agreement            | Template in `docs/compliance/dpa.md`      |

## AgID / ACSC Guidelines

Conformità alle Linee Guida AgID (AGID/ACSC 2023):
- Autenticazione multi-fattore obbligatoria per accessi admin
- Cifratura in transito (TLS 1.3) e a riposo (AES-256)
- Dichiarazione di accessibilità WCAG 2.1 AA: `docs/accessibility-statement.md`
- Log di accesso e audit con integrità crittografica
