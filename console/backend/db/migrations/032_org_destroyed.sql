-- An organisation destroyed by crypto-shredding is marked, rather than switched to the
-- standard profile as before, which turned its high-risk modules back on.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS destroyed_at TIMESTAMPTZ;

-- approveAndExecuteDestruction marks a lapsed authorisation 'expired', a status the
-- constraint did not allow: the update failed and the caller got a database error
-- instead of "Authorization has expired".
ALTER TABLE nuke_authorizations DROP CONSTRAINT IF EXISTS nuke_authorizations_status_check;
ALTER TABLE nuke_authorizations ADD CONSTRAINT nuke_authorizations_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'cancelled', 'expired'));
