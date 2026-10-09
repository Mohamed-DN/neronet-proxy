const { WebSocketServer, WebSocket } = require('ws');
const logger = require('../utils/logger');
const { resolveAccessToken, SessionAuthorityError } = require('../services/SessionAuthority');
const { registerWsBroadcaster } = require('../services/TopologySync');

let wss = null;
const clients = new Set();

async function authenticateSocket(req) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  let token = parsedUrl.searchParams.get('token');

  if (!token && req.headers['authorization']) {
    const authHeader = req.headers['authorization'];
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }
  }

  if (!token && req.headers['sec-websocket-protocol']) {
    token = req.headers['sec-websocket-protocol'].split(',')[0].trim();
  }

  if (!token) throw new SessionAuthorityError(401, 'Authentication required');
  return { token, ...(await resolveAccessToken(token)) };
}

function initTopologyWebSocket(httpServer) {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    if (parsedUrl.pathname !== '/ws/topology') {
      return; // allow other upgrade handlers if any
    }

    let authResult;
    try {
      authResult = await authenticateSocket(req);
    } catch (err) {
      const status = err.status || 503;
      const reason = status === 403 ? 'Forbidden' : status === 401 ? 'Unauthorized' : 'Service Unavailable';
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    if (socket.destroyed) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = authResult.user;
      ws.token = authResult.token;
      ws.expiresAt = authResult.expiresAt;
      ws.isAlive = true;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    logger.info(`WebSocket client connected: ${ws.user.username} (${ws.user.role}) [Total: ${clients.size}]`);

    // Send initial greeting handshake
    ws.send(
      JSON.stringify({
        type: 'CONNECTED',
        message: 'Connected to NeroNet Topology Real-Time Stream',
        user: ws.user,
        channel: 'neronet:topology:events',
        timestamp: new Date().toISOString()
      })
    );

    // An idle stream expires too; it must not depend on receiving a fleet event.
    let expiryTimer = null;
    const scheduleExpiry = () => {
      const remaining = ws.expiresAt - Date.now();
      if (remaining <= 0) {
        ws.close(1008, 'Session expired');
        return;
      }
      // Longer delays overflow Node's signed 32-bit timer and become one millisecond.
      expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, 2147483647));
      expiryTimer.unref();
    };
    if (ws.expiresAt) scheduleExpiry();

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (message) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === 'PING') {
          if (await refreshSocketAuthority(ws)) {
            ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
          }
        }
      } catch (e) {
        // Ignore malformed text frames
      }
    });

    ws.on('close', () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      clients.delete(ws);
      logger.info(`WebSocket client disconnected: ${ws.user.username} [Total: ${clients.size}]`);
    });

    ws.on('error', (err) => {
      logger.warn(`WebSocket client socket error: ${err.message}`);
      clients.delete(ws);
    });
  });

  // Heartbeat ping interval
  const pingInterval = setInterval(async () => {
    if (!wss) return;
    for (const ws of clients) {
      if (ws.isAlive === false) {
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      if (await refreshSocketAuthority(ws)) {
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, 30000);
  pingInterval.unref();

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  // Register broadcaster with TopologySync
  registerWsBroadcaster(broadcastTopologyMessage);

  logger.info('Topology WebSocket Server mounted at /ws/topology');
  return wss;
}

function closeTopologyWebSocket() {
  if (wss) {
    for (const client of clients) {
      try {
        client.terminate();
      } catch (e) {}
    }
    clients.clear();
    try {
      wss.close();
    } catch (e) {}
    wss = null;
  }
}

// Organisation roles that see the whole organisation's topology, as GET
// /api/stats/topology does. A member sees their own nodes.
const ORG_WIDE_ROLES = new Set(['owner', 'admin', 'network_admin', 'auditor']);

/**
 * Whether a topology event may go to a connected console user.
 *
 * The platform super-admin sees every event. Anyone else sees events of their own
 * organisation only: all of them with an organisation-wide role, their own nodes and
 * account otherwise. The previous rule sent every event that carried no user_id, and
 * every relay and exit node event, to every user: node names, addresses and account
 * wipes of other organisations included.
 */
function isVisibleTo(user, event) {
  if (!user) return false;
  if (user.role === 'super-admin') return true;

  const eventOrg = event.organization_id ?? event.node?.organization_id ?? null;
  const eventUser = event.user_id ?? event.node?.user_id ?? event.payload?.user_id ?? null;
  const own = Boolean(eventUser) && eventUser === user.id;

  if (eventOrg && eventOrg !== (user.organization_id || 'org-default')) return false;
  if (!eventOrg) return own;
  return own || ORG_WIDE_ROLES.has(user.org_role);
}

async function refreshSocketAuthority(client) {
  if (client.readyState !== WebSocket.OPEN) return false;
  try {
    const authority = await resolveAccessToken(client.token);
    if (client.readyState !== WebSocket.OPEN) return false;
    client.user = authority.user;
    return true;
  } catch {
    client.close(1008, 'Session no longer authorized');
    return false;
  }
}

async function broadcastTopologyMessage(payload) {
  if (clients.size === 0) return;

  const dataString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const dataObj = typeof payload === 'string' ? JSON.parse(payload) : payload;

  for (const client of clients) {
    if ((await refreshSocketAuthority(client)) && isVisibleTo(client.user, dataObj)) {
      client.send(dataString);
    }
  }
}

function getConnectedClientsCount() {
  return clients.size;
}

module.exports = {
  initTopologyWebSocket,
  closeTopologyWebSocket,
  broadcastTopologyMessage,
  getConnectedClientsCount,
  isVisibleTo
};
