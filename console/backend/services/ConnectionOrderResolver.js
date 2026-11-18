'use strict';

/**
 * Connection order (ADR 0037): the pure part. No database, no clock, no I/O.
 *
 * A connection order is an ordered list of access methods plus a flag `forced` meaning "only the
 * first". Five scopes set it, the most specific one wins and each is bounded by the one above:
 *
 *   organisation  the ceiling (allowed methods) and the base order; default "Automatico"
 *   line          inherit, or its own subset of the ceiling
 *   device        inherit, or its own order inside what the line enables, or forced single
 *   person        only if the organisation lets members choose; bounded by the line; an
 *                 administrator's `locked` on the line or the device prevents it
 *   link          the two ends of a node-to-node link intersect their orders
 *
 * `resolve` answers for one device: the effective order and where it came from.
 */

const WIREGUARD = 'wireguard';
const WIREGUARD_WSS = 'wireguard-wss';
const AMNEZIAWG = 'amneziawg';

/** Selectable methods, in the order Automatico tries them. */
const METHODS = [WIREGUARD, WIREGUARD_WSS, AMNEZIAWG];
const DEFAULT_ORDER = METHODS.slice();
/** Names the design reserves; they cannot be selected until a gateway can run them. */
const RESERVED_METHODS = ['vless-reality', 'openvpn', 'ikev2'];

const isList = (value) => Array.isArray(value) && value.length > 0;

/** `list` reduced to known methods inside `bound`, first occurrence kept. Never throws. */
function clean(list, bound) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (typeof m !== 'string' || !METHODS.includes(m) || !bound.includes(m) || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/** The ceiling the organisation allows; plain WireGuard is always inside it. */
function ceilingOf(allowed) {
  const list = Array.isArray(allowed) ? allowed : [];
  return METHODS.filter((m) => m === WIREGUARD || list.includes(m));
}

/**
 * Check an order a person typed before it is stored. `null` means "inherit". A list must hold
 * between one and three known methods, none twice; reserved names are refused with their own code
 * so the console can say "not available yet".
 */
function validateOrder(value) {
  if (value === null) return { ok: true, order: null };
  if (!Array.isArray(value) || value.length === 0) return { ok: false, code: 'invalid_order' };
  const seen = new Set();
  for (const m of value) {
    if (typeof m !== 'string') return { ok: false, code: 'invalid_order' };
    if (RESERVED_METHODS.includes(m)) return { ok: false, code: 'method_reserved' };
    if (!METHODS.includes(m) || seen.has(m)) return { ok: false, code: 'invalid_order' };
    seen.add(m);
  }
  return { ok: true, order: value.slice() };
}

/**
 * The effective order for one device.
 *
 * input:
 *   organization { allowed, order, forced, membersMayChoose }
 *   line         { id, name, order, forced, locked }            optional
 *   device       { id, order, forced, locked, ownerSet }        optional
 *   person       { order, forced }                              optional
 *   available    methods the device's gateway can run           optional
 *
 * output: { order, forced, origin, clamped, personBlocked, usable }
 *   origin         { scope: 'default' | 'organization' | 'line' | 'device' | 'person', id?, name? }
 *   clamped        a scope's own order held nothing the bound allows, so it inherited instead
 *   personBlocked  null | 'not_enabled' | 'locked': why a person's own setting was not applied
 *   usable         the order is not empty (always true when `available` is not given)
 */
function resolve(input) {
  const { organization, line, device, person, available } = input || {};
  const org = organization || {};
  const ceiling = ceilingOf(org.allowed);

  let order = DEFAULT_ORDER.filter((m) => ceiling.includes(m));
  let forced = false;
  let origin = { scope: 'default' };
  let clamped = false;

  // One scope's own setting, inside `bound`. An empty or absent order inherits silently; an order
  // that the bound empties inherits and says so.
  const apply = (setting, bound, name) => {
    if (!setting || !isList(setting.order)) return false;
    const own = clean(setting.order, bound);
    if (own.length === 0) {
      clamped = true;
      return false;
    }
    forced = Boolean(setting.forced);
    order = forced ? [own[0]] : own;
    origin = name(setting);
    return true;
  };

  apply(org, ceiling, () => ({ scope: 'organization' }));
  // A forced organisation is a ceiling of one method; otherwise a line may use anything allowed.
  const lineBound = org.forced && origin.scope === 'organization' ? order.slice() : ceiling;
  apply(line, lineBound, (l) => ({ scope: 'line', id: l.id, name: l.name }));
  const lineSet = order.slice();

  const ownerSet = Boolean(device && device.ownerSet && isList(device.order));
  const deviceApplied = apply(device, lineSet, (d) => (d.id === undefined ? { scope: 'device' } : { scope: 'device', id: d.id }));

  let personBlocked = null;
  if (person && isList(person.order) && !(deviceApplied && ownerSet)) {
    if (!org.membersMayChoose) personBlocked = 'not_enabled';
    else if ((line && line.locked) || (device && device.locked)) personBlocked = 'locked';
    else apply(person, lineSet, () => ({ scope: 'person' }));
  }

  let usable = true;
  if (Array.isArray(available)) {
    order = order.filter((m) => available.includes(m));
    usable = order.length > 0;
  }
  return { order, forced, origin, clamped, personBlocked, usable };
}

/**
 * The method a link between two nodes uses (ADR 0037, item 5). Both ends' orders are intersected;
 * the link walks the order of the more restrictive end (fewer methods), and a tie falls back to the
 * canonical order unless both ends already agree, so the answer is the same from either side.
 * `advertised` (optional) is what the gateway and relays on the path carry.
 *
 * Nothing in common is an explicit `no_path`, never a silent failure.
 */
function resolveLink({ a, b, advertised } = {}) {
  const listA = clean(a, METHODS);
  const listB = clean(b, METHODS);
  const carried = Array.isArray(advertised) ? advertised : METHODS;
  const shared = (list) => list.filter((m) => listA.includes(m) && listB.includes(m) && carried.includes(m));

  let restrictive;
  let order;
  if (listA.length < listB.length) {
    restrictive = 'a';
    order = shared(listA);
  } else if (listB.length < listA.length) {
    restrictive = 'b';
    order = shared(listB);
  } else {
    restrictive = 'tie';
    const sameOrder = listA.every((m, i) => m === listB[i]);
    order = shared(sameOrder ? listA : METHODS);
  }
  return { method: order[0] || null, order, no_path: order.length === 0, restrictive };
}

module.exports = {
  WIREGUARD,
  WIREGUARD_WSS,
  AMNEZIAWG,
  METHODS,
  DEFAULT_ORDER,
  RESERVED_METHODS,
  ceilingOf,
  clean,
  validateOrder,
  resolve,
  resolveLink
};
