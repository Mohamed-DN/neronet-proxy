const Redis = require('ioredis');
const crypto = require('crypto');
const EventEmitter = require('events');
const dbConfig = require('../config/database');
const logger = require('../utils/logger');

/**
 * Optional prefix isolating this process's keys and channels from others sharing the
 * same Valkey instance.
 *
 * Without it every test process talked to one namespace: a topology event published
 * by one test file arrived at a subscriber in another, and token blacklist entries
 * outlived the suite that wrote them. The result was a suite that passed alone and
 * failed intermittently together -- which is worse than failing outright, because it
 * teaches everyone to re-run until green.
 *
 * It also matters in production: several deployments sharing one Valkey (a common
 * homelab shortcut) would otherwise cross-talk in exactly the same way.
 */
// The literal {pid} is substituted with this process's id. Node's test runner gives
// each test file its own process but one shared environment, so a namespace fixed
// for the whole run still lets files cross-talk; only a per-process value isolates
// them. In production the token is simply absent and the namespace is used verbatim.
const NAMESPACE = (process.env.SOVEREIGN_VALKEY_NAMESPACE || '').trim().replace('{pid}', String(process.pid));
const prefix = NAMESPACE ? `${NAMESPACE}:` : '';

const TOPOLOGY_CHANNEL = `${prefix}neronet:topology:events`;

let valkeyClient = null;
let valkeySubscriber = null;
let isConnected = false;
const inMemoryBus = new EventEmitter();
const inMemoryBlacklist = new Map(); // tokenHash -> expiresAtTimestamp

function hashToken(token) {
  if (!token) return '';
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

function initValkey() {
  if (valkeyClient) {
    return { client: valkeyClient, subscriber: valkeySubscriber };
  }

  try {
    const opts = {
      ...dbConfig.valkey,
      retryStrategy(times) {
        if (times > 3) {
          logger.warn('Valkey connection retries exceeded. Operating with in-memory state bus.');
          return null; // stop retrying
        }
        return Math.min(times * 100, 1000);
      }
    };

    const client = new Redis(dbConfig.valkey.url, opts);
    const subscriber = new Redis(dbConfig.valkey.url, opts);

    client.on('connect', () => {
      isConnected = true;
      logger.info('Connected to Valkey 7 / Redis cluster.');
    });

    client.on('error', (err) => {
      isConnected = false;
      // Suppress spammy connection errors during offline local dev / testing
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        // Fallback silently active
      } else {
        logger.warn(`Valkey client notice: ${err.message}`);
      }
    });

    subscriber.on('error', (err) => {
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ENOTFOUND') {
        logger.warn(`Valkey subscriber notice: ${err.message}`);
      }
    });

    valkeyClient = client;
    valkeySubscriber = subscriber;
  } catch (err) {
    logger.warn('Could not initialize Valkey client, utilizing in-memory state bus fallback.');
    isConnected = false;
  }

  return { client: valkeyClient, subscriber: valkeySubscriber };
}

async function publishTopologyEvent(payload) {
  const message = typeof payload === 'string' ? payload : JSON.stringify(payload);

  // One path or the other, never both. Subscribers listen on the in-memory bus and
  // on Valkey, so emitting to both delivered every event twice -- which stayed
  // invisible for as long as the Valkey connection was never actually established.
  if (valkeyClient && isConnected) {
    try {
      await valkeyClient.publish(TOPOLOGY_CHANNEL, message);
      return;
    } catch (err) {
      logger.warn(`Failed to publish to Valkey channel ${TOPOLOGY_CHANNEL}: ${err.message}`);
      // Fall through to the local bus rather than dropping the event.
    }
  }

  inMemoryBus.emit(TOPOLOGY_CHANNEL, message);
}

