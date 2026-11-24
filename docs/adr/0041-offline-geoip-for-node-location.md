# ADR 0041: Offline GeoIP for node location (follow-up design)

Status: proposed (design only, nothing implemented). 23 November 2026.

## Context

ADR 0040 makes location a stated value: unknown unless an administrator or the node operator says
where a device is. That is true but sparse. A measured source would fill the gaps without asking
anyone to type a country.

## Proposal

Resolve the country of a device's **public endpoint** on the control plane server, from an offline
database, and store it as `location_source = 'geoip'` with the date of the database used.

- The database is a file on the server (an MMDB country database). Lookups are local; the address is
  never sent to a third party and the database is never fetched at request time.
- It is a source below `declared` and `agent`: a stated value always wins, and a GeoIP value is shown
  as "approximate, from the network address".
- It is country level only. City and coordinates are not taken from GeoIP: they imply a precision the
  data does not have.

## Trade-offs

- **Accuracy.** Mobile carriers, VPNs, CGNAT, and anycast addresses place a device in the wrong country
  often enough that the value must be labelled approximate and must never feed a country rule
  (allow or prohibit lists, exit selection) unless an administrator turns that on per policy.
- **Licence.** Free country databases carry attribution and redistribution terms. A database cannot
  be committed to this public repository; the operator supplies it, and the build ships none.
- **Freshness.** Address allocations move; the database needs a refresh schedule and the stored value
  keeps the database date so stale ones can be found.
- **Privacy.** A public endpoint is personal data. Resolving it locally keeps it on the server; the
  result is visible only to the readers ADR 0040 names.
- **Cost.** One file read per endpoint change, no network, no new service.

## Not decided

Whether a GeoIP value may satisfy a country rule at all, and how an administrator would opt in.
