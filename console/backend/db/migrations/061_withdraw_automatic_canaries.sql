-- A warrant canary is a statement a person makes. Until now the console wrote and signed one by
-- itself: at every dead man's switch heartbeat and whenever somebody opened
-- /.well-known/canary.txt, with a key generated in memory, in the name of the operator, saying that
-- no legal order had been received. Nobody had said that. Every stored row is of that kind (there
-- was no way for a person to publish one), so all of them are withdrawn. The rows are kept, not
-- deleted, so what was shown can still be examined.
UPDATE warrant_canaries SET is_active = FALSE WHERE is_active = TRUE;

-- A statement is shown only when an account published it.
ALTER TABLE warrant_canaries ADD COLUMN IF NOT EXISTS published_by VARCHAR(64);
