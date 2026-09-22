-- Migration 027: Automated Backup & Recovery Proof Verification
-- Stores verifiable cryptographic disaster recovery audit proofs for DORA / NIS2 compliance.

CREATE TABLE IF NOT EXISTS recovery_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proof_type VARCHAR(64) NOT NULL DEFAULT 'EPHEMERAL_RESTORE_VERIFICATION',
  status VARCHAR(32) NOT NULL CHECK (status IN ('VERIFIED_PASS', 'VERIFIED_FAIL', 'RUNNING')),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_database VARCHAR(128) NOT NULL,
  target_database VARCHAR(128) NOT NULL,
  tables_verified JSONB NOT NULL DEFAULT '{}'::jsonb,
  audit_chain_status JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_records_verified BIGINT NOT NULL DEFAULT 0,
  execution_duration_ms INTEGER NOT NULL DEFAULT 0,
  integrity_hash VARCHAR(64) NOT NULL,
  created_by_user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
  error_message TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_proofs_verified_at ON recovery_proofs(verified_at DESC);
CREATE INDEX IF NOT EXISTS idx_recovery_proofs_status ON recovery_proofs(status);
