-- An invitation may be bound to an email address by the administrator who issues it.
-- The account created from it then carries that address, and people can sign in with it.
-- The address is stored lowercase so that "same address" means the same thing everywhere;
-- the CHECK is deliberately simple (one @, no spaces, a dot in the domain, at most 255).
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS email VARCHAR(255);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitations_email_shape') THEN
        ALTER TABLE invitations ADD CONSTRAINT invitations_email_shape CHECK (
            email IS NULL OR (
                email = lower(email)
                AND char_length(email) <= 255
                AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
            )
        );
    END IF;
END
$$;

-- Sign-in by email and the "already taken" checks compare lower(users.email).
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
