'use strict';

/**
 * Where a node is (ADR 0042).
 *
 * Nothing in the control plane measures a node's position. The country is NULL until
 * someone states it, and it carries who stated it: an owner or administrator through the
 * console ('declared'), or the node operator through the node's own configuration
 * ('agent'). No default country and no invented coordinates exist anywhere; a rule that
 * needs a country treats NULL as "does not match", never as a pass.
 */

const { COUNTRY_NAMES } = require('../utils/countries');

const SOURCES = ['declared', 'agent'];
// Organisation roles that may read where a device is, besides the device's own owner.
const LOCATION_READERS = ['owner', 'admin', 'network_admin', 'auditor'];
// Organisation roles that may state where a device is.
const LOCATION_WRITERS = ['owner', 'admin', 'network_admin'];

/**
 * An ISO 3166-1 alpha-2 code the console knows by name. Returns the upper-case code, or
 * null for anything else, so a typo cannot become a place.
 */
function parseCountry(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && Object.prototype.hasOwnProperty.call(COUNTRY_NAMES, code) ? code : null;
}

/** Latitude and longitude, stated together and in range, or null. */
function parseCoordinates(latitude, longitude) {
  if (latitude === null || longitude === null || latitude === '' || longitude === '') return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { latitude: lat, longitude: lon };
}

/** Whether `user` may state a device's location. */
function canDeclare(user) {
  return user.role === 'super-admin' || LOCATION_WRITERS.includes(user.org_role || user.role);
}

/**
 * Whether `user` may read where `row` is: the same organisation's owner, admin, network
 * admin and auditor, the device's own owner, and the platform super-admin.
 */
function canSee(user, row) {
  if (!user || !row) return false;
  if (user.role === 'super-admin') return true;
  if ((user.organization_id || 'org-default') !== (row.organization_id || 'org-default')) return false;
  if (row.user_id && row.user_id === user.id) return true;
  return LOCATION_READERS.includes(user.org_role || user.role);
}

module.exports = { SOURCES, LOCATION_READERS, LOCATION_WRITERS, parseCountry, parseCoordinates, canDeclare, canSee };
