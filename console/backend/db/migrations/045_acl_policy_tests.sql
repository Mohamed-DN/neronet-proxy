-- ADR 0028 pair 1: policy tests checked on every ACL save.
--
-- An assertion is a promise an administrator made about the network: this packet is
-- accepted, or this one is dropped. Every ACL write is evaluated against the
-- assertions of every organisation it reaches and refused when one would break.
-- Assertions belong to one organisation; a platform rule is checked against all of
-- them.
CREATE TABLE IF NOT EXISTS acl_policy_tests (
    id VARCHAR(64) PRIMARY KEY,
    organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_ip INET NOT NULL,
    destination_ip INET NOT NULL,
    protocol VARCHAR(8) NOT NULL DEFAULT 'ALL' CHECK (protocol IN ('TCP', 'UDP', 'ICMP', 'ALL')),
    port INTEGER NOT NULL DEFAULT 0 CHECK (port BETWEEN 0 AND 65535),
    expect VARCHAR(8) NOT NULL CHECK (expect IN ('ACCEPT', 'DROP')),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_acl_policy_tests_org ON acl_policy_tests (organization_id);
