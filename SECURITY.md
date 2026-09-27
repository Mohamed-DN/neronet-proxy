# Security Policy

## Status

NeroNet is not production software. It has had no external security audit and no
penetration test, and several parts of it are known to be incomplete (see
[`docs/HANDBOOK.md`](docs/HANDBOOK.md), section 6). Do not deploy it to protect
anything that matters until that changes.

Only the `main` branch is maintained. There are no supported releases.

## Reporting a Vulnerability

Do not open a public issue for a vulnerability. Report it privately through GitHub:
the repository's **Security** tab, **Report a vulnerability**.

Include what is affected, how to reproduce it, and what an attacker gains. A
suggested fix is welcome but not required.

Reports are handled by one maintainer, on a best-effort basis. Please allow time for
a fix before disclosing publicly; 90 days is the default we ask for. We will not take
legal action against anyone researching in good faith.

## Scope

In scope:

- The control plane: `console/backend` (API under `/api/` and the node bridge under
  `/v4/control/`)
- The console: `console/frontend`
- The node and data plane: `cmd/`, `pkg/`
- The deployment files in this repository: `docker-compose.yml`, `helm/`, `scripts/`

Out of scope: vulnerabilities in third-party dependencies (report them upstream),
social engineering, physical attacks, and volumetric denial of service.

## What is in place, and what is not

This section describes the code as it is. Where something is missing, it says so.

### Transport

- Between nodes: WireGuard through `wireguard-go` (`pkg/dataplane`). Each peer's
  pre-shared key is rotated from the static X25519 keys (`pkg/crypto/pskepoch`); that
  is classical and adds no post-quantum protection. A post-quantum pre-shared key
  (Rosenpass) is planned, not built.
- Console and API: the containers serve plain HTTP. TLS has to be terminated in front
  of them by the operator. The backend sends HSTS, which browsers only honour over
  HTTPS.
- Nodes to control plane: plain HTTP unless the operator puts TLS in front. An
  internal CA service exists (`InternalCAService`) but nothing serves TLS with it yet.

### Authentication and authorisation

- Console sessions: HS256 JWT access tokens (15 minutes) and single-use refresh tokens
  (7 days), set as HttpOnly cookies and also returned in the response body. A refresh
  re-reads the user's role and status.
- TOTP multi-factor authentication, mandatory only where configured.
- Roles: a platform role (`super-admin` or `user`) and a role within an organisation
  (`owner`, `admin`, `network_admin`, `auditor`, `member`).
- OIDC single sign-on: authorization code flow with PKCE and a nonce, ID tokens
  verified against the provider's published keys. There is no API or console page to
  configure it yet.
- Nodes: enrolment with a shared registration token or a pre-auth key, and a
  challenge that proves possession of the node's key.

### Audit

- An HMAC-SHA256 hash chain over the audit events, keyed with a secret used for
  nothing else, and Ed25519-signed checkpoints of its head. The chain detects edited,
  deleted and inserted events; the checkpoints detect truncation and wholesale
  rewrites, provided the checkpoint public key is recorded somewhere the server cannot
  write.
- Events are not tagged by organisation, so only the platform super-admin can read
  or export the whole ledger.

### Data at rest

- The application does not encrypt data at rest. Encrypting the PostgreSQL volume is
  left to the operator.
- The organisation key service used by NeroNuke (`CryptoShreddingService`) wraps keys
  with a key derived from the JWT secret, and no stored data is encrypted with those
  keys. Destroying them therefore makes no stored data unreadable: there is no
  working crypto-shredding.

### Supply chain

- Releases publish SHA-256 checksums (`scripts/gitops/sign_release_artifacts.sh`).
  They are not signed unless a GPG key is configured, and container images are not
  signed.
- There is no build provenance attestation.
- `scripts/generate_sbom.sh` lists the direct dependencies named in `go.mod` and the
  two `package.json` files. It does not read lockfiles, so transitive dependencies
  and exact resolved versions are missing.
- `scripts/verify_reproducible_build.sh` builds the node twice in one container and
  compares the hashes. That shows the build is deterministic with one toolchain on
  one machine, not that it reproduces elsewhere.
- CI runs `govulncheck`, gitleaks over the history and CodeQL.

## Regulatory frameworks

No assessment against DORA, NIS2, the GDPR or the AgID minimum ICT security measures
has been made, and this project makes no claim of conformity with any of them.
[`compliance/compliance-mapping.md`](compliance/compliance-mapping.md) lists which
relevant controls exist in the code and in what state, as input for an operator's own
assessment.
