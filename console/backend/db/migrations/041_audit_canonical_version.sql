-- Preserve existing hashes and checkpoints exactly. Version 1 records retain
-- their original, partial field coverage; only new writers create version 2.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS canonical_version SMALLINT NOT NULL DEFAULT 1
    CONSTRAINT audit_events_canonical_version_check CHECK (canonical_version IN (1, 2));
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS canonical_metadata_json TEXT;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_v2_canonical_metadata_check
    CHECK (canonical_version = 1 OR canonical_metadata_json IS NOT NULL);
