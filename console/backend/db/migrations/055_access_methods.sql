-- Access methods a profile device can use (ADR 0036).
--
-- A profile device reaches its gateway by plain WireGuard (UDP), by WireGuard inside a
-- WebSocket on TCP 443, or by AmneziaWG. The method is a property of each profile device,
-- bounded by what the organisation allows (same ceiling pattern as allowed_transports) and
-- by what the device's gateway advertises.

-- The method the device's profile was made for. Existing devices are plain WireGuard.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS access_method VARCHAR(16) NOT NULL DEFAULT 'wireguard'
        CHECK (access_method IN ('wireguard', 'wireguard-wss', 'amneziawg'));

-- The UDP port of the AmneziaWG listener a gateway reported at registration (capability
-- awg-v1). The host is never reported: it is the host of the endpoint an administrator
-- named for the gateway, so a node cannot send people to an address of its own choosing.
ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS awg_port INTEGER
        CHECK (awg_port IS NULL OR (awg_port BETWEEN 1 AND 65535));

-- Methods the organisation allows. Plain WireGuard is always allowed; the other two are
-- off until an administrator turns them on.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS allowed_access_methods TEXT[] NOT NULL DEFAULT ARRAY['wireguard', 'wireguard-wss']::TEXT[]
        CHECK (allowed_access_methods <@ ARRAY['wireguard', 'wireguard-wss', 'amneziawg']::TEXT[]
               AND 'wireguard' = ANY (allowed_access_methods));

-- The AmneziaWG obfuscation parameters of the organisation (Jc, Jmin, Jmax, S1-S4, H1-H4),
-- generated at random by the console the first time an administrator turns the method on.
-- NULL until then. Treated like a key: never logged, never shown in the console after
-- generation, sent only to the organisation's own profile gateways and written into the
-- profile of the person who adds a device.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS awg_params JSONB
        CHECK (awg_params IS NULL OR jsonb_typeof(awg_params) = 'object');
