-- Browser coordination is separate from user/session authentication. No existing
-- users, families, refresh credentials or MFA proofs are changed by this migration.
CREATE TABLE console_browser_contexts (
    id UUID PRIMARY KEY,
    binding_hash VARCHAR(64) NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
    origin VARCHAR(2048) NOT NULL,
    latest_intent NUMERIC(20,0) NOT NULL DEFAULT 0
        CHECK (latest_intent BETWEEN 0 AND 18446744073709551615),
    selected_issuance_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '30 days')
);
CREATE INDEX idx_console_browser_context_expiry ON console_browser_contexts(expires_at);

CREATE TABLE console_browser_operations (
    id UUID PRIMARY KEY,
    context_id UUID NOT NULL REFERENCES console_browser_contexts(id) ON DELETE CASCADE,
    intent NUMERIC(20,0) NOT NULL CHECK (intent BETWEEN 1 AND 18446744073709551615),
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('login','register','mfa','refresh','lock','unlock','logout')),
    expected_issuance_id UUID,
    successor_issuance_id UUID UNIQUE,
    state VARCHAR(20) NOT NULL DEFAULT 'registered'
        CHECK (state IN ('registered','candidate','selected','refused','superseded')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '5 minutes'),
    UNIQUE (context_id, intent),
    UNIQUE (context_id, id, successor_issuance_id),
    CHECK ((kind='logout' AND successor_issuance_id IS NULL)
        OR (kind<>'logout' AND successor_issuance_id IS NOT NULL))
);
CREATE INDEX idx_console_browser_operation_expiry ON console_browser_operations(expires_at);

-- Each cookie belongs to one immutable issuance. Public IDs are correlation,
-- never credentials; authority also requires the existing signed/stored pair.
CREATE UNIQUE INDEX idx_refresh_tokens_browser_family_id ON refresh_tokens(session_id,id);
CREATE TABLE console_browser_issuances (
    id UUID PRIMARY KEY,
    context_id UUID NOT NULL REFERENCES console_browser_contexts(id) ON DELETE CASCADE,
    operation_id UUID NOT NULL UNIQUE,
    session_id UUID NOT NULL REFERENCES console_sessions(id) ON DELETE CASCADE,
    refresh_token_id TEXT NOT NULL UNIQUE,
    access_jti UUID NOT NULL UNIQUE,
    refresh_jti UUID NOT NULL UNIQUE,
    state VARCHAR(20) NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate','selected','retired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (context_id, id),
    FOREIGN KEY (context_id, operation_id, id)
        REFERENCES console_browser_operations(context_id,id,successor_issuance_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, refresh_token_id) REFERENCES refresh_tokens(session_id,id) ON DELETE CASCADE,
    CHECK (access_jti<>refresh_jti)
);
CREATE INDEX idx_console_browser_issuance_expiry ON console_browser_issuances(expires_at);
CREATE INDEX idx_console_browser_issuance_session ON console_browser_issuances(session_id);
ALTER TABLE console_browser_contexts ADD CONSTRAINT console_browser_selected_issuance
    FOREIGN KEY (id, selected_issuance_id) REFERENCES console_browser_issuances(context_id,id)
    ON DELETE SET NULL (selected_issuance_id) DEFERRABLE INITIALLY DEFERRED;
