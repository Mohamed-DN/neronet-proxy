# ADR 0037: Connection order, automatic by default, editable at every scope

Status: accepted (design), implementation after ADR 0036's AmneziaWG lands. 18 November 2026.

## Context

ADR 0036 makes the access method a per-device choice and adds AmneziaWG, VLESS + REALITY and
OpenVPN next to WireGuard and WireGuard over 443. The owner wants WireGuard mesh by default with
automatic fallback, and wants Settings to let the organisation, a sub-network (line), a device and
the person decide the order or force one method.

## Decision

**Connection order** = an ordered list of methods (`wireguard`, `wireguard-wss`, `amneziawg`,
`vless-reality`, `openvpn`, later `ikev2`), plus a flag `forced` meaning "only the first".

Scopes, most specific wins, each bounded by the one above:

1. **Organisation**: `allowed` (the ceiling) and the base order. Default: "Automatico" =
   `wireguard → wireguard-wss → amneziawg` (VLESS/OpenVPN allowed only when enabled).
2. **Line (compartment)**: inherit, or its own order (subset of allowed).
3. **Device**: inherit, or its own order, or forced single method.
4. **Person**: if the organisation enables "i membri possono scegliere", a member may set the order
   or force a method for their own devices, within the line/organisation ceiling; an admin setting
   with `locked` prevents it.
5. **Node-to-node link**: the two ends' orders are intersected; the link uses the first method in
   the more restrictive end's order that both ends support and the gateway/relays advertise.

Resolution is computed by the console (one pure function, tested exhaustively) and sent in the
netmap as the effective order per device and per peer link, with its **origin** ("da linea
Viaggiatori") so the UI can show where it came from.

Runtime: node agents and our apps walk the effective order with health checks (UDP reachability →
next method after a bounded timeout), remember the last working method per network for a while, and
report the method in use. Stock-app profile devices cannot walk an order: the portal writes the
profile for the first method and offers the alternatives as separate downloads.

When the two ends of a link have no method in common, the link is in an explicit **no path** state,
shown on the map and in the policy view, never a silent failure (research, 18 Nov: disabling relays
on one end strands links in Nebula/Tailscale-style systems). Relay use is a visible permission in the
order, not a hidden device switch. Precedents: Mullvad's "Automatic" obfuscation (fallback after
failed connects), Tailscale nodeAttrs scoping, Nebula `use_relays`, AmneziaVPN's per-server protocol
bundles.

Safety: a change that would leave a device with no method its gateway runs is refused; a stricter
order shows a preview of devices that would lose connectivity (as the map editor does); every change
is audited with before/after.

UI: Settings → "Ordine di connessione" (organisation), line menu (map editor) and device detail each
show an ordered, toggleable list with drag and up/down buttons, "Eredita da …" vs "Personalizzato",
and "Forza solo il primo". Device detail and the map show the method actually in use.

## Consequences

- One resolution function shared by netmap, preview and UI; extensive table tests.
- Netmap grows by an effective order per device and per link (small).
- Methods appear in the UI only when some gateway advertises them.
