# ADR 0027: Community graph console with explicit evidence boundaries

- Status: Proposed
- Date: 2026-10-29
- Scope: Console interaction and future graph analytics

## Context

NeroNet belongs to the DarkNero product family. The owner chose Graphify as the
primary visual reference, superseding earlier preferences for a fixed radial
layout and straight edges. Earlier plans remain historical context. The intended
service name is `neronet.darknero.com`; this decision does not configure DNS,
publish a service or demonstrate certificate issuance for that name.

The current topology API supplies inventory and policy pairs. A transport label
is not proof that packets used that transport. Device counters also cannot
establish a path between a particular pair of peers.

## Decision

Use an organic community graph with searchable inventory groups, visibility and
folding controls, selection, an accessible equivalent list, and a peer inspector.
Keep the existing React stack and local assets. Positions should remain stable
when metrics refresh, search changes or an inventory group is hidden.

Community colors identify inventory groups; they neither indicate health nor
grant access. Show health and quarantine through separate text and marks.
Computing a graph neighborhood means exploring the supplied policy pairs, not
installing a route or proving an observed path. Denied pairs must not contribute
to reachable neighborhoods. Existing policy actions retain their server-side
authorization and enforcement behavior.

Keep separate models for inventory, policy, authenticated observations and a
possible future knowledge graph. Server-side authorization must precede counts,
aggregation, clustering, pagination and exports. A graph algorithm cannot infer
permission to view a hidden compartment. Never send private operational records
to a model as a prerequisite for rendering the graph.

Do not embed an upstream generated HTML document or a knowledge-graph server in
the authenticated console. An optional future analytics process should consume
an explicit, authorized snapshot. Its suggestions cannot mutate ACLs, relay
selection, node identity or routing without the normal authorized workflow.

## Upstream evidence

The source review used
[Graphify commit 0a8cd4e](https://github.com/Graphify-Labs/graphify/tree/0a8cd4e1e342235fe53e881fb5d591bf0460071f),
whose default branch was `v8` and package version was `0.9.97` at inspection.
The reviewed modules include `ARCHITECTURE.md`, `graphify/cluster.py`,
`graphify/analyze.py` and `graphify/exporters/html.py`.

The upstream HTML renderer offers search, community filters, inspection and
aggregated views. It uses vis-network 9.1.6 from a CDN, curved edges and initial
physics stabilization. These implementation choices are evidence about Graphify,
not mandatory dependencies or network semantics for NeroNet. Its Leiden/Louvain
communities describe an analytical grouping, not a security boundary.

The inspected `LICENSE` and `NOTICE` identify Apache-2.0 with historical MIT
contributions retained in `LICENSE-MIT`. No upstream implementation was copied
into NeroNet by this decision. Any later reuse must check the exact component,
dependencies and notices; the repository license alone does not cover every
possible package or asset.

## Alternatives

| Option | Benefit | Cost or limit |
| --- | --- | --- |
| Adapt interactions in the existing SVG renderer | Preserves console integration, local dependencies and accessibility controls | Layout and large-fleet behavior need their own measurements |
| Adopt another graph renderer | Potentially stronger layout or rendering performance | Requires evidence of need, dependency/license review, accessibility and offline asset qualification |
| Embed Graphify HTML/server | Quick visual demonstration | Different data and trust models, generated HTML and external assets; unsuitable as the operational console boundary |

Start with the existing renderer. Revisit Canvas/WebGL or a graph library only
when measured payload, CPU, DOM or interaction results justify the change.

## Acceptance and consequences

- Verify search, community filters, folding, selection, keyboard navigation,
  zoom, theme contrast, reduced motion and locale changes in the browser.
- Check initial edge visibility on moderate graphs; an empty-looking overview
  must not result from silently suppressing every ordinary policy pair.
- Keep large fleets aggregated or bounded. Record fixture sizes, machine,
  timings and DOM counts. Simulated 1,000-node graphs do not prove 1,000 tunnels.
- Keep observed paths explicitly unmeasured until authenticated telemetry from
  the transport implementation exists. Compare that future view against real
  overlay traffic, counters and captures, including failure and stale data.
- Test hidden data in API responses and aggregates; a client checkbox is a
  presentation control, never a tenant-isolation boundary.
- Qualify DNS, certificates, Origin, CSP, WebSockets and host-only cookies before
  serving the intended DarkNero domain. Do not share administrative cookies with
  the portfolio through a parent-domain cookie.

This decision does not qualify DERP failover, mobile clients, HA or production
readiness. Their existing delivery gates remain separate.
