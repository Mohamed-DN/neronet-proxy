'use strict';

/**
 * "Something about this device changed" (ADR 0042).
 *
 * Handshake, round trip, status and location changes are announced on the existing
 * topology socket as `node:updated`, carrying the device id and nothing else about it:
 * the event only says to read again. The organisation and owner ids ride along because
 * the socket delivers an event to the right people with them, never to another
 * organisation. Announcements are debounced per device, so a gateway reporting four
 * thousand peers every beat sends one event per device that really changed.
 */

const logger = require('../utils/logger');

const DEBOUNCE_MS = Number(process.env.SOVEREIGN_NODE_UPDATED_DEBOUNCE_MS || 1000);
const EVENT = 'node:updated';

const timers = new Map();
// Replaced in tests; the default publishes on the topology channel.
async function defaultPublisher(nodeId) {
  const { getPgPool } = require('../db/index');
  const { broadcastNodeEvent } = require('./TopologySync');
  const res = await getPgPool().query('SELECT id, user_id, organization_id FROM nodes WHERE id = $1', [nodeId]);
  if (!res.rows[0]) return;
  await broadcastNodeEvent(EVENT, {
    id: res.rows[0].id,
    user_id: res.rows[0].user_id,
    organization_id: res.rows[0].organization_id || 'org-default'
  });
}

let publisher = defaultPublisher;

function setPublisher(fn) {
  publisher = fn || defaultPublisher;
}

function fire(nodeId) {
  Promise.resolve(publisher(nodeId)).catch((err) => logger.warn(`node:updated for ${nodeId} not sent: ${err.message}`));
}

/** Announce that `nodeId` changed. The first call in a window arms the timer; the rest are absorbed. */
function notifyNodeUpdated(nodeId, { immediate = false } = {}) {
  if (!nodeId) return;
  if (immediate) {
    const pending = timers.get(nodeId);
    if (pending) clearTimeout(pending);
    timers.delete(nodeId);
    fire(nodeId);
    return;
  }
  if (timers.has(nodeId)) return;
  const handle = setTimeout(() => {
    timers.delete(nodeId);
    fire(nodeId);
  }, DEBOUNCE_MS);
  if (typeof handle.unref === 'function') handle.unref();
  timers.set(nodeId, handle);
}

function notifyMany(nodeIds) {
  for (const id of nodeIds) notifyNodeUpdated(id);
}

/** Drop pending timers (shutdown and tests). */
function reset() {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
}

module.exports = { EVENT, notifyNodeUpdated, notifyMany, setPublisher, reset };
