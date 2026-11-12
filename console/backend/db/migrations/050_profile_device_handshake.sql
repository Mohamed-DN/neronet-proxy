-- ADR 0029: a profile device runs the stock WireGuard app and never heartbeats, so
-- last_heartbeat says nothing about it. Its organisation's profile gateway reports the
-- device's last WireGuard handshake on its own authenticated heartbeat; this is that
-- time. NULL means no gateway has reported one (not measured), never "offline".
-- Written only for device_kind = 'profile' rows, only from that device's own gateway.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_handshake_at TIMESTAMPTZ;
