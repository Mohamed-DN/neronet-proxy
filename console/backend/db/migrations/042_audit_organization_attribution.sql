-- Existing v1/v2 content and checkpoint evidence is preserved without guessing
-- its tenant from mutable account/resource ownership. Only v3 signs this field.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS organization_id VARCHAR(255);
ALTER TABLE audit_events DROP CONSTRAINT audit_events_canonical_version_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_canonical_version_check
    CHECK (canonical_version IN (1, 2, 3));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_organization_signed_check
    CHECK (organization_id IS NULL OR canonical_version = 3);
CREATE INDEX IF NOT EXISTS idx_audit_events_organization_created
    ON audit_events(organization_id, created_at DESC)
    WHERE canonical_version = 3 AND organization_id IS NOT NULL;
