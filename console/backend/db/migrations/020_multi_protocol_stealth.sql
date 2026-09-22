-- Migration 020: Multi-Protocol Transport & AmneziaWG Stealth Obfuscation
-- Implements WireGuard, AmneziaWG, OpenVPN, and VLESS/Xray transport selection and DPI-bypass parameters.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_transport VARCHAR(32) NOT NULL DEFAULT 'wireguard' CHECK (default_transport IN ('wireguard', 'amneziawg', 'openvpn', 'vless'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_stealth_config JSONB DEFAULT NULL;

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS transport VARCHAR(32) NOT NULL DEFAULT 'wireguard' CHECK (transport IN ('wireguard', 'amneziawg', 'openvpn', 'vless'));
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS stealth_config JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_nodes_transport ON nodes(transport);
CREATE INDEX IF NOT EXISTS idx_organizations_default_transport ON organizations(default_transport);