function subscribeTopologyEvents(handler) {
  initValkey();

  // The local bus is the fallback path for when Valkey is unreachable; publish only
  // ever uses one of the two, so listening on both does not duplicate.
  inMemoryBus.on(TOPOLOGY_CHANNEL, (msg) => {
    try {
      const data = typeof msg === 'string' ? JSON.parse(msg) : msg;
      handler(data);
    } catch (e) {
      handler(msg);
    }
  });

  if (valkeySubscriber && isConnected) {
    valkeySubscriber.subscribe(TOPOLOGY_CHANNEL, (err) => {
      if (err) {
        logger.warn(`Failed to subscribe to Valkey channel ${TOPOLOGY_CHANNEL}: ${err.message}`);
      }
    });

    valkeySubscriber.on('message', (channel, message) => {
      if (channel === TOPOLOGY_CHANNEL) {
        try {
          const data = JSON.parse(message);
          handler(data);
        } catch (e) {
          handler(message);
        }
      }
    });
  }
}

async function blacklistToken(token, ttlSeconds = 900) {
  if (!token) return;
  const th = hashToken(token);
  const key = `${prefix}blacklist:token:${th}`;
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;

  inMemoryBlacklist.set(th, expiresAt);

  if (valkeyClient && isConnected) {
    try {
      await valkeyClient.set(key, '1', 'EX', ttlSeconds);
    } catch (err) {
      logger.warn(`Valkey blacklist set error: ${err.message}`);
    }
  }
}

async function isTokenBlacklisted(token) {
  if (!token) return false;
  const th = hashToken(token);

  // Check in-memory blacklist
  const exp = inMemoryBlacklist.get(th);
  if (exp) {
    if (Date.now() < exp) {
      return true;
    }
    inMemoryBlacklist.delete(th);
  }

  if (valkeyClient && isConnected) {
    try {
      const exists = await valkeyClient.get(`${prefix}blacklist:token:${th}`);
      if (exists) return true;
    } catch (err) {
      // Fallback
    }
  }

  return false;
}

async function checkValkeyHealth() {
  if (valkeyClient && isConnected) {
    try {
      const ping = await valkeyClient.ping();
      if (ping === 'PONG') {
        return { status: 'connected', type: 'valkey_7' };
      }
    } catch (e) {
      // disconnected
    }
  }

  // Degraded, and named as such. This state means the token blacklist, the topology
  // bus and rate limiting are per-process: a token revoked on one instance stays
  // valid on the others, and every limit is multiplied by the number of replicas.
  // Reporting it as an "active" state made a broken integration look like a design.
  return {
    status: 'degraded',
    type: 'in_memory_fallback',
    detail: 'Valkey is unreachable: revocation, topology events and rate limits are per-process only'
  };
}

/**
 * Warn loudly at startup when Valkey is configured but not reachable.
 *
 * Called once the connection has had a chance to establish. Silence here is how an
 * integration stays broken for months: the fallback works, so nothing fails.
 */
async function reportValkeyState() {
  const health = await checkValkeyHealth();

  if (health.status === 'connected') {
    logger.info('Valkey connected: revocation, topology events and rate limits are shared across instances.');
  } else {
    logger.warn(`Valkey is NOT connected (${dbConfig.valkey.url}). ${health.detail}`);
  }

  return health;
}

function closeValkey() {
  if (valkeyClient) {
    try {
      valkeyClient.disconnect();
    } catch (e) {}
    valkeyClient = null;
  }
  if (valkeySubscriber) {
    try {
      valkeySubscriber.disconnect();
    } catch (e) {}
    valkeySubscriber = null;
  }
  isConnected = false;
}

/**
 * The connected Valkey client, or null when it is unavailable.
 *
 * Callers that need to degrade gracefully (the rate limiter, for one) check this
 * rather than letting every call throw.
 */
function getValkeyClient() {
  return isConnected && valkeyClient ? valkeyClient : null;
}

module.exports = {
  TOPOLOGY_CHANNEL,
  reportValkeyState,
  NAMESPACE,
  getValkeyClient,
  initValkey,
  publishTopologyEvent,
  subscribeTopologyEvents,
  blacklistToken,
  isTokenBlacklisted,
  checkValkeyHealth,
  closeValkey,
  hashToken
};
