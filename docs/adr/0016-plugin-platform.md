# ADR 0016: A plugin platform for extra and customer-specific functions

- Status: Accepted (maintainer's requirement, design by the reviewer, 2026-09-20)
- Date: 2026-09-20
- Decision label: D9

## Context

The maintainer wants the system to accept plugins: for functions the project adds later
and for functions a customer needs. [ADR 0015](0015-high-risk-features-on-by-default.md)
already turns the high-risk features into modules with a hard boundary. Customer code is
different from first-party code: it is not reviewed by the project, and the customers are
banks and public bodies, where an unreviewed extension inside the control plane is a risk
that fails an audit.

## Decision

There are two tiers, with different trust.

**Tier 1, first-party modules.** In-process, shipped with the product, removable from a
build (ADR 0015). They may use the core interface directly.

**Tier 2, plugins.** Custom or third-party, never run inside the control plane process.

- **Server plugins run out of process**, as their own container or process, and talk to the
  core through a versioned HTTP and JSON API (the plugin API). The core proxies their
  routes under `/api/plugins/<id>/`, authenticates the caller, applies the organisation's
  permissions, and passes on only the identity and scope the plugin was granted.
- **A manifest declares everything**: id, version, the API version it targets, the routes,
  the events it subscribes to, the permissions it asks for, the data it stores, and its
  console pages. Nothing outside the manifest is reachable.
- **Least privilege.** A plugin receives a scoped token. It has no database access; it
  stores its data through a core key-value API scoped to its id and to the organisation.
  It can read node and policy data only through granted permissions.
- **Signed and allow-listed.** The manifest and the package carry an Ed25519 signature.
  An administrator installs a plugin, sees the requested permissions, and enables it per
  organisation. The instance verifies the signature against a trusted key list. Unsigned
  plugins are refused unless the instance is explicitly in development mode.
- **Events, not hooks into internals.** The core publishes events (node registered,
  policy changed, audit written, module state changed) to plugins that subscribed; a
  plugin can answer a small set of decision points (for example an extra check before a
  node is admitted) with a timeout and a fail-closed or fail-open setting declared in the
  manifest and shown to the administrator.
- **Console pages are sandboxed.** A plugin page is a static bundle served from this
  origin and shown in a sandboxed iframe; it talks to the console through a small
  `postMessage` API and never touches the shell's token. The strict content security
  policy is unchanged.
- **Node plugins run out of process.** A node capability written by a third party is a
  separate process reached over a local Unix socket with a versioned protocol. Go dynamic
  loading is not used. A WebAssembly runtime is an option for later.
- **Everything is audited**: install, enable, disable, permission grants, every call to
  the decision points, and every rejected signature.
- **Removable**: disabling or removing a plugin needs no change to the core, and a build
  can exclude the plugin loader entirely.

## Consequences

- The plugin API is a public contract with a version. Breaking it needs a new API
  version and a deprecation period.
- The core needs a gateway, a key-value store API, an event bus with delivery and retry,
  a signing and trust store, and an installation console for administrators.
- A reference plugin and a plugin test kit ship with the platform, and the platform is
  tested with a deliberately hostile plugin (oversized responses, slow responses, calls
  outside its grant, a forged signature).
- The plugin platform is built after the first-party modules, because the module
  boundary is what the platform reuses.
