// Latency model for the fleet simulator. No dependencies, no randomness: the same
// inputs give the same numbers, so a failing run can be reproduced.
//
// One-way delay between two points:
//
//   distance_km / fibre_speed_km_s * route_factor + access_delay_a + access_delay_b
//
// route_factor is 1.6 by default because fibre does not follow the great circle. A
// few pairs are far from that average (no direct cable, or a path through another
// continent); regions.json lists a factor for each of them, derived from a published
// round trip.

const EARTH_RADIUS_KM = 6371.0088;

export const DEFAULT_MODEL = Object.freeze({
  fibre_speed_km_s: 200000,
  route_factor: 1.6,
  path_jitter_fraction: 0.01
});

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres (haversine). */
export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/**
 * Build the model from a parsed regions.json: the base parameters, the access
 * profiles by name and the route-factor overrides by unordered location pair.
 */
export function modelFromCatalogue(catalogue) {
  const overrides = new Map();
  for (const entry of catalogue.route_factors ?? []) {
    overrides.set(pairKey(entry.a, entry.b), entry.factor);
  }
  return { ...DEFAULT_MODEL, ...catalogue.model, profiles: catalogue.profiles, overrides };
}

function accessOf(point, model) {
  if (point.access) return point.access;
  const profile = model.profiles?.[point.profile];
  if (!profile) {
    throw new Error(`point ${point.id ?? '?'} has neither an access object nor a known profile (${point.profile})`);
  }
  return profile;
}

/** Route factor for a pair: the catalogue override for their location ids, else the default. */
export function routeFactor(a, b, model = DEFAULT_MODEL) {
  const override = model.overrides?.get(pairKey(a.location ?? a.id, b.location ?? b.id));
  return override ?? model.route_factor;
}

/**
 * Model one path between two points. Points carry lat, lon and either an `access`
 * object ({delay_ms, jitter_ms, loss_pct}) or the name of a profile in the model. The
 * result is per direction and identical both ways.
 */
export function link(a, b, model = DEFAULT_MODEL) {
  const km = distanceKm(a, b);
  const factor = routeFactor(a, b, model);
  const propagationMs = (km / model.fibre_speed_km_s) * factor * 1000;

  const accessA = accessOf(a, model);
  const accessB = accessOf(b, model);

  const oneWayMs = propagationMs + accessA.delay_ms + accessB.delay_ms;
  const jitterMs =
    Math.sqrt(accessA.jitter_ms ** 2 + accessB.jitter_ms ** 2) + propagationMs * model.path_jitter_fraction;
  // Independent losses on the two access networks.
  const lossPct = (1 - (1 - accessA.loss_pct / 100) * (1 - accessB.loss_pct / 100)) * 100;

  return {
    distance_km: km,
    route_factor: factor,
    propagation_ms: propagationMs,
    one_way_ms: oneWayMs,
    jitter_ms: jitterMs,
    loss_pct: lossPct,
    rtt_ms: 2 * oneWayMs
  };
}

/** Round trip through the backbone alone, without either access network. */
export function backboneRttMs(a, b, model = DEFAULT_MODEL) {
  return 2 * (distanceKm(a, b) / model.fibre_speed_km_s) * routeFactor(a, b, model) * 1000;
}
