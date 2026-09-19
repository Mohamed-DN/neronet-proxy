const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const logger = require('../utils/logger');
const { isTokenBlacklisted } = require('../db/valkey');
const { registerWsBroadcaster } = require('../services/TopologySync');

let wss = null;
const clients = new Set();

function authenticateSocket(req) {
  try {
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

    if (!token) {
      return null;
    }

    const decoded = jwt.verify(token, config.JWT_SECRET);
    return {
      token,
      user: {
        id: decoded.sub || decoded.id,
        username: decoded.username,
        role: decoded.role,
        tier: decoded.tier
      }
    };
  } catch (err) {
    return null;
  }
}

function initTopologyWebSocket(httpServer) {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    if (parsedUrl.pathname !== '/ws/topology') {
      return; // allow other upgrade handlers if any
    }

    const authResult = authenticateSocket(req);
    if (!authResult) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const isBlacklisted = await isTokenBlacklisted(authResult.token);
    if (isBlacklisted) {
      socket.write('HTTP/1.1 401 Unauthorized (Token Revoked)\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = authResult.user;
      ws.token = authResult.token;
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

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (message) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
        }
      } catch (e) {
        // Ignore malformed text frames
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info(`WebSocket client disconnected: ${ws.user.username} [Total: ${clients.size}]`);
    });

    ws.on('error', (err) => {
      logger.warn(`WebSocket client socket error: ${err.message}`);
      clients.delete(ws);
    });
  });

  // Heartbeat ping interval
  const pingInterval = setInterval(() => {
    if (!wss) return;
    for (const ws of clients) {
      if (ws.isAlive === false) {
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
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

function broadcastTopologyMessage(payload) {
  if (clients.size === 0) return;

  const dataString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const dataObj = typeof payload === 'string' ? JSON.parse(payload) : payload;

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      // Role-based visibility scoping
      if (client.user.role === 'super-admin') {
        client.send(dataString);
      } else {
        // Tenant users only see events related to their own nodes or global relays
        if (
          !dataObj.user_id ||
          dataObj.user_id === client.user.id ||
          dataObj.node?.user_id === client.user.id ||
          dataObj.node?.role === 'RELAY' ||
          dataObj.node?.role === 'EXIT_BRIDGE'
        ) {
          client.send(dataString);
        }
      }
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
  getConnectedClientsCount
};
