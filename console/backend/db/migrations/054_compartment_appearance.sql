-- Line appearance for the network map editor (display only).
--
-- A compartment is a sub-network, drawn on the map as a line. The editor lets an operator
-- give each line a colour and an order. Neither changes who reaches whom, so neither
-- touches the ACL epoch.
--
--   line_colour  one of the six line tokens of the console design (NULL = automatic)
--   sort_order   position in the list and on the map; ties fall back to created_at
--
-- Safe to run twice: columns are IF NOT EXISTS, the constraint is added only if missing and
-- the backfill only touches rows still at 0 in an organisation where nothing is ordered yet.

ALTER TABLE compartments ADD COLUMN IF NOT EXISTS line_colour VARCHAR(16);
ALTER TABLE compartments ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'compartments_line_colour_check'
    ) THEN
        ALTER TABLE compartments
            ADD CONSTRAINT compartments_line_colour_check
            CHECK (line_colour IS NULL OR line_colour IN ('red', 'green', 'blue', 'orange', 'violet', 'sky'));
    END IF;
END $$;

-- Existing lines keep the order they have today (created_at, then name).
UPDATE compartments c
   SET sort_order = ranked.pos
  FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY created_at ASC, name ASC) - 1 AS pos
          FROM compartments
       ) ranked
 WHERE c.id = ranked.id
   AND c.sort_order = 0
   AND NOT EXISTS (
        SELECT 1 FROM compartments o WHERE o.organization_id = c.organization_id AND o.sort_order <> 0
   );
