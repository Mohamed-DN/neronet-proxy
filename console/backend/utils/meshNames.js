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
  return !OFF.has(
    String(env.SOVEREIGN_MESH_DNS || '')
      .trim()
      .toLowerCase()
  );
}

/**
 * The suffix of an organisation's mesh names: its search domain, else its slug under
 * ".neronet", else "mesh". NetmapService and the profile answer must agree on it.
 */
function effectiveSearchDomain(searchDomain, orgSlug) {
  return searchDomain || (orgSlug ? `${orgSlug}.neronet` : 'mesh');
}

const LABEL_MAX = 63;

/**
 * The DNS label of a device name: accents dropped, lowercase, every run of characters outside
 * a-z0-9 a hyphen, no hyphen at either end, at most 63 characters. Empty when nothing is left.
 * migrations/053_device_dns_names.sql computes the same string for existing rows; change both
 * together.
 */
function slugLabel(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, LABEL_MAX)
    .replace(/-$/, '');
}

/** The label with a collision suffix: n 1 is the bare label, n 2 gives "<label>-2". */
function labelWithSuffix(label, n) {
  if (n <= 1) return label;
  const suffix = `-${n}`;
  return `${label.slice(0, LABEL_MAX - suffix.length).replace(/-$/, '')}${suffix}`;
}

module.exports = { MESH_DNS, meshDnsEnabled, effectiveSearchDomain, slugLabel, labelWithSuffix };
