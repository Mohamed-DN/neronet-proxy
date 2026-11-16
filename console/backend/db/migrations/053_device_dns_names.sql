-- Unique mesh names per organisation (ADR 0034, phase 2).
--
-- A profile device is reached by the slug of its name plus the organisation's search domain.
-- Until now the console computed that on the fly, so two devices called "Phone" got the same
-- name and the gateway's tiebreak (lowest node id) hid one of them. From here the name is
-- stored in nodes.dns_name, the rule is the same as utils/meshNames.js slugLabel (accents
-- dropped, lowercase, runs of anything outside a-z0-9 become one hyphen, at most 63
-- characters) and the database refuses a second device with the same name.
--
-- Collisions resolve in creation order: the oldest keeps "phone.<domain>", the next gets
-- "phone-2.<domain>", then "phone-3". Safe to run on a database that already has some of it:
-- only rows without a name are backfilled, duplicates are renamed, the index is IF NOT EXISTS.

DO $$
DECLARE
    r        RECORD;
    base     TEXT;
    rest     TEXT;
    sd       TEXT;
    slug     TEXT;
    k        INT;
    cand     TEXT;
BEGIN
    -- 1. Duplicates that an explicit dns_name (set_dns_name on a mesh node) may already hold.
    --    The oldest keeps the name; the others get a numeric suffix on the first label.
    FOR r IN
        SELECT id, organization_id, dns_name
          FROM (SELECT id, organization_id, dns_name,
                       ROW_NUMBER() OVER (PARTITION BY organization_id, dns_name ORDER BY created_at, id) AS rn
                  FROM nodes
                 WHERE dns_name IS NOT NULL AND organization_id IS NOT NULL) t
         WHERE rn > 1
         ORDER BY organization_id, dns_name, rn
    LOOP
        base := split_part(r.dns_name, '.', 1);
        rest := substr(r.dns_name, length(base) + 1);
        k := 1;
        LOOP
            k := k + 1;
            cand := left(base, 63 - length('-' || k)) || '-' || k || rest;
            EXIT WHEN NOT EXISTS (
                SELECT 1 FROM nodes x WHERE x.organization_id = r.organization_id AND x.dns_name = cand
            );
        END LOOP;
        UPDATE nodes SET dns_name = cand WHERE id = r.id;
    END LOOP;

    -- 2. Profile devices that have no stored name yet, oldest first.
    FOR r IN
        SELECT nd.id, nd.name, nd.organization_id, o.search_domain, o.slug AS org_slug
          FROM nodes nd
          LEFT JOIN organizations o ON o.id = nd.organization_id
         WHERE nd.device_kind = 'profile' AND nd.dns_name IS NULL AND nd.organization_id IS NOT NULL
         ORDER BY nd.created_at, nd.id
    LOOP
        slug := regexp_replace(
                    regexp_replace(
                        lower(regexp_replace(normalize(COALESCE(r.name, ''), NFD), '[\u0300-\u036f]', '', 'g')),
                        '[^a-z0-9]+', '-', 'g'),
                    '(^-|-$)', '', 'g');
        slug := regexp_replace(left(slug, 63), '-$', '');
        CONTINUE WHEN slug = '';
        sd := COALESCE(NULLIF(r.search_domain, ''),
                       CASE WHEN COALESCE(r.org_slug, '') <> '' THEN r.org_slug || '.neronet' ELSE 'mesh' END);
        k := 1;
        cand := slug || '.' || sd;
        WHILE EXISTS (SELECT 1 FROM nodes x WHERE x.organization_id = r.organization_id AND x.dns_name = cand) LOOP
            k := k + 1;
            cand := regexp_replace(left(slug, 63 - length('-' || k)), '-$', '') || '-' || k || '.' || sd;
        END LOOP;
        UPDATE nodes SET dns_name = cand WHERE id = r.id;
    END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_org_dns_name_unique
    ON nodes (organization_id, dns_name)
    WHERE dns_name IS NOT NULL;
