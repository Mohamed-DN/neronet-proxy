/**
 * Mesh names for profile devices (ADR 0034): the one place that knows the resolver's address,
 * which names a device may get, and whether the switch is on.
 */

/** The mesh resolver inside the profile gateway's userspace stack. */
const MESH_DNS = '100.100.100.100';

const OFF = new Set(['off', 'false', '0', 'no']);

/**
 * SOVEREIGN_MESH_DNS, read the way the gateway reads it: on unless it says off. When it is
 * off the gateway does not answer 100.100.100.100 for a device without an exit, so a profile
 * must not point at it.
 */
function meshDnsEnabled(env = process.env) {
  return !OFF.has(String(env.SOVEREIGN_MESH_DNS || '').trim().toLowerCase());
}

/**
 * The suffix of an organisation's mesh names: its search domain, else its slug under
 * ".neronet", else "mesh". NetmapService and the profile answer must agree on it.
 */
function effectiveSearchDomain(searchDomain, orgSlug) {
  return searchDomain || (orgSlug ? `${orgSlug}.neronet` : 'mesh');
}

module.exports = { MESH_DNS, meshDnsEnabled, effectiveSearchDomain };
