# ADR 0040: Location, round trip and the connection test tell the truth

Status: accepted. 23 November 2026.

## Context

Three things the console showed were not measurements.

- **Location.** `nodes.country_code` defaulted to `'US'`, and several writers added their own
  `'US'` (profile devices, the Go agent's `-country` flag, the config generator, the stats views),
  plus Washington or Frankfurt coordinates for nodes created by hand. A device whose position
  nothing had measured or stated was shown in the United States.
- **Response time.** `nodes.latency_ms` is the gateway's HTTP heartbeat round trip to the
  console. It was labelled "Response time", and a profile device (a phone on the stock WireGuard
  app) never has one.
- **Connection test.** The button posted `/nodes/:id/action` with `ping`, which sent nothing and
  returned the last stored number.

## Decision

### Location

1. Unknown is `NULL`. There is no default country and no invented coordinates anywhere: backend,
   Go agent, config generator. The UI says "Location unknown" / "Posizione sconosciuta".
2. The only sources: an owner, admin or network admin states it in the device detail
   (`PUT /api/nodes/:id/location`, validated ISO code, audited, `location_source = 'declared'`),
   or the node operator sets `SOVEREIGN_COUNTRY_CODE` / `-country` on the node
   (`location_source = 'agent'`). No GeoIP lookup and no bundled database (see ADR 0041).
3. A rule that requires a country never passes on unknown: the Go posture engine reports an
   unverified "country was not reported" instead of skipping the check, a country filter in
   discovery and circuit building never matches `NULL`, and the routing engine refuses a request
   without a country rather than answering with an unknown exit.
4. Privacy: country, city, coordinates and public endpoints are visible only to the owner, admin,
   network admin and auditor of the same organisation, to the device's own owner and to the
   platform super-admin. `/v4/control/discover` is scoped to the caller's organisation (a node
   credential: its own; the fleet token: the organisation fleet-token enrolment lands in), and
   another organisation's peer carries no country or city and never matches a country filter.
   `/metrics` and `/v4/control/circuit` carry no location.
5. Migration 060 drops the default and `NOT NULL`, adds the two-letter check, and clears what a
   default wrote: profile devices with `'US'` and no stated source; rows whose coordinates are the
   two hard-coded ones (the coordinates, and the country only when it is `'US'`); and agent-enrolled
   rows with `'US'` and no stated source, which cannot be told from the old flag default. The next
   registration sets the country again if the operator configured it explicitly. Values kept are
   attributed to the agent. Re-running it changes nothing.

### Response time

6. The serving Go gateway pings each profile device through its netstack
   (`pkg/dataplane Device.Ping`) every 30 s with +-20 % jitter, at most 8 at a time, 3 s timeout,
   and only for a device with a handshake in the last 180 s. It reports `rtt_ms` (nullable) and
   `rtt_observed_at_unix` in `PeerPathObservation`. The control plane stores value, time and method
   (`icmp`) and believes it only from the gateway that serves the device.
7. A timeout is "no reply": a null value with the time it was tried. It is never a number and never
   "offline" (Windows blocks ping by default). A mode that cannot ping (kernel TUN) and a closing
   device record nothing.
8. AmneziaWG devices are carried on their own wireguard device that the netstack does not hold; a
   ping would never be answered, so they are not measured. WireGuard-over-WSS devices share the
   main device and are measured. Mesh peers are not pinged by the gateway: their row says not
   measured.
9. `latency_ms` keeps meaning the heartbeat's round trip to the console, now also exposed as
   `console_link_ms` and shown as "Link with the console" ("Collegamento con la console").

### Connection test

10. `POST /api/nodes/:id/probe` writes one request (one live per device, 2 s between asks, 20 per
    person per minute, expires after 30 s; the device owner or an administrator). The gateway
    holds `POST /v4/control/probe/poll` open (up to 20 s; the control plane re-reads every 250 ms,
    so it works across replicas without pub/sub), pings at once and answers on
    `/v4/control/probe/result`. Typical time from click to answer: one poll step plus the ping,
    well inside 5 s. The heartbeat response was rejected as the carrier: it beats every 15 s and a
    response cannot start anything sooner than the next beat. The gateway can only be asked about
    devices in its own netmap; the console names a node id, never an address.
11. States shown: measuring; replied in X ms (ICMP, time); no reply within 3 s but connected (last
    contact, and one sentence that Windows blocks ping); not connected; gateway not reachable.
    The figure is always the request's own, never a stored one.

### Live

12. Handshake, round trip, status and location changes publish `node:updated` on the existing
    topology socket, carrying the device id (plus organisation and owner ids, which the socket needs
    to deliver it only to the right people), debounced per device. The console refetches on it and,
    as a fallback, every 10 s while the tab is visible. Each value shows its age.

## Behaviour changes to be aware of

- Devices and nodes that showed `US` now show "Location unknown" until stated.
- A posture policy with an allow or prohibit country list now yields "unverified" for a node that
  states no country (before: the country check was skipped and the node could be compliant).
- `GET /v4/control/discover` with the fleet token no longer lists other organisations' nodes.
- Node `latency_ms` is no longer set to an invented 15.0 / 10.0 when a node is created by hand.
- Coordinates a node operator stated now carry `location_source = 'agent'` (was `'declared'`).
