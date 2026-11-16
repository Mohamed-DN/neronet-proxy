-- NeroDrop phase 0 (ADR 0033): members of one organisation send each other files.
--
-- The browser encrypts the file; the ciphertext sits on the organisation's default
-- profile gateway (pkg/drop). The console keeps only what it needs to issue tickets and
-- show an inbox: who sends to whom, how many ciphertext bytes, until when. No file name,
-- type, plaintext size, hash, key or link is ever stored here; tests/drop.test.js pins
-- the column list.

-- The organisation switch an administrator turns off (the device.drop IAM hook until
-- ADR 0030's grants land). On by default: sending inside one's own organisation is the
-- point of the feature, and nothing is offered until the gateway runs the mailbox.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS drop_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS drop_transfers (
    -- 128 random bits, lowercase hex: the name of the ciphertext on the gateway.
    id                VARCHAR(32) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
    organization_id   VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sender_user_id    VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The gateway that holds the ciphertext; tickets name it.
    gateway_node_id   VARCHAR(64) REFERENCES nodes(id) ON DELETE SET NULL,
    ciphertext_bytes  BIGINT NOT NULL CHECK (ciphertext_bytes > 0),
    one_time          BOOLEAN NOT NULL DEFAULT FALSE,
    status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'sent', 'received')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at           TIMESTAMPTZ,
    received_at       TIMESTAMPTZ,
    expires_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drop_transfers_recipient ON drop_transfers (recipient_user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_drop_transfers_sender ON drop_transfers (sender_user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_drop_transfers_expires ON drop_transfers (expires_at);
