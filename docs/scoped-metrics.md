# Scoped fleet statistics

The statistics overview, geographic distribution and bandwidth history filter
nodes before calculating totals. PostgreSQL is the supported production database.

## Access and visibility

Each request resolves the current account status, organization, platform role and
organization membership from PostgreSQL. An old signed access token cannot retain
an organization or platform role that the account no longer holds. Revoked and
deleted accounts receive HTTP 403 on these statistics endpoints.

Organization owners, admins, network admins and auditors see their organization's
visible nodes. Other members see their own nodes. Only a current platform
super-admin may select another organization with `org_id` or read platform totals.
The standard compartment tier excludes hidden compartments, including nodes that
inherit a hidden default compartment. The root compartment tier remains a separate
password-authenticated session capability; it does not remove tenant boundaries.

These rules cover `/api/stats`, `/overview`, `/geo`, `/geo-matrix`, `/timeseries`
and `/bandwidth`, plus node list/detail reads. They do not certify the authorization of other administration,
audit, recovery or session endpoints.

## History and rates

The leader collects node samples once per minute. One SQL statement captures each
fleet snapshot, including the node's organization, owner and hidden-compartment
state. Samples are retained for 169 hours. Reads require both current visibility
and matching capture-time organization and ownership. Previously hidden samples
remain hidden from standard sessions after a compartment becomes visible.

Existing global `system_metrics` and unversioned node samples remain stored.
Neither is backfilled into native evidence. Migration 037 adds nullable source
metadata and exact `NUMERIC(20,0)` counters to the scoped history table, preserving
the legacy columns. A new installation initially returns an empty series and
unknown throughput.

Rates require fresh, available WireGuard observations with advancing sequence and
receipt timestamps in the same server session and counter epoch. Repeated copies
of an observation are gaps, not measured zero rates. PostgreSQL subtracts exact
integer counters before dividing by each node's actual observation interval and
converting to floating-point display rates. A change in the visible source nodes makes
both rates unknown for that interval; the next stable interval establishes a rate.
An observed counter decrease on any source makes that direction unknown even when
the fleet total increased. The other direction can remain measured. Internal source
IDs and generations are used internally and are not added to aggregate responses.
The overview also requires its latest history sources to match the current native
generation; an old historical rate does not survive a newly restarted source.

Unknown rates are JSON `null`, not zero. Legacy fields named `*_mb_s`, `rx` and
`tx` retain their existing binary conversion: bytes divided by 1,048,576 per second
(MiB/s). Overview values round to two decimals, history values to three; small
measured traffic can therefore display as zero. Additional `*_bytes_s` overview
and `*_bytes_per_second` history fields preserve the unrounded numeric rates.

Totals are exact decimal strings, including sums exceeding one uint64. Current
fleet totals are `null` if any visible node lacks fresh available traffic; a
partial sum is not presented as the whole fleet. The `traffic` object describes
source, measured/partial/stale/unknown status and coverage counts, all filtered
before aggregation. Empty fleets have unknown traffic rather than measured zero.
Node DTO flat counters follow the same freshness rule; their `native_telemetry`
child explicitly distinguishes historical stale observations.

`memory_runtime_sys_bytes` is the exact sum of fresh Go runtime Sys byte values
only when every visible source measured it. It is not host RAM utilization.
`avg_memory_pct`, `memory_usage_pct` and historical `memory_usage_mb` return `null`;
legacy memory is never reinterpreted as a percentage. CPU remains unknown when no
node reports a measured nonzero value.

## Limits

Older nodes without native telemetry remain unknown. Native counters describe the
current WireGuard peer set and protocol traffic; summing both ends counts traffic
at both devices. They are not unique payload totals or lifetime node totals.
History records authenticated device observations, not per-peer transport
observations or packet captures. Large-fleet query performance, highly available
leader fencing and session revocation across all routes require separate gates.

Regression coverage uses real PostgreSQL, the collector and authenticated HTTP
handlers in `native_metrics.test.js`, `stats_scope.test.js` and `stats_rates.test.js`.
`scripts/dev/scenarios/overlay.sh metrics` verifies real TCP, overview, DTOs and
scheduled history; CI runs this scenario. These checks do not certify DERP path
telemetry, HA or client OS installation.
