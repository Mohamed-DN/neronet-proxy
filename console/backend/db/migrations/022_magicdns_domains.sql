-- Migration 022: MagicDNS In-Mesh Resolution & Search Domains
-- Adds search_domain to organizations and dns_name to nodes.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS search_domain VARCHAR(255);
UPDATE organizations SET search_domain = slug || '.neronet' WHERE search_domain IS NULL;

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS dns_name VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_organizations_search_domain ON organizations(search_domain);
CREATE INDEX IF NOT EXISTS idx_nodes_dns_name ON nodes(dns_name);
