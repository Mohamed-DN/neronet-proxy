# ADR 0010: Cloud PC is frozen behind a server-side feature flag

- Status: Accepted (reviewer's recommendation under delegated authority, 2026-09-19)
- Date: 2026-09-19
- Decision label: D4

## Context

The Cloud PC feature has a registry of instances and custom domains that work as
database records. The streaming does not exist: instances point at a signalling host
that does not resolve, and there is no streaming server behind it. The feature is
presented in the console as if it worked.

For banks and public administration, remote desktop access is a real need, but the
right way to provide it is to integrate Apache Guacamole over the overlay once the data
plane exists, not to grow this code.

Options:

- Freeze the feature behind a flag that is off by default (chosen).
- Keep it active. That means keeping and fixing the session and gateway authentication
  of a feature that cannot connect.

## Decision

The feature is frozen. The flag is `SOVEREIGN_FEATURE_CLOUD_PC`, off by default. With
the flag off, every `/api/cloud-pc` path answers 404, including the public
custom-domain gateway, and the console hides the menu entry because `/api/features`
reports the feature off. The flag is read by the server; the client does not decide.

## Consequences

- Implemented in `272baa7`. The console component is `components/CloudPc.jsx`.
- The code stays in the tree, unmaintained. Enabling the flag in a deployment is not
  supported, and the authentication of the feature has to be reviewed before it is.
- Remote desktop access is planned as a Guacamole integration after the data plane
  ([ADR 0008](0008-wireguard-data-plane-transport.md)) and is not scheduled.
