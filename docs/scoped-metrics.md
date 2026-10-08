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
and `/bandwidth`. They do not certify the authorization of other administration,
audit, recovery or session endpoints.

## History and rates

The leader collects node samples once per minute. One SQL statement captures each
fleet snapshot, including the node's organization, owner and hidden-compartment
state. Samples are retained for 169 hours. Reads require both current visibility
and matching capture-time organization and ownership. Previously hidden samples
remain hidden from standard sessions after a compartment becomes visible.

Existing global `system_metrics` samples remain stored. They have no trustworthy
node or tenant attribution and are not backfilled into scoped history. A new
installation initially returns an empty series and unknown throughput.

Rates require two comparable snapshots. A change in the visible source nodes makes
both rates unknown for that interval; the next stable interval establishes a rate.
An observed counter decrease on any source makes that direction unknown even when
the fleet total increased. The other direction can remain measured. Internal source
IDs are used for these comparisons and are not added to the statistics response.

Unknown rates are JSON `null`, not zero. Legacy fields named `*_mb_s`, `rx` and
`tx` retain their existing binary conversion: bytes divided by 1,048,576 per second
(MiB/s). Overview values round to two decimals, history values to three; small
measured traffic can therefore display as zero. `memory_usage_pct` exposes the
legacy stored memory column; its units are not certified (see below). The historical
`memory_usage_mb` chart field is `null` rather than inferring a memory size from
that column. CPU remains unknown when no node reports a measured nonzero value.

## Limits

The current native Go heartbeat does not populate RX/TX counters. Live TCP can
therefore work while these stored counters stay zero; zero in this deployment
does not establish idle traffic. Authentic WireGuard counter delivery and freshness
require a separate node/control-plane telemetry change. Native memory is sent as
`memory_usage_mb` but the backend stores it in a column named `memory_usage_pct`;
these values must not be interpreted as a measured percentage until that contract
and its consumers are corrected.

Node counters currently have no boot or generation identifier. A reset that occurs
and grows past the prior counter between observations cannot be detected by these
samples. History records heartbeat counters, not authenticated per-peer transport
observations or packet captures. Large-fleet query performance, highly available
leader fencing and session revocation across all routes require separate gates.

Regression coverage uses real PostgreSQL, the collector and authenticated HTTP
handlers in `stats_scope.test.js` and `stats_rates.test.js`. Production readiness
also requires the complete backend suite and dedicated live-node checks.
