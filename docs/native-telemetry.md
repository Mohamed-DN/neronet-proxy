# Native device telemetry, version 1

The Go daemon reports cumulative counters read from its running wireguard-go
device and Go runtime `MemStats.Sys` in bytes. This is a separate contract from
the legacy heartbeat fields named `rx_bytes_sec` and `tx_bytes_sec`, which the
legacy buffer treats as increments. Do not send cumulative counters through those
fields.

## Protocol and authority

`pkg/control/types.go` defines the optional `telemetry` heartbeat object and the
registration response's `telemetry_session`. Generate both schema copies from
that Go source with `go run ./cmd/contractgen`.

Each successful registration issues a new server session inside the enrollment
transaction. Old nodes ignore that response field and continue their existing
heartbeat behavior. New nodes omit the new object when an older server does not
advertise a session. The new object always requires an actual per-node credential,
including in development where legacy unauthenticated heartbeats are permitted.

The object contains:

| Field | Meaning |
|---|---|
| `version` | Integer `1` |
| `session_id` | Session issued by the most recent registration |
| `sequence` | Increasing positive uint64 decimal string within that session |
| `counter_epoch` | Positive uint64 decimal string identifying a comparable device counter baseline |
| `source` | `wireguard-device` |
| `traffic_available` | Whether the device counters were read successfully |
| `rx_bytes`, `tx_bytes` | Cumulative unsigned decimal strings; omitted when unavailable |
| `memory_runtime_sys_bytes` | Go runtime Sys bytes as an unsigned decimal string |

Decimal strings preserve every uint64 value through Go JSON, PostgreSQL
`NUMERIC(20,0)` and JavaScript. They are not JavaScript numbers. Memory is neither
host RAM usage nor a percentage. A measurement failure does not suppress the
heartbeat's liveness, policy or revocation work.

Ingestion holds the shared enrollment/destruction lifecycle lock, locks the node,
owner, organization and credential, and serializes the node's observation row.
The watermark, counters, payload digest and server receipt timestamp commit in
one PostgreSQL transaction, independently of Valkey and its legacy flush process.
The server rechecks credential expiry/revocation after obtaining these locks.
Current ownership must match the scope captured when the session was issued.

Identical retries of one sequence succeed without changing the receipt timestamp.
An altered retry, older sequence, older counter epoch, or a decreasing counter
within one epoch returns 409. A changed session or ownership returns the distinct
`native_telemetry_session_changed` code; the daemon enters its proof-based
re-registration path. This also handles an observation session invalidated by a
database restore. Re-registration clears the previous observation and requires a
fresh measurement.

## Counter continuity and meaning

The data plane advances its incarnation epoch when the peer set changes. Reading
the peer set and its epoch shares the same lock as peer configuration. Removing
and re-adding a peer between observations therefore cannot silently reuse the old
baseline, even when its new counters have already exceeded the old values.
The sampler also changes its epoch for an observed individual counter decrease
or a change in measurement availability.

Counters describe the current WireGuard peer set, including protocol overhead,
authenticated handshake traffic and keepalives. They are not application payload
totals or lifetime node totals. Upstream describes the counter increments in
[receive.go](https://git.zx2c4.com/wireguard-go/tree/device/receive.go) and
[send.go](https://github.com/WireGuard/wireguard-go/blob/master/device/send.go).
They do not identify the selected UDP/DERP path. Per-peer authenticated path
observations remain part of the separate T0 integration.

## Reading observations

`GET /api/stats/native-telemetry` requires console authentication. It resolves
current database authority and filters tenant, member ownership and hidden
compartments before returning even node IDs or unknown rows. A snapshot captured
under a former owner or tenant is not exposed to the new scope.

Each visible node has `unknown`, `fresh` or `stale` status, exact string counters,
runtime byte memory, receipt time, sequence and a generation identifier. Missing
measurements return null values. Freshness expires after 60 seconds according to
the same PostgreSQL clock that recorded receipt; duplicate delivery and unrelated
legacy heartbeats cannot freshen it. Stale values remain explicitly historical.

Consumers must subtract integer counters before converting a rate to a floating
point display value. Derive a rate only between fresh, available measurements of
the same source and generation. A fresh observation means it was recently received;
it is not proof that a particular peer or application is reachable.

**Integration boundary:** the existing fleet overview, historical charts and node
DTO still use the legacy metric path. This change provides the authenticated native
feed and scoped read API; chart integration and source-aware history are subsequent
delivery gates. The old memory column's unit mismatch is not silently reinterpreted.

## Reproduce the traffic measurement

On an exclusively owned running test stack:

```sh
COMPOSE_PROJECT_NAME=my-native-test NERONET_PORT_OFFSET=1900 \
  sh scripts/dev/scenarios/overlay.sh telemetry
```

Every selected node sends a 256 KiB payload through its real local SOCKS proxy to
every other selected overlay address and verifies the full echo. The scenario
requires new native observation sequences in one generation and checks that each
node's RX and TX increments cover at least the useful payload in both directions.
Protocol traffic alone cannot satisfy that lower bound. Use
`NERONET_NODE_SERVICES` to select additional running Compose nodes.

The CLI's bounded `NERONET_OVERLAY_PAYLOAD_BYTES` option controls payload size for
this measurement; ordinary reachability probes retain their small marker. The CI
stack smoke includes this scenario. Unit and HTTP tests additionally cover exact
integers, duplicates, ordering, epoch changes, credential revocation while waiting,
scope changes, unknown and stale observations, and legacy compatibility.
