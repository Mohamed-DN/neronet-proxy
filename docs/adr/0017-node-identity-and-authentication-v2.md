# ADR 0017: Node Identity and Authentication v2 — Pre-Auth Keys, Proof of Possession, and Node Credentials

- Status: Accepted
- Date: 2026-09-21
- Decision label: D10

## Context

On 2026-09-19 security review verified several structural vulnerabilities in node authentication:
1. Every `/v4/control/*` endpoint authenticated via a single static token shared across the entire fleet (`SOVEREIGN_REGISTRATION_TOKEN`). Compromise of one node or a leaked `.env` compromised the identity of every node.
2. Nodes never proved possession of their private keys. A registration naming someone else's public key was accepted unconditionally.
3. `resolveOwnerId()` attributed all nodes to a global super-admin; per-tenant enrollment did not exist.
4. The node ID in the request body was trusted rather than authenticated: any caller holding the shared fleet token could send telemetry or alter state on behalf of any other node.

### Alternatives Considered

- **mTLS with Internal PKI / CA**: Requires managing an X.509 CA infrastructure on the control plane, issuing and distributing client certificates, handling OCSP or CRLs, and embedding TLS client certs into WireGuard nodes. Overly heavy for lightweight mesh nodes and introduces brittle certificate expiration failures on mobile/embedded devices.
- **Separate Ed25519 Signing Keys**: Adding a secondary Ed25519 signing identity alongside the existing X25519 WireGuard/Noise key doubles identity file storage, key rotation, and wire payloads.
- **Keeping Shared Fleet Token**: Retains the single point of failure and makes multi-tenant isolation impossible.

## Decision

We adopt **Node Identity v2** using pre-auth keys, Diffie-Hellman proof of possession, and rotating bearer node credentials:

1. **Pre-Auth Keys**:
   - Authorized users generate pre-auth keys in the console (`POST /api/preauth-keys`).
   - Keys are bound to an owner (initially user; later organization in WP-106).
   - Keys carry an expiration, single-use vs. reusable flag, and optional role restrictions (`CLIENT_ORIGIN` / `EXIT_BRIDGE`).
   - Keys are stored solely as a SHA-256 hash (`preauth_keys` table); the plaintext secret is revealed exactly once.

2. **Enrolment String**:
   - `nnk1:<pre-auth secret>:<control plane key fingerprint>`.
   - The control plane maintains a static X25519 public key. Its SHA-256 fingerprint is embedded in the enrolment string, pinning the control plane identity and eliminating trust-on-first-use.
   - The node verifies the fingerprint during the initial challenge exchange and refuses to enrol if mismatched.

3. **Proof of Possession (Diffie-Hellman Challenge/Response)**:
   - `POST /v4/control/challenge` generates a single-use cryptographically random 32-byte nonce stored in Valkey with a 90-second TTL, returning `{nonce, cp_public_key, expires_at}`.
   - `POST /v4/control/register` presents `{public_key, preauth_key, nonce, proof}` where:
     $$\text{proof} = \text{HMAC-SHA256}(\text{HKDF-SHA256}(\text{X25519}(\text{node\_priv}, \text{cp\_pub}), \text{info}=\text{"neronet/v4/register"}), \text{nonce} \parallel \text{public\_key})$$
   - The control plane consumes the nonce atomically from Valkey and recomputes the proof using $\text{X25519}(\text{cp\_priv}, \text{node\_pub})$. Registration succeeds only if the caller proves private key possession.

4. **Node Credentials & Bearer Authentication**:
   - Successful registration mints an opaque 256-bit credential token (`nnt1_<hex>`), stored hashed in `node_credentials` with a 24-hour TTL.
   - Every subsequent `/v4/control/*` request requires `Authorization: Bearer <credential>`.
   - The node ID is derived strictly from the authenticated credential. If a request body or query parameter provides a differing `node_id`, it is rejected with `403 Forbidden`.
   - On `/v4/control/heartbeat`, if the credential's remaining lifetime is under 12 hours (half TTL), a refreshed credential is issued automatically in the response.

5. **Re-Registration & Role Invariance**:
   - Re-registration of an existing node public key requires a fresh challenge/proof and a valid pre-auth key belonging to the same owner.
   - Re-registration cannot alter a node's role (e.g. promoting `CLIENT_ORIGIN` to `EXIT_BRIDGE`); role changes must occur through authenticated console administration.

6. **Immediate Revocation**:
   - Quarantining or revoking a node marks all its active credentials as revoked in `node_credentials` and adds its public key to `revoked_keys`. Subsequent calls with that credential return `401 Unauthorized`.

7. **Bootstrap & Shared Token Retirement**:
   - `SOVEREIGN_REGISTRATION_TOKEN` is permanently removed.
   - For automated staging environments, `SOVEREIGN_BOOTSTRAP_PREAUTH_KEY` creates an idempotent reusable pre-auth key for the seeded admin, logging only its truncated fingerprint.

## Consequences

- All nodes must support the challenge-response handshake and persist the issued bearer credential with file mode 0600.
- Valkey is required to hold ephemeral challenge nonces (with in-memory fallback for local single-process test runs).
- Attack surface is dramatically reduced: eavesdropping registration traffic does not yield replayable proofs; compromising a node credential compromises only that specific node for up to 24 hours.
