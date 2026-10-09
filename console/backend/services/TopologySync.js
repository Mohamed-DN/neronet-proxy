const { publishTopologyEvent, subscribeTopologyEvents, TOPOLOGY_CHANNEL } = require('../db/valkey');
const logger = require('../utils/logger');

let wsBroadcastHandler = null;

function registerWsBroadcaster(broadcaster) {
  wsBroadcastHandler = broadcaster;
}

function initTopologySync() {
  subscribeTopologyEvents((eventData) => {
    if (wsBroadcastHandler && typeof wsBroadcastHandler === 'function') {
      try {
        Promise.resolve(wsBroadcastHandler(eventData)).catch((err) => {
          logger.error(`Error in WebSocket broadcast distributor: ${err.message}`);
        });
      } catch (err) {
        logger.error(`Error in WebSocket broadcast distributor: ${err.message}`);
      }
    }
  });
  logger.info(`TopologySync service active on channel '${TOPOLOGY_CHANNEL}'`);
}

async function broadcastNodeEvent(eventType, nodeData, actorUser = null) {
  const payload = {
    event: eventType,
    node: nodeData,
    node_id: nodeData?.id,
    user_id: nodeData?.user_id,
    // The WebSocket fan-out delivers an event only within its organisation.
    organization_id: await organizationOf(nodeData),
    action: eventType,
    actor: actorUser ? { id: actorUser.id, username: actorUser.username } : null,
    timestamp: new Date().toISOString()
  };

  await publishTopologyEvent(payload);
}

/**
 * The organisation a node event belongs to: the node's, else its owner's. Callers pass
 * whatever they have, sometimes only id, name and owner (a deleted node).
 */
async function organizationOf(nodeData) {
  if (!nodeData) return null;
  if (nodeData.organization_id) return nodeData.organization_id;
  try {
    const { getPgPool } = require('../db/index');
    const pool = getPgPool();
    if (nodeData.id) {
      const res = await pool.query('SELECT organization_id FROM nodes WHERE id = $1', [nodeData.id]);
      if (res.rows[0]) return res.rows[0].organization_id || 'org-default';
    }
    if (nodeData.user_id) {
      const res = await pool.query('SELECT organization_id FROM users WHERE id = $1', [nodeData.user_id]);
      if (res.rows[0]) return res.rows[0].organization_id || 'org-default';
    }
  } catch (err) {
    // Unknown organisation: the event then reaches the super-admin and the owner only.
  }
  return null;
}

module.exports = {
  initTopologySync,
  registerWsBroadcaster,
  broadcastNodeEvent,
  publishTopologyEvent,
  TOPOLOGY_CHANNEL
};
