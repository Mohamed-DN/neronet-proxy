# Radial mesh topology

The topology page places coordination at the centre and groups peer nodes around
it. This is a map layout: peer traffic does not pass through the control plane.
Connections use straight segments with a clear gap behind the coordination
annotation. They stop short of peer node bodies; they do not bend around the
centre or attach to it.

Groups default to compartments; region and role are alternatives. Groups with
more than 16 members start collapsed. Search reveals matching nodes. Operators
can expand groups, select nodes, pan, zoom, and use the accessible list.
The graph uses the available page width. Selecting a peer or policy pair opens
an inspector beside the graph, without covering neighbours. Closing it restores
the overview and returns keyboard focus to the graph. Health warnings remain
visible in both expanded and folded groups.

## What a connection means

- **Allowed connections** come from the policy view. Cutting or restoring a link
  still uses ACL rules. Permission alone does not prove reachability.
- **Observed paths** require authenticated peer measurements. Those measurements
  are not available in the current API, so this view explicitly says **not
  measured** and draws no peer paths. A manually configured link mode is not a
  transport observation.
- A node that is unhealthy is labelled unhealthy in both the inspector and list;
  quarantine remains a separate state.

The centre represents coordination, not a router or DERP relay. Relay selection,
UDP/DERP failover, handshake freshness and traffic counters need the transport
work package before they can be shown as observed facts.

## Verification and limits

Component tests exercise grouping, search, keyboard selection, policy actions,
vault visibility, health labels and the absence of invented path measurements.
The semantic class merger also preserves foreground colours independently of
custom font sizes; browser contrast must be checked after theme transitions end.

Large browser fixtures validate the display, not a fleet of real VPN tunnels.
Server aggregation and peer telemetry remain separate work. The console's
existing narrow-window guard still requires a desktop viewport of at least
1024 pixels; mobile console usability remains open.
