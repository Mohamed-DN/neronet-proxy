-- Migration 020: Internal CA & TLS certificate pinning
--
-- One self-signed root CA per deployment, held in PostgreSQL.
-- Nodes pin the server certificate fingerprint on enrollment and
-- refuse to connect if it changes (TOFU with explicit revocation).
-- Intermediate certs for nodes allow cert-based mTLS in future WPs.

-- Enable pgcrypto for SHA-256 fingerprinting (already available in PostgreSQL 14+)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. CA root certificate store
--    One row per deployment (single-tenant root CA).
CREATE TABLE IF NOT EXISTS internal_ca (
    id              TEXT PRIMARY KEY DEFAULT 'root',           -- always 'root' for the deployment CA
    common_name     TEXT        NOT NULL DEFAULT 'NeroNet Internal CA',
    organization    TEXT        NOT NULL DEFAULT 'NeroNet',
    cert_pem        TEXT        NOT NULL,                      -- PEM-encoded self-signed root cert
    private_key_pem TEXT        NOT NULL,                      -- PEM-encoded EC private key (encrypted at rest by KMS in production)
    fingerprint_sha256 TEXT     NOT NULL,                      -- hex SHA-256 of the DER-encoded cert
    not_before      TIMESTAMPTZ NOT NULL,
    not_after       TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Node TLS certificates
--    One leaf cert per node, signed by the internal CA.
CREATE TABLE IF NOT EXISTS node_certificates (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    node_id         TEXT        NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    serial          BIGSERIAL,                                 -- unique serial for CRL support
    cert_pem        TEXT        NOT NULL,
    fingerprint_sha256 TEXT     NOT NULL,
    not_before      TIMESTAMPTZ NOT NULL,
    not_after       TIMESTAMPTZ NOT NULL,
    revoked         BOOLEAN     NOT NULL DEFAULT FALSE,
    revoked_at      TIMESTAMPTZ,
    revoke_reason   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_node_certs_node_id  ON node_certificates(node_id);
CREATE INDEX IF NOT EXISTS idx_node_certs_revoked  ON node_certificates(revoked) WHERE revoked = FALSE;

-- 3. Pinned fingerprint per node
--    Written at enrollment, verified on every reconnection.
--    Changing the control plane cert without explicit re-pin causes 401 on all nodes
--    (fail-closed TLS pinning: zero-downtime rotation requires a two-phase pin update).
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS pinned_ca_fingerprint TEXT;         -- SHA-256 of the CA cert the node enrolled against

-- 4. Secrets table for deployment-level secrets (PSK, CA key passphrase, etc.)
CREATE TABLE IF NOT EXISTS deployment_secrets (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,                                 -- always bcrypt-encrypted or base64(AES-GCM) in production
    description TEXT,
    rotated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
