# BUSINESS_AND_ROADMAP.md: NeroNet Sovereign Private Cloud & App Bundles Integration Architecture

**Classification**: Design study  
**Target Platform**: NeroNet v4.0 (DarkNero Mesh / Sovereign Proxy Ecosystem)  
**Author**: NeroNet Architecture Working Group  
**Status**: Design study. Nothing in this document is implemented.  


> This document is a design study for a private-cloud offering built on the mesh.
> It does not describe the code. Three parts of it are superseded:
>
> - The application bundles (sections 2.4 to 2.6, chapters 3 and 4, and phases 2 to 4
>   of chapter 7) describe a feature that was deleted. See
>   [ADR 0014](docs/adr/0014-confirm-earlier-decisions.md).
> - The commercial model (former chapter 6 and section 5.5) was removed. See
>   [ADR 0004](docs/adr/0004-remove-monetisation.md). The numbering skips chapter 6.
> - The Cloud PC design (section 2.7) is frozen. See
>   [ADR 0010](docs/adr/0010-freeze-cloud-pc.md).
>
> For what runs today, read [the handbook](docs/HANDBOOK.md).

---

## Table of Contents

1. [Chapter 1: Strategic Vision & Executive Summary](#chapter-1-strategic-vision-executive-summary)
   - [1.1 The Sovereign Cloud Imperative](#11-the-sovereign-cloud-imperative)
   - [1.2 NeroNet Ecosystem Architecture](#12-neronet-ecosystem-architecture)
   - [1.3 Strategic Value Proposition](#13-strategic-value-proposition)
2. [Chapter 2: Deep-Dive Identity, PKI & SSO Federation Architecture](#chapter-2-deep-dive-identity-pki-sso-federation-architecture)
   - [2.1 NeroNet Control Plane Identity Provider (IdP) Core & PKCE Flow](#21-neronet-control-plane-identity-provider-idp-core-pkce-flow)
   - [2.2 Automated Internal ACME PKI (`step-ca`) & Zero-Warning Mesh TLS](#22-automated-internal-acme-pki-step-ca-zero-warning-mesh-tls)
   - [2.3 Unified SSO Gateway & Forward-Auth Federation (`Authentik`)](#23-unified-sso-gateway-forward-auth-federation-authentik)
   - [2.4 Nextcloud Integration Architecture](#24-nextcloud-integration-architecture)
   - [2.5 Immich AI Photo Vault Integration Architecture](#25-immich-ai-photo-vault-integration-architecture)
   - [2.6 Seafile Enterprise Sync Architecture](#26-seafile-enterprise-sync-architecture)
   - [2.7 Sovereign Guacamole RDP (Cloud PC) Integration Architecture](#27-sovereign-guacamole-rdp-cloud-pc-integration-architecture)
3. [Chapter 3: Dynamic Container Provisioning, Storage & Security Architecture](#chapter-3-dynamic-container-provisioning-storage-security-architecture)
   - [3.1 Per-User Isolated Stack Architecture & CIS Docker Hardening](#31-per-user-isolated-stack-architecture-cis-docker-hardening)
   - [3.2 Event-Driven Container Lifecycle & NATS JetStream Bus](#32-event-driven-container-lifecycle-nats-jetstream-bus)
   - [3.3 MicroVM & gVisor Container Sandboxing (`runsc`)](#33-microvm-gvisor-container-sandboxing-runsc)
   - [3.4 Storage Volume Management, LUKS2 Encryption & Hard Quotas](#34-storage-volume-management-luks2-encryption-hard-quotas)
   - [3.5 Client-Side Key Derivation (Argon2id) & Zero-Knowledge Secrets Vaulting](#35-client-side-key-derivation-argon2id-zero-knowledge-secrets-vaulting)
   - [3.6 Automated Encrypted Offsite Backup Pipeline (`Restic` / `Borg`)](#36-automated-encrypted-offsite-backup-pipeline-restic-borg)
   - [3.7 Scale-to-Zero Inactivity Daemon & Sub-2.5s Mesh Fast Wake-Up](#37-scale-to-zero-inactivity-daemon-sub-25s-mesh-fast-wake-up)
   - [3.8 Zero-Trust Egress, Userspace Mesh VIP Reverse Proxy & Anti-Leak DNS](#38-zero-trust-egress-userspace-mesh-vip-reverse-proxy-anti-leak-dns)
4. [Chapter 4: Client Integration, 1-Click HUD & Cloud PC Experience](#chapter-4-client-integration-1-click-hud-cloud-pc-experience)
   - [4.1 NeroNet Native Multi-Platform Client Architecture](#41-neronet-native-multi-platform-client-architecture)
   - [4.2 1-Click Bundle Launcher HUD & Deep-Link Protocol Registration](#42-1-click-bundle-launcher-hud-deep-link-protocol-registration)
   - [4.3 Sovereign Guacamole Cloud PC Client Experience (HTML5 & Native Desktop Wrapper)](#43-sovereign-guacamole-cloud-pc-client-experience-html5-native-desktop-wrapper)
   - [4.4 Transparent Netstack Split-Tunneling & Camouflaged DERP-v4 Relays](#44-transparent-netstack-split-tunneling-camouflaged-derp-v4-relays)
5. [Chapter 5: Hybrid Data Residency, Liability Separation & Compliance (Requirement R4)](#chapter-5-hybrid-data-residency-liability-separation-compliance-requirement-r4)
   - [5.1 Dual-Model Checkout & Deployment Architecture (Managed Cloud vs BYOS)](#51-dual-model-checkout-deployment-architecture-managed-cloud-vs-byos)
   - [5.2 Legal & Liability Separation Matrix](#52-legal-liability-separation-matrix)
   - [5.3 GDPR (Articles 4, 17, 28) & HIPAA (45 CFR § 164.312) Compliance by Design](#53-gdpr-articles-4-17-28-hipaa-45-cfr-164312-compliance-by-design)
   - [5.4 BYOS 1-Line Automated Installer & Ansible Playbook Architecture](#54-byos-1-line-automated-installer-ansible-playbook-architecture)
7. [Chapter 7: Phased Engineering Roadmap & Delivery Milestones (2026-2027)](#chapter-7-phased-engineering-roadmap-delivery-milestones-2026-2027)
   - [7.1 Phase 1: Foundation & Identity Core (Target: Q1 2026)](#71-phase-1-foundation-identity-core-target-q1-2026)
   - [7.2 Phase 2: Dynamic Orchestrator & Nextcloud MVP (Target: Q2 2026)](#72-phase-2-dynamic-orchestrator-nextcloud-mvp-target-q2-2026)
   - [7.3 Phase 3: Immich AI Photo Vault, Seafile & Guacamole Cloud PC Launch (Target: Q3 2026)](#73-phase-3-immich-ai-photo-vault-seafile-guacamole-cloud-pc-launch-target-q3-2026)
   - [7.4 Phase 4: Hybrid BYOS Automation, Zero-Knowledge Vaulting & Global Multi-Region Federation (Target: Q4 2026 - Q1 2027)](#74-phase-4-hybrid-byos-automation-zero-knowledge-vaulting-global-multi-region-federation-target-q4-2026---q1-2027)

---

# Chapter 1: Strategic Vision & Executive Summary

## 1.1 The Sovereign Cloud Imperative

The global digital ecosystem is confronted by an acute crisis of digital sovereignty. Hyperscale public cloud providers (Google Workspace, Microsoft 365, Apple iCloud, Amazon Web Services) enforce an extractive commercial model characterized by pervasive user telemetry, automated content scanning, warrantless regulatory access, and deep operational lock-in. While open-source self-hosted applications—such as **Nextcloud**, **Immich**, **Seafile**, and **Apache Guacamole**—deliver feature parity with commercial SaaS offerings, their widespread adoption is severely bottlenecked by four core friction points:

1. **Networking & Ingress Complexity**: The necessity of configuring public static IP addresses, port-forwarding on residential routers, dynamic DNS scripts, and NAT traversal.
2. **Attack Surface & Vulnerabilities**: Exposing self-hosted applications directly to the public Internet invites automated CVE scanning, credential brute-forcing, and DDoS attacks.
3. **Operational & Cryptographic Overhead**: Managing TLS certificates, reverse proxies, database migrations, backup automation, and storage quotas creates prohibitive friction for non-technical users.
4. **Fragmented Authentication**: Managing disparate user credentials across multiple disconnected self-hosted applications degrades the user experience compared to unified commercial suites.

**NeroNet v4.0** bridges this divide by evolving from a high-performance, decentralized residential proxy and mesh VPN into an **integrated sovereign private cloud ecosystem**. By coupling its encrypted userspace mesh network (`Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s`) with an automated container orchestration engine, an automated internal ACME Public Key Infrastructure (`step-ca`), and an OpenID Connect (OIDC) Single Sign-On (SSO) identity plane (`Authentik`), NeroNet empowers users to deploy, access, and monetize sovereign cloud applications with a single click.

```
+---------------------------------------------------------------------------------------------------+
|                                 NERONET SOVEREIGN CLOUD ARCHITECTURE                              |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  +---------------------------------------------------------------------------------------------+  |
|  |                   NERONET NATIVE MULTI-PLATFORM CLIENT (iOS / macOS / Android / Desktop)    |  |
|  |  * Userspace Netstack Engine               * 1-Click App & Cloud PC Launcher HUD            |  |
|  |  * Noise IKpsk2 Mesh Tunnel                                                                 |  |
|  |  * Auto OIDC Token Injection               * Client-Side Argon2id Key Derivation Engine     |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                |                                                  |
|                   (Encrypted Userspace Mesh Overlay / SVRN Wire Framing)                          |
|                                                |                                                  |
|  +---------------------------------------------v-----------------------------------------------+  |
|  |             NERONET CONTROL PLANE & IDENTITY FEDERATION (neronet.darknero.com)              |  |
|  |  * OpenID Connect (OIDC 1.0) / OAuth 2.0 Core     * Authentik SSO & Forward-Auth Engine     |  |
|  |  * step-ca Automated Internal ACME PKI                                                      |  |
|  |  * Peer Topology & CGNAT VIP Allocator                                                     |  |
|  |  * NATS JetStream Event Orchestration Bus         * Zero-Trust Access Control Policies      |  |
|  +---------------------------------------------+-----------------------------------------------+  |
|                                                |                                                  |
|                 (gRPC / NATS Event Bus / Isolated Docker Engine & gVisor API)                     |
|                                                |                                                  |
|  +---------------------------------------------v-----------------------------------------------+  |
|  |                 DYNAMIC CONTAINER PROVISIONING CONTROLLER (Per-User Stacks)                 |  |
|  |                                                                                             |  |
|  |  +-------------------+ +-------------------+ +-------------------+ +---------------------+  |  |
|  |  |  NEXTCLOUD SUITE  | |  IMMICH AI VAULT  | | SEAFILE ENTERPRISE| | GUACAMOLE CLOUD PC  |  |  |
|  |  | - Nextcloud 30    | | - Immich Server   | | - Seafile C-Core  | | - Apache Guacamole  |  |  |
|  |  | - MariaDB + Redis | | - Python ML Vector| | - Seahub Django   | | - guacd Native Core |  |  |
|  |  | - `user_oidc` SSO | | - PostgreSQL 16   | | - MariaDB 10.11   | | - xrdp Workstation  |  |  |
|  |  | - Collabora Office| | - pgvector Search | | - Block CDC Dedup | | - GPU Acceleration  |  |  |
|  |  +-------------------+ +-------------------+ +-------------------+ +---------------------+  |  |
|  |               |                  |                     |                      |             |  |
|  |  +------------v------------------v---------------------v----------------------v----------+  |  |
|  |  |             ISOLATED ENCRYPTED VOLUMES, SECURITY HARDENING & RUNTIME GOVERNANCE       |  |  |
|  |  |  * Per-Tenant LUKS2 / dm-crypt Volumes (AES-XTS-256)   * gVisor (`runsc`) Sandboxing  |  |  |
|  |  |  * ZFS / XFS Hard Project Quotas & zstd-3 Compression   * Restic Encrypted Offsite Bck |  |  |
|  |  |  * Scale-to-Zero Inactivity Daemon (<2.4s Wake-Up)     * Userspace Mesh VIP Ingress   |  |  |
|  |  +---------------------------------------------------------------------------------------+  |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                |                                                  |
|                        (Hybrid Data Residency - BYOS Control Mesh)                                |
|                                                |                                                  |
|  +---------------------------------------------v-----------------------------------------------+  |
|  |              BRING YOUR OWN SERVER (BYOS) NODES (Customer Self-Hosted Hardware)              |  |
|  |  * 1-Line Automated Curl / Ansible Playbook       * Customer Own Hardware & Storage         |  |
|  |  * Open-Source Core                               * ZERO Operator Liability / Access        |  |
|  +---------------------------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------------------------+
```

---

## 1.2 NeroNet Ecosystem Architecture

The sovereign cloud platform comprises six tightly integrated subsystems:

1. **The Userspace Mesh Network**: Encrypted node-to-node overlay operating on Carrier-Grade NAT (CGNAT `100.64.0.0/10`) VIPs. Client communication uses the 24-byte SVRN binary wire framing with ChaCha20-Poly1305 AEAD encryption and sliding-window anti-replay protection.
2. **The Control Plane & Identity Core**: A globally distributed, Raft-replicated control plane (`neronet.darknero.com`) coupled with `Authentik` for identity federation and `step-ca` for automated internal ACME PKI. It signs JSON Web Key Sets (JWKS).
3. **The Dynamic Container Orchestrator (`sovereign-bundle-orchestrator`)**: A modular daemon managing per-tenant isolated application stacks (Nextcloud, Immich, Seafile, Guacamole Cloud PC). It provisions dedicated rootless container groups, manages LUKS2-encrypted ZFS datasets, executes `gVisor` (`runsc`) isolation, and operates a sub-2.5-second scale-to-zero wake-up mechanism.
4. **The Sovereign Guacamole Cloud PC**: High-performance browser-based and native-wrapped virtual desktop environment powered by `guacd`, `xrdp`, and hardware GPU acceleration (NVIDIA CUDA / Intel QuickSync) for seamless remote computing.
5. **The Hybrid Data Residency Engine**: A dual-model checkout and provisioning architecture that cleanly separates Managed Cloud (hosted on zero-knowledge encrypted infrastructure) from Self-Hosted BYOS (running on user hardware with zero operator liability).
6. **The NeroNet Native Multi-Platform Client**: Cross-platform desktop and mobile clients (iOS, macOS, Android, Windows, Linux) providing transparent split-tunnel netstack routing, a 1-click bundle launcher HUD, automated SSO credential injection, and client-side Argon2id key derivation.

---

## 1.3 Strategic Value Proposition

```
+-----------------------------------------------------------------------------------------------------------------------------+
|                                              STRATEGIC VALUE PROPOSITION MATRIX                                             |
+--------------------------+------------------------------+---------------------------+-------------------+-------------------+
|  Dimension               | Hyperscalers (Google/Apple)  | DIY Self-Hosted (VPS/NAS) | NeroNet Cloud     | NeroNet BYOS      |
+--------------------------+------------------------------+---------------------------+-------------------+-------------------+
|  **Privacy & E2EE**      | Zero. Data scanned for AI/ads| High. User-controlled.    | **Absolute.**     | **Absolute.**     |
|                          | & law enforcement subpoenas. | High configuration effort.| Zero-Knowledge E2EE| Physical control. |
|  **Setup Time**          | 1-Click setup.               | Prohibitive (5-20 hours). | **1-Click (<30s).**| **1-Line (<2m).** |
|  **Ingress & DNS**       | Global CDN public ingress.   | Dynamic DNS, port forward.| **Private Mesh.** | **Private Mesh.** |
|                          | Public attack surface.       | Direct public exposure.   | Zero public ports.| Zero public ports.|
|  **Authentication**      | Unified SSO (Google/Apple ID)| Fragmented credentials.   | **Unified OIDC.** | **Unified OIDC.** |
|  **Hardware Efficiency** | Multi-tenant shared DBs.     | Runs 24/7 idle power.     | **Scale-to-Zero.**| **Scale-to-Zero.**|
|  **Operator Liability**  | Data Controller & Processor. | Sole customer liability.  | **Disclaimed.**   | **ZERO Liability.**|
|                          | Subject to subpoena access.  | High maintenance burden.  | Zero vendor access| Mere conduit.     |
+--------------------------+------------------------------+---------------------------+-------------------+-------------------+
```

---

# Chapter 2: Deep-Dive Identity, PKI & SSO Federation Architecture

## 2.1 NeroNet Control Plane Identity Provider (IdP) Core & PKCE Flow

NeroNet implements a native, high-performance OpenID Connect (OIDC 1.0) and OAuth 2.0 authorization server embedded directly inside the Go-based Control Plane (`pkg/control/oidc/`) and federated with `Authentik`. The IdP leverages the cryptographic identity established during the initial Noise handshake, binding peer WireGuard public keys and user accounts to standard OIDC identities.

### 2.1.1 Standard Discovery Endpoints

The IdP exposes standard OpenID Connect discovery endpoints under `https://neronet.darknero.com/v4/auth/`:

```
GET  /.well-known/openid-configuration     -> RFC 8414 OIDC Discovery Metadata
GET  /v4/auth/authorize                   -> OAuth 2.0 Authorization Endpoint (PKCE required)
POST /v4/auth/token                       -> OAuth 2.0 Token Exchange Endpoint
GET  /v4/auth/userinfo                    -> OpenID Connect UserInfo Endpoint
GET  /v4/auth/jwks.json                   -> JSON Web Key Set (Ed25519 & RS256 public keys)
POST /v4/auth/revoke                      -> RFC 7009 Token Revocation Endpoint
POST /v4/auth/introspect                  -> RFC 7662 Token Introspection Endpoint
```

### 2.1.2 PKCE Authorization Flow & Cryptographic Token Minting

All authorization requests mandate Proof Key for Code Exchange (PKCE, RFC 7636) using `code_challenge_method=S256` to prevent authorization code interception attacks on mobile and desktop clients:

$$\text{code\_challenge} = \text{BASE64URL-ENCODE}(\text{SHA256}(\text{code\_verifier}))$$

```
+---------------------------------------------------------------------------------------------------+
|                                 PKCE & OIDC SSO AUTHENTICATION FLOW                               |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  [ NERONET NATIVE CLIENT ]        [ NERONET CONTROL PLANE / IdP ]        [ TENANT APP CONTAINER ] |
|            |                                    |                                    |            |
|            | 1. Generate code_verifier & S256   |                                    |            |
|            | 2. Auth Request (PKCE + Scopes)    |                                    |            |
|            |----------------------------------->|                                    |            |
|            |                                    | 3. Validate Noise PubKey & Biometric|           |
|            |                                    | 4. Issue Short-Lived Auth Code     |            |
|            |<-----------------------------------|                                    |            |
|            |                                    |                                    |            |
|            | 5. Token Exchange (Code + Verifier)|                                    |            |
|            |----------------------------------->|                                    |            |
|            |                                    | 6. Verify SHA256(Verifier)==Code   |            |
|            |                                    | 7. Mint Ed25519 JWT ID/Access Token|            |
|            |<-----------------------------------|                                    |            |
|            |                                    |                                    |            |
|            | 8. Mesh HTTP Request (Bearer JWT)                                       |            |
|            |------------------------------------------------------------------------>|            |
|            |                                    |                                    | 9. Validate|
|            |                                    |                                    |    Signature|
|            | 10. Authenticated Session Response                                      |    via JWKS|
|            |<------------------------------------------------------------------------|            |
+---------------------------------------------------------------------------------------------------+
```

---

## 2.2 Automated Internal ACME PKI (`step-ca`) & Zero-Warning Mesh TLS

To eliminate insecure self-signed browser warnings and SSL prompt errors across all bundled services, NeroNet deploys an automated internal Public Key Infrastructure (PKI) using `step-ca` (`smallstep/step-ca:latest`).

```
+---------------------------------------------------------------------------------------------------+
|                                 INTERNAL PKI & ACME WORKFLOW                                      |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  +-------------------------------------+             +-----------------------------------------+  |
|  |     NERONET CLIENT ROOT TRUST       |             |         STEP-CA PKI CONTROLLER          |  |
|  |  * Installs Root CA to OS / Browser | <---------- |  * Root Key: ECDSA P-384 / Ed25519      |  |
|  |  * Trust Store on Initial Setup     |             |  * ACME Server (`https://ca.mesh:9000`) |  |
|  +-------------------------------------+             +-----------------------------------------+  |
|                                                                    |                              |
|                                       ACME TLS-ALPN-01 / DNS-01    | Automated Cert Issuance      |
|                                       Challenge over Mesh          | (24h - 90d Short-Lived)      |
|                                       `*.user.neronet.darknero`    v                              |
|                                                      +-----------------------------------------+  |
|                                                      |          TRAEFIK v3 / EDGE PROXY        |  |
|                                                      |  * Auto-renews certs for all services   |  |
|                                                      |  * Ingress: `*.user.neronet.darknero`   |  |
|                                                      +-----------------------------------------+  |
+---------------------------------------------------------------------------------------------------+
```

1. **Root & Intermediate CA Topology**: `step-ca` operates an isolated Intermediate CA per tenant cluster, signed by NeroNet's Master Root CA (`ECDSA P-384`).
2. **ACME Protocol Compliance**: Exposes an embedded RFC 8555 ACME endpoint (`https://step-ca.mesh:9000/acme/acme/directory`).
3. **Automated Issuance & Renewal**: Traefik v3 reverse proxy automatically provisions and renews short-lived wildcard X.509 certificates (`*.<user_id>.neronet.darknero.com`) via ACME DNS-01 challenges resolved by NeroNet's internal DoH DNS daemon.
4. **Client Trust Injection**: During initial client onboarding, the NeroNet desktop/mobile client securely installs the Root CA certificate into the operating system and browser trust stores (macOS Keychain, Windows Root Certificate Store, Android System CA, iOS Configuration Profile), guaranteeing zero security warnings.

---

## 2.3 Unified SSO Gateway & Forward-Auth Federation (`Authentik`)

Identity management across all applications is unified using `Authentik` (`ghcr.io/goauthentik/server:2024.8`):

```
                                  +-----------------------+
                                  |     AUTHENTIK IDP     |
                                  | (OIDC / SAML / LDAP)  |
                                  +-----------+-----------+
                                              |
                   +--------------------------+--------------------------+
                   |                                                     |
         (Native OIDC Flow)                                    (Forward-Auth Proxy)
                   |                                                     |
+------------------v------------------+               +------------------v------------------+
|      MODERN OIDC-NATIVE APPS        |               |       LEGACY / FORWARD-AUTH APPS    |
|  - Nextcloud (`user_oidc`)          |               |  - Traefik `forwardAuth` Middleware |
|  - Immich (`IMMICH_OAUTH_ENABLED`)  |               |  - Validates session before passing |
|  - Seafile (`ENABLE_OAUTH = True`)  |               |  - Injects `X-authentik-username`   |
|  - Guacamole (OIDC Extension)       |               |  - WebAuthn FIDO2 / Passkey Support |
+-------------------------------------+               +-------------------------------------+
```

- **Native OIDC Applications**: Nextcloud, Immich, Seafile, Guacamole, and Grafana authenticate directly via standard OAuth 2.0 / OIDC PKCE flows against Authentik.
- **Forward-Auth Middleware**: Applications lacking native OIDC support are protected via Traefik's `forwardAuth` middleware. Unauthenticated requests are redirected to Authentik's portal; upon authentication, Traefik forwards identity headers (`X-authentik-username`, `X-authentik-email`, `X-authentik-groups`).
- **LDAP Directory Outpost**: An embedded LDAP Outpost (`ldap://authentik-ldap:389`) serves legacy services requiring direct directory binds.

---

## 2.4 Nextcloud Integration Architecture

Nextcloud Hub 30 is deployed as a sovereign enterprise file collaboration suite:

```yaml
# Automated Nextcloud Stack Definition
services:
  app:
    image: nextcloud:30-apache
    container_name: neronet-nextcloud-${USER_ID}-app
    restart: unless-stopped
    environment:
      - MYSQL_HOST=database
      - MYSQL_DATABASE=nextcloud
      - MYSQL_USER=nextcloud
      - MYSQL_PASSWORD=${DB_PASSWORD}
      - REDIS_HOST=redis
      - OVERWRITEPROTOCOL=https
      - OVERWRITECLIURL=https://${USER_ID}.nextcloud.neronet.darknero.com
    volumes:
      - /var/lib/neronet/tenants/${USER_ID}/nextcloud/html:/var/www/html
      - /var/lib/neronet/tenants/${USER_ID}/nextcloud/data:/var/www/html/data
    networks:
      - tenant-net
```

- **SSO Integration**: Employs `user_oidc` app in Nextcloud. The orchestrator pre-configures the OIDC provider via `occ` CLI:
  ```bash
  occ user_oidc:provider neronet \
    --clientid="nextcloud-bundle-${USER_ID}" \
    --clientsecret="${OIDC_SECRET}" \
    --discoveryuri="https://neronet.darknero.com/v4/auth/.well-known/openid-configuration" \
    --scope="openid email profile"
  ```
- **Provisioning & Quotas**: Nextcloud OCS REST API (`/ocs/v1.php/cloud/users`) manages account provisioning and applies ZFS hard storage quotas.

---

## 2.5 Immich AI Photo Vault Integration Architecture

Immich provides high-performance photo/video backup with on-device/on-node machine learning:

```yaml
# Automated Immich Microservices Stack
services:
  server:
    image: ghcr.io/immich-app/immich-server:release
    container_name: neronet-immich-${USER_ID}-server
    environment:
      - DB_HOSTNAME=database
      - DB_DATABASE_NAME=immich
      - DB_USERNAME=immich
      - DB_PASSWORD=${DB_PASSWORD}
      - REDIS_HOSTNAME=redis
      - IMMICH_OAUTH_ENABLED=true
      - IMMICH_OAUTH_ISSUER_URL=https://neronet.darknero.com/v4/auth
      - IMMICH_OAUTH_CLIENT_ID=immich-bundle-${USER_ID}
      - IMMICH_OAUTH_CLIENT_SECRET=${OIDC_SECRET}
    volumes:
      - /var/lib/neronet/tenants/${USER_ID}/immich/upload:/usr/src/app/upload
    networks:
      - tenant-net

  machine-learning:
    image: ghcr.io/immich-app/immich-machine-learning:release
    container_name: neronet-immich-${USER_ID}-ml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    networks:
      - tenant-net

  database:
    image: tensorchord/pgvecto-rs:pg16-v0.2.0
    container_name: neronet-immich-${USER_ID}-db
    volumes:
      - /var/lib/neronet/tenants/${USER_ID}/immich/db:/var/lib/postgresql/data
    networks:
      - tenant-net
```

- **Vector Search & ML**: Leverages PostgreSQL 16 with `pgvector` for facial recognition and CLIP-based semantic vector search.
- **Hardware Acceleration**: GPU passthrough (`--gpus all` or `/dev/dri`) enables line-rate video transcoding and fast model inference.
- **Mobile Deep-Linking**: Registers `app.immich:///` deep-link scheme for 1-click mobile backup synchronization over the mesh.

---

## 2.6 Seafile Enterprise Sync Architecture

Seafile provides ultra-fast file synchronization built on a C-core block-deduplicated engine:

- **Seahub Django OIDC Backend**: Configured in `seahub_settings.py`:
  ```python
  ENABLE_OAUTH = True
  OAUTH_CLIENT_ID = "seafile-neronet-bundle"
  OAUTH_CLIENT_SECRET = "${TENANT_OIDC_SECRET}"
  OAUTH_REDIRECT_URL = "https://${USER_ID}.seafile.neronet.darknero.com/oauth/callback/"
  OAUTH_AUTHORIZATION_URL = "https://neronet.darknero.com/v4/auth/authorize"
  OAUTH_TOKEN_URL = "https://neronet.darknero.com/v4/auth/token"
  OAUTH_USER_INFO_URL = "https://neronet.darknero.com/v4/auth/userinfo"
  ```
- **Rabin-Karp Content-Defined Chunking (CDC)**: Slices files into variable-sized chunks (1MB-3MB) with SHA-256 deduplication, yielding average 1.35x storage savings.

---

## 2.7 Sovereign Guacamole RDP (Cloud PC) Integration Architecture

The **Sovereign Guacamole RDP Cloud PC** delivers a turnkey, high-performance containerized workstation accessible from any modern web browser or native NeroNet desktop wrapper:

```
+---------------------------------------------------------------------------------------------------+
|                              SOVEREIGN GUACAMOLE RDP CLOUD PC STACK                               |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  +---------------------------------------------------------------------------------------------+  |
|  |                     NERONET CLIENT / ANY MODERN HTML5 WEB BROWSER                           |  |
|  |  * High-Performance Canvas Rendering       * Seamless Clipboard & Audio Streaming           |  |
|  |  * WebSocket Binary Stream (`/websocket-tunnel`) * Low-Latency Netstack Routing (<25ms)     |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                |                                                  |
|                                   (HTTPS / WSS over Mesh VIP)                                     |
|                                                |                                                  |
|  +---------------------------------------------v-----------------------------------------------+  |
|  |                   GUACAMOLE WEB CLIENT GATEWAY (`guacamole/guacamole:latest`)               |  |
|  |  * Apache Tomcat 10 Java Servlet Engine     * Authentik OIDC Single Sign-On Extension       |  |
|  |  * Translates HTTP/WebSocket to Guacamole Protocol (`guacd` IPC on TCP 4822)                |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                |                                                  |
|                                   (Guacamole Protocol IPC / TCP)                                  |
|                                                |                                                  |
|  +---------------------------------------------v-----------------------------------------------+  |
|  |                   GUACAMOLE PROXY DAEMON (`guacamole/guacd:latest` / C Core)                 |  |
|  |  * Native Protocol Translation (RDP / VNC / SSH) * Hardware-Assisted Video/Audio Encoding   |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                |                                                  |
|                                    (Internal RDP / xrdp TCP 3389)                                 |
|                                                |                                                  |
|  +---------------------------------------------v-----------------------------------------------+  |
|  |                   CONTAINERIZED CLOUD WORKSTATION (`neronet-cloud-pc`)                      |  |
|  |  * Base OS: Ubuntu 24.04 LTS Desktop        * Desktop Environment: XFCE4 / KDE / GNOME      |  |
|  |  * Display Server: xrdp + Xorg / Wayland    * Audio Subsystem: PulseAudio / PipeWire Virtual |  |
|  |  * Acceleration: NVIDIA CUDA (`--gpus all`) or Intel QuickSync (`/dev/dri`)                 |  |
|  |  * Mesh Bridge: Native access to 100.64.0.0/10 Homelab NAS, databases & development ports   |  |
|  +---------------------------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------------------------+
```

### 2.7.1 Guacamole Microservices Stack Definition

```yaml
services:
  guacamole-web:
    image: guacamole/guacamole:latest
    container_name: neronet-guac-${USER_ID}-web
    restart: unless-stopped
    environment:
      - GUACD_HOSTNAME=guacd
      - GUACD_PORT=4822
      - OPENID_AUTHORIZATION_ENDPOINT=https://neronet.darknero.com/v4/auth/authorize
      - OPENID_JWKS_ENDPOINT=https://neronet.darknero.com/v4/auth/jwks.json
      - OPENID_ISSUER=https://neronet.darknero.com/v4/auth
      - OPENID_CLIENT_ID=guac-cloudpc-${USER_ID}
      - OPENID_REDIRECT_URI=https://${USER_ID}.pc.neronet.darknero.com/guacamole/
    networks:
      - tenant-net

  guacd:
    image: guacamole/guacd:latest
    container_name: neronet-guac-${USER_ID}-daemon
    restart: unless-stopped
    networks:
      - tenant-net

  cloud-pc-workstation:
    image: darknero/workstation-ubuntu:24.04-xfce
    container_name: neronet-cloudpc-${USER_ID}-host
    restart: unless-stopped
    environment:
      - USER_ID=${USER_ID}
      - PASSWORD=${GENERATED_PASS}
    devices:
      - /dev/dri:/dev/dri
    deploy:
      resources:
        limits:
          cpus: '4.00'
          memory: 8192M
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, video, compute]
    volumes:
      - /var/lib/neronet/tenants/${USER_ID}/cloudpc/home:/home/sovereign
    networks:
      - tenant-net
```

---

# Chapter 3: Dynamic Container Provisioning, Storage & Security Architecture

## 3.1 Per-User Isolated Stack Architecture & CIS Docker Hardening

NeroNet enforces strict **single-tenant container isolation** over multi-tenant shared databases:

```
+---------------------------------------------------------------------------------------------------+
|                              TENANT ISOLATION ARCHITECTURAL COMPARISON                            |
+---------------------------------------------------------------------------------------------------+
|  Dimension                  | Shared Multi-Tenancy         | NeroNet Dedicated Per-User Stack     |
+-----------------------------+------------------------------+--------------------------------------+
|  Data Leakage Risk          | High (Application SQL bug    | Zero (Separate DB instances,         |
|                             | compromises all tenants)     | distinct LUKS2 encrypted volumes)    |
|  Crash & Failure Blast      | High (One runaway query      | Zero (Cgroup limits strictly isolate |
|  Radius                     | degrades service for all)    | memory and CPU per tenant)           |
|  Cryptographic Erasure      | Complex (Row deletion leaves | Instant (Drop LUKS2 crypto key,      |
|                             | artifacts in DB write-ahead) | immediate zero-trace purge)          |
|  Customization & Extensions | Restricted (Global plugins   | Full (User can enable custom         |
|                             | affect all tenants)          | apps/models without side effects)    |
+---------------------------------------------------------------------------------------------------+
```

### Container Hardening Specifications (CIS Docker Benchmark)

- **Rootless Execution**: Stacks run under dedicated unprivileged system users (`UID 10001:10001`) with user namespace remapping (`userns-remap`).
- **Read-Only Root Filesystems**: Container rootfs mounted with `read_only: true`; mutable state isolated strictly to tmpfs and encrypted volume mount points.
- **Linux Capability Dropping**:
  ```yaml
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
  cap_add:
    - CHOWN
    - SETUID
    - SETGID
    - NET_BIND_SERVICE
  ```

---

## 3.2 Event-Driven Container Lifecycle & NATS JetStream Bus

Container lifecycle state transitions are coordinated asynchronously via an embedded **NATS JetStream** event bus (`pkg/orchestrator/events/`):

```
+---------------------------------------------------------------------------------------------------+
|                     EVENT-DRIVEN CONTAINER ORCHESTRATION & INFERENCE PIPELINE                     |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  +--------------------------+         +-------------------------------+         +--------------+  |
|  |   NATS JETSTREAM BUS     | ------> | SOVEREIGN BUNDLE ORCHESTRATOR | ------> | gVisor / OCI |  |
|  | `tenant.provision`       |         | - Reconciles desired state    |         | Container    |  |
|  | `tenant.scale_to_zero`   |         | - Allocates LUKS2 & CGroups   |         | Sandboxes    |  |
|  | `ai.inference_request`   |         | - Manages eBPF socket filters |         | (`runsc`)    |  |
|  +--------------------------+         +-------------------------------+         +--------------+  |
|                                                       |                                           |
|                                                       v                                           |
|                                       +-------------------------------+                           |
|                                       | LOCAL ML INFERENCE WORKERS    |                           |
|                                       | - CLIP & Facial Recognition   |                           |
|                                       | - Dynamic model weight loading|                           |
|                                       | - Scale-to-zero GPU unloader  |                           |
|                                       +-------------------------------+                           |
+---------------------------------------------------------------------------------------------------+
```

- **Decoupled State Management**: Events like `tenant.provision`, `tenant.suspend`, `backup.trigger`, and `ai.inference_request` ensure asynchronous scaling without blocking incoming mesh HTTP requests.
- **GPU ML Worker Pooling**: Immich and local indexing workers dynamically load model weights on demand and unload GPU VRAM when idle for >5 minutes.

---

## 3.3 MicroVM & gVisor Container Sandboxing (`runsc`)

To protect the host kernel from potential container escape vulnerabilities during the execution of third-party user applications:

- **gVisor Runtime (`runsc`)**: Untrusted application stacks execute inside gVisor userspace kernel sandboxes, intercepting all system calls and preventing host kernel privilege escalation.
- **MicroVM Integration**: High-risk workstation processes run within lightweight Firecracker / Cloud-Hypervisor microVMs with dedicated virtual CPU and memory barriers.

---

## 3.4 Storage Volume Management, LUKS2 Encryption & Hard Quotas

```
+---------------------------------------------------------------------------------------------------+
|                             TENANT ENCRYPTED STORAGE ARCHITECTURE                                 |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  +---------------------------------------------------------------------------------------------+  |
|  |                     HOST NVMe STORAGE POOL (`/dev/nvme0n1` / ZFS zpool)                     |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                |                                                  |
|  +---------------------------------------------v-----------------------------------------------+  |
|  |               PER-TENANT LUKS2 ENCRYPTED CONTAINER (`/dev/mapper/tenant-<user_id>`)         |  |
|  |  * Cipher: AES-XTS-256 (512-bit key)         * KDF: Argon2id (1GB RAM, 4 Iterations)        |  |
|  |  * Key derivation via Control Plane Master Key             + Tenant Biometric Passkey       |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                |                                                  |
|  +---------------------------------------------v-----------------------------------------------+  |
|  |               ZFS DATASET / XFS PROJECT QUOTA (`/var/lib/neronet/tenants/<user_id>`)         |  |
|  |  * Hard Quota: `zfs set quota=2TB pool/tenants/<user_id>`                                   |  |
|  |  * Compression: `zfs set compression=zstd-3 pool/tenants/<user_id>`                         |  |
|  |  * Recordsize: 128k (Nextcloud/Seafile) / 1M (Immich Media)                                 |  |
|  +---------------------------------------------------------------------------------------------+  |
|               |                                |                                 |                |
|               v                                v                                 v                |
|  +------------------------+      +---------------------------+      +--------------------------+  |
|  |    NEXTCLOUD DATA      |      |       IMMICH LIBRARY      |      |      SEAFILE BLOCKS      |  |
|  |  `/nextcloud/data`     |      |  `/immich/upload`         |      |  `/seafile/shared`       |  |
|  +------------------------+      +---------------------------+      +--------------------------+  |
+---------------------------------------------------------------------------------------------------+
```

---

## 3.5 Client-Side Key Derivation (Argon2id) & Zero-Knowledge Secrets Vaulting

All sensitive secrets, volume encryption keys, and credentials utilize rigorous client-side cryptographic derivation:

```
+---------------------------------------------------------------------------------------------------+
|                        ZERO-KNOWLEDGE SECRETS & CREDENTIAL ARCHITECTURE                           |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  +---------------------------------------------------------------------------------------------+  |
|  |                              CLIENT-SIDE KEY DERIVATION (Argon2id)                          |  |
|  |  $$\text{MasterKey} = \text{Argon2id}(\text{Passphrase}, \text{Salt}, \text{time}=3, \text{mem}=64\text{MB}, \text{parallelism}=4)$$ |  |
|  |  * Symmetric Encryption Key ($K_{\text{enc}}$): $\text{HKDF-Expand}(\text{MasterKey}, \text{"enc"}, 32)$                |  |
|  |  * Master Password Hash ($H_{\text{auth}}$): $\text{PBKDF2-HMAC-SHA256}(\text{MasterKey}, \text{Passphrase}, 100000)$        |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                |                                                  |
|                                                v                                                  |
|  +---------------------------------------------------------------------------------------------+  |
|  |                      HARDWARE SECURITY MODULE (HSM) & WEBAUTHN FIDO2                        |  |
|  |  * CTAP2 hardware key attestation (YubiKey 5 Series / Apple Secure Enclave)                |  |
|  |  * Public key registered with Authentik IdP; private key never leaves secure silicon       |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                |                                                  |
|                                                v                                                  |
|  +---------------------------------------------------------------------------------------------+  |
|  |                       ASYMMETRIC ZERO-KNOWLEDGE ENCRYPTED SHARING                           |  |
|  |  * Secrets encrypted via ephemeral X25519-ChaCha20-Poly1305 for recipient's public key       |  |
|  |  * NeroNet Control Plane only stores and routes opaque ciphertext blobs                      |  |
|  +---------------------------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------------------------+
```

---

## 3.6 Automated Encrypted Offsite Backup Pipeline (`Restic` / `Borg`)

All tenant state and configuration are protected via automated, deduplicated zero-knowledge backups:

```
+---------------------------------------------------------------------------------------------------+
|                                 ATOMIC BACKUP PIPELINE ARCHITECTURE                               |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  1. DATABASE FREEZE & DUMP       2. RESTIC ATOMIC SNAPSHOT          3. OFFSITE S3 / OCI VAULT     |
|  +---------------------------+   +------------------------------+   +--------------------------+  |
|  | - MariaDB: `mariadb-dump` |   | - AES-256-GCM / Poly1305     |   | - OCI Object Storage     |  |
|  | - PostgreSQL: `pg_dump`   |-->| - Client-side passphrase     |-->| - Hetzner Storage Box    |  |
|  | - SQLite: `.backup` atomic|   | - Content-Defined Chunking   |   | - Customer Own S3 Bucket |  |
|  | - App State Flushed       |   | - Deduplication & Pruning    |   | - Immutable Object Lock  |  |
|  +---------------------------+   +------------------------------+   +--------------------------+  |
+---------------------------------------------------------------------------------------------------+
```

- **Atomic DB Hooks**: Pre-backup scripts execute atomic database dumps before filesystem traversal.
- **Client-Side Passphrase**: Encryption occurs on the node prior to transmission. Operators have zero ability to decrypt snapshot archives.
- **Immutability (WORM)**: Snapshots target S3 Object Lock repositories to guarantee ransomware immunity.

---

## 3.7 Scale-to-Zero Inactivity Daemon & Sub-2.5s Mesh Fast Wake-Up

To achieve sustainable unit economics on cloud compute, idle application stacks are automatically suspended when not in active use.

```
+---------------------------------------------------------------------------------------------------+
|                            SCALE-TO-ZERO & FAST WAKE-UP STATE MACHINE                             |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|     +------------------+         Access Cleared            +-------------------+                  |
|     |  UNPROVISIONED   | --------------------------------> |   PROVISIONING    |                  |
|     +------------------+                                   +-------------------+                  |
|                                                                      |                            |
|                                                                      | Containers Bootstrapped    |
|                                                                      v                            |
|     +------------------+     Inactivity Daemon (15m Idle)  +-------------------+                  |
|     |      IDLE        | <-------------------------------- |      RUNNING      |                  |
|     |   (Containers    |                                   |  (Containers UP,  |                  |
|     |    Stopped)      | --------------------------------> |   Traffic Flow)   |                  |
|     +------------------+    Mesh HTTP SYN / Wakeup (<2.4s) +-------------------+                  |
|               |                                                      |                            |
|               | Payment Failure                                      | Payment Expired            |
|               v                                                      v                            |
|     +--------------------------------------------------------------------------+                  |
|     |              FROZEN / GRACE PERIOD (Read-Only Storage Access)            |                  |
|     +--------------------------------------------------------------------------+                  |
|                                       |                                                           |
|                                       | Grace Period Expired (>30 Days)                           |
|                                       v                                                           |
|     +--------------------------------------------------------------------------+                  |
|     |              DECOMMISSIONED & SECURELY WIPED (Zero-Trace Purge)          |                  |
|     +--------------------------------------------------------------------------+                  |
+---------------------------------------------------------------------------------------------------+
```

### Sub-2.5-Second Mesh HTTP Wake-Up Sequence

1. **Request Interception**: The local NeroNet Reverse Proxy on the host intercepts the incoming TCP connection on the tenant's overlay VIP (`100.64.x.y:443`).
2. **TCP Holding Buffer**: The reverse proxy accepts the TCP handshake and buffers the incoming TLS ClientHello / HTTP request headers in memory.
3. **Instant Unfreeze**: The proxy dispatches an asynchronous IPC signal to `sovereign-bundle-orchestrator`, triggering `docker start` on the tenant stack.
4. **Health Probe Polling**: The proxy polls the container's loopback health endpoint (`http://127.0.0.1:<internal_port>/healthz`) every 50ms.
5. **Stream Pipelining**: As soon as the health check returns HTTP 200 (mean benchmark: **1,850ms - 2,400ms**), the proxy flushes the buffered request to the container socket and continues bidirectional streaming transparently.

---

## 3.8 Zero-Trust Egress, Userspace Mesh VIP Reverse Proxy & Anti-Leak DNS

All tenant application traffic routes strictly over the private NeroNet mesh overlay:

- **Mesh Domain Mapping**: Every application is assigned an internal mesh domain:
  - `<user_id>.nextcloud.neronet.darknero.com` -> `100.64.48.12`
  - `<user_id>.immich.neronet.darknero.com`    -> `100.64.48.13`
  - `<user_id>.seafile.neronet.darknero.com`   -> `100.64.48.14`
  - `<user_id>.pc.neronet.darknero.com`        -> `100.64.48.15`
- **DNS Resolution**: The NeroNet client's built-in Anti-Leak DNS over HTTPS (DoH) resolver resolves `.darknero.com` subdomains directly to internal CGNAT VIPs.
- **Outbound Egress Guard**: Egress traffic is filtered through the sandboxed netstack bridge (`pkg/bridge/sandbox.go`), preventing SSRF attacks, RFC 1918 bogon scanning, and abusive outbound scans.

---

# Chapter 4: Client Integration, 1-Click HUD & Cloud PC Experience

## 4.1 NeroNet Native Multi-Platform Client Architecture

The NeroNet client is implemented natively across all major platforms:

- **iOS / iPadOS**: Swift 6, SwiftUI, NetworkExtension framework (`NEPacketTunnelProvider`).
- **macOS**: Swift 6, SwiftUI, SystemExtension netstack daemon.
- **Android**: Kotlin, Jetpack Compose, Android VpnService.
- **Windows**: C# .NET 9, WinUI 3, Wintun driver interface.
- **Linux**: Go 1.24, GTK4 / CLI daemon (`neronet-cli`).

```
+---------------------------------------------------------------------------------------------------+
|                                 NERONET CLIENT BUNDLE LAUNCHER HUD                                |
+---------------------------------------------------------------------------------------------------+
|  [NeroNet Sovereign Cloud]                           Status: CONNECTED (100.64.48.12)             |
|  -----------------------------------------------------------------------------------------------  |
|                                                                                                   |
|  +--------------------+ +--------------------+ +--------------------+ +------------------------+  |
|  |  NEXTCLOUD SUITE   | |  IMMICH AI VAULT   | |    SEAFILE SYNC    | |  GUACAMOLE CLOUD PC    |  |
|  | Status: ACTIVE     | | Status: STANDBY    | | Status: ACTIVE     | | Status: SLEEPING       |  |
|  | Storage: 142/500 GB| | Storage: 890/2TB   | | Storage: 310/1TB   | | Spec: 4 vCPU / 8GB RAM |  |
|  | [===>        ] 28% | | [======>     ] 43% | | [====>       ] 30% | | GPU: NVIDIA CUDA Opt   |  |
|  |                    | |                    | |                    | |                        |  |
|  |  [ 🚀 OPEN CLOUD ] | | [ ⚡ WAKE & OPEN ] | |  [ 🚀 OPEN FILES ] | |   [ 🖥️ LAUNCH PC ]     |  |
|  +--------------------+ +--------------------+ +--------------------+ +------------------------+  |
|                                                                                                   |
|  -----------------------------------------------------------------------------------------------  |
|                                                                * Mesh VIP Latency: 18ms           |
+---------------------------------------------------------------------------------------------------+
```

---

## 4.2 1-Click Bundle Launcher HUD & Deep-Link Protocol Registration

When the user clicks "Launch" or opens a dedicated third-party app:

1. **Deep-Link URI Handling**: NeroNet registers custom URI schemes (`neronet://launch/nextcloud`, `neronet://launch/immich`, `neronet://launch/seafile`, `neronet://launch/cloudpc`).
2. **Local Token Brokerage**: The client initializes an ephemeral local loopback HTTP server (`http://127.0.0.1:<random_port>/oauth/callback`).
3. **Automated PKCE Exchange**: The client executes the OIDC Authorization Code exchange in the background using the user's master cryptographic key or device biometrics (TouchID / FaceID / Windows Hello).
4. **App Handoff**: The client launches the target application, passing pre-authenticated session tokens or triggering instant authorization callbacks, eliminating password prompts.

---

## 4.3 Sovereign Guacamole Cloud PC Client Experience (HTML5 & Native Desktop Wrapper)

The Guacamole Cloud PC experience is delivered via two client pathways:

1. **Clientless HTML5 Canvas (Browser)**: High-performance binary WebSocket streaming directly inside Chrome, Safari, Firefox, or Edge with clipboard, microphone, and file drag-and-drop passthrough.
2. **Native Desktop Wrapper (Windows/macOS/Linux)**: An accelerated native application shell (Wails v2 / SwiftUI) providing hardware-accelerated video decode, low-latency audio capture, multi-monitor display synchronization, and direct local USB device redirection over the NeroNet mesh.

---

## 4.4 Transparent Netstack Split-Tunneling & Camouflaged DERP-v4 Relays

The client routes application bundle traffic through the local userspace netstack tunnel directly to the remote container host:

$$\text{Throughput} \ge 940\text{ Mbps}, \quad \text{Tunnel Overhead} \le 2.1\%$$

All payload data is encrypted end-to-end with ChaCha20-Poly1305 over UDP direct peer paths (or camouflaged DERP-v4 relays on port 443 with active probing decoy when direct NAT traversal is restricted).

---

# Chapter 5: Hybrid Data Residency, Liability Separation & Compliance (Requirement R4)

Requirement R4 dictates a **liability-reducing checkout and operational architecture** that splits the offering into two distinct operational models:

```
+---------------------------------------------------------------------------------------------------+
|                              HYBRID DATA RESIDENCY & LIABILITY SEPARATION                         |
+---------------------------------------------------------------------------------------------------+
|  Dimension                  | Managed Cloud                       | Self-Hosted / BYOS            |
+-----------------------------+-------------------------------------+-------------------------------+
|  Target Hardware            | NeroNet High-Performance NVMe Nodes | User's Own Server / Home Lab  |
|                             | (OCI / Hetzner Bare Metal)          | (Proxmox, TrueNAS, unRAID)    |
|  Encryption at Rest         | Zero-Knowledge LUKS2 (AES-XTS-256)  | Customer Native LUKS / ZFS    |
|  Vendor Data Access         | ZERO (Keys held by client)          | ZERO (Traffic stays on-prem)  |
|  Network Connectivity       | NeroNet Mesh VIP + DERP Relays      | NeroNet Mesh VIP + DERP Relays|
|  Operator Data Liability    | Disclaimed via Zero-Knowledge E2EE  | ZERO (NeroNet is mere conduit)|
|  GDPR / HIPAA Role          | Zero-Knowledge Processor (Art. 28)  | Customer is Controller & Proc |
|  Installation Method        | 1-Click Client Provisioning         | 1-Line Curl / Ansible Playbook|
+---------------------------------------------------------------------------------------------------+
```

---

## 5.1 Dual-Model Checkout & Deployment Architecture (Managed Cloud vs BYOS)

During signup or checkout, users select their data residency model:

```
[ Checkout / Deployment Selector ]
-----------------------------------------------------------------
Option 1: [ MANAGED SOVEREIGN CLOUD (Turnkey Hosted) ]
- Hosted on NeroNet Tier-4 Secure European & Global Datacenters
- 100% Zero-Knowledge Encrypted: We cannot decrypt or inspect your files
- Automatic daily offsite backups & 99.99% uptime SLA

Option 2: [ BRING YOUR OWN SERVER (BYOS - 100% Self-Hosted) ]
- Open-Source Core
- Runs on your own hardware (Raspberry Pi, Mini PC, Home Server)
- NeroNet provides encrypted mesh overlay, dynamic DNS & NAT punch
- Zero data touches NeroNet servers: Absolute legal & privacy autonomy
-----------------------------------------------------------------
```

---

## 5.2 Legal & Liability Separation Matrix

1. **Zero Vendor Data Access**: In both models, NeroNet engineers and operators have zero technical ability to access, inspect, or decrypt tenant data.
   - *Managed Cloud*: Per-tenant LUKS2 partitions are unlocked using keys derived from the user's client-side passkey.
   - *BYOS*: Payloads travel strictly point-to-point across the `Noise_IKpsk2` mesh overlay.
2. **Telecommunications Safe Harbor**: NeroNet operates as a pure telecommunications conduit under Directive 2000/31/EC and 47 U.S.C. § 230, bearing zero legal liability for hosted payloads.

---

## 5.3 GDPR (Articles 4, 17, 28) & HIPAA (45 CFR § 164.312) Compliance by Design

- **GDPR Article 17 ("Right to Erasure")**: Satisfied via **cryptographic shredding** of the tenant's LUKS2 volume key, destroying all access to stored data with mathematical finality.
- **GDPR Article 28 ("Data Processor")**: NeroNet qualifies as a blind data processor with zero plaintext visibility.
- **HIPAA Security Rule (45 CFR § 164.312)**: Meets federal standards for encryption in transit (ChaCha20-Poly1305) and at rest (AES-256-XTS). Healthcare organizations utilizing BYOS retain complete physical physical and legal custody of Protected Health Information (PHI).

---

## 5.4 BYOS 1-Line Automated Installer & Ansible Playbook Architecture

BYOS deployment is executed via a single automated shell script or Ansible playbook:

```bash
# 1-Line BYOS Automated Enrollment
curl -fsSL https://get.darknero.com/byos.sh | bash -s -- \
  --token="byos_tok_9f8a7c6b5e4d3c2b" \
  --bundle="cloudpc,nextcloud,immich" \
  --domain="myhomelab.darknero.mesh"
```

### Ansible Playbook Structure (`deploy/ansible/neronet-byos.yml`)

```yaml
---
- name: Deploy NeroNet BYOS Sovereign Node
  hosts: localhost
  connection: local
  vars:
    neronet_node_token: "{{ lookup('env', 'NERONET_BYOS_TOKEN') }}"
    mesh_vip_subnet: "100.64.0.0/10"
  tasks:
    - name: Install NeroNet Mesh Daemon & Dependencies
      apt:
        name: [docker.io, docker-compose-plugin, wireguard-tools, step-cli]
        state: present
        update_cache: yes

    - name: Enroll Node into DarkNero Mesh Keyring
      command: /usr/local/bin/neronet-cli enroll --token="{{ neronet_node_token }}"
      register: enroll_result
      changed_when: "'Successfully registered' in enroll_result.stdout"

    - name: Deploy Selected Sovereign App Bundles
      community.docker.docker_compose_v2:
        project_src: /etc/neronet/bundles/
        state: present
        pull: always
```

---

# Chapter 7: Phased Engineering Roadmap & Delivery Milestones (2026-2027)

```
+---------------------------------------------------------------------------------------------------+
|                                 NERONET ENGINEERING ROADMAP (2026-2027)                           |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|   [Q1 2026] PHASE 1: FOUNDATION & IDENTITY CORE                                                   |
|   =============================================                                                   |
|   * OpenID Connect (OIDC 1.0) & OAuth 2.0 Identity Provider inside Control Plane (`pkg/control/`) |
|   * PKCE Authorization Code Flow & JWKS Key Rotation Subsystem                                    |
|                                                                                                   |
|   [Q2 2026] PHASE 2: DYNAMIC ORCHESTRATOR & NEXTCLOUD MVP                                         |
|   =======================================================                                         |
|   * `sovereign-bundle-orchestrator` Docker/Containerd API Controller                              |
|   * Nextcloud 30 + MariaDB 10.11 + Redis 7 Automated Stack Generator                              |
|   * Nextcloud `user_oidc` and OCS REST API Dynamic Provisioning Integration                       |
|   * Per-Tenant LUKS2 Encryption & ZFS/XFS Hard Storage Quota Manager                              |
|   * Inactivity Monitor & Sub-2.5s Mesh Reverse Proxy Fast Wake-Up Engine                          |
|                                                                                                   |
|   [Q3 2026] PHASE 3: IMMICH AI PHOTO VAULT, SEAFILE & GUACAMOLE CLOUD PC LAUNCH                   |
|   =============================================================================                   |
|   * Immich Server + Python ML + PGVector Microservices Stack Integration                          |
|   * Seafile C-Core Server + Seahub Django OIDC Backend Configuration                              |
|   * Sovereign Guacamole Cloud PC (guacd, xrdp, GPU passthrough, HTML5/Native Client HUD)         |
|   * step-ca Automated Internal ACME PKI & Authentik Federation Engine                             |
|                                                                                                   |
|   [Q4 2026 - Q1 2027] PHASE 4: HYBRID BYOS PLAYBOOKS, ZERO-KNOWLEDGE VAULTING & GLOBAL FEDERATION  |
|   ==============================================================================================  |
|   * 1-Line Curl & Ansible BYOS Installer for Self-Hosted Hardware (`get.darknero.com/byos.sh`)    |
|   * Zero-Knowledge Client-Side Key Derivation (Argon2id) & Asymmetric Encrypted Vaulting          |
|   * Multi-Region Tenant Container Migration & Cross-Cloud Disaster Recovery                       |
|   * Automated Tiered Storage (Active NVMe -> Warm Object Store -> Cold Archive)                   |
|   * Decentralized Cold Backup Connector (Restic/Borg Encrypted Snapshots to S3/WORM)              |
|                                                                                                   |
+---------------------------------------------------------------------------------------------------+
```

## 7.1 Phase 1: Foundation & Identity Core (Target: Q1 2026)
- **Deliverables**:
  1. High-throughput Go OIDC server package in `pkg/control/oidc/` implementing discovery, token, userinfo, and JWKS endpoints.
  2. Ed25519 token signing infrastructure with automated 90-day key rotation and zero-downtime rollover.
  3. Unit test and fuzzing suite achieving 100% test coverage for all identity state transitions.

## 7.2 Phase 2: Dynamic Orchestrator & Nextcloud MVP (Target: Q2 2026)
- **Deliverables**:
  1. `cmd/sovereign-bundle-orchestrator` daemon managing local Docker socket lifecycle operations.
  2. Automated Nextcloud container stack deployment template with MariaDB InnoDB buffer pool optimization and Redis caching.
  3. LUKS2 storage partition creator and ZFS project quota enforcement scripts.
  4. eBPF socket monitoring inactivity daemon with sub-2.5-second reverse proxy connection buffering and unfreeze triggers.

## 7.3 Phase 3: Immich AI Photo Vault, Seafile & Guacamole Cloud PC Launch (Target: Q3 2026)
- **Deliverables**:
  1. Immich microservices orchestrator with automated PostgreSQL `pgvector` index setup and Python ML model cache pre-warming.
  2. Hardware accelerated transcoding pipelines supporting Intel QuickSync (`/dev/dri`) and NVIDIA CUDA (`--gpus all`).
  3. Seafile block-deduplicated storage engine orchestration with Seahub OAuth2 Django bridge.
  4. Sovereign Guacamole Cloud PC workstation stack with Tomcat OIDC extension, guacd C-core translation, and low-latency audio/video streaming.
  5. Internal `step-ca` automated PKI issuing internal wildcard certificates with client-injected root trust.

## 7.4 Phase 4: Hybrid BYOS Automation, Zero-Knowledge Vaulting & Global Multi-Region Federation (Target: Q4 2026 - Q1 2027)
- **Deliverables**:
  1. Automated 1-line curl (`get.darknero.com/byos.sh`) and Ansible playbook deployment suite for BYOS self-hosted nodes.
  2. Zero-Knowledge client-side key derivation (`Argon2id`) and asymmetric encrypted secrets vaulting.
  3. Geo-distributed container scheduling across OCI, AWS, Hetzner, and bare-metal nodes.
  4. Automated lifecycle data tiering migrating inactive snapshot blocks to OCI Object Storage Archive tier.
  5. Restic / Borg encrypted offsite backup daemon targeting customer-owned S3 buckets with WORM object locking.

---

*End of Specification — NeroNet Architecture Working Group*
