const http = require('http');
const express = require('express');
const config = require('./config/env');
const logger = require('./utils/logger');
const corsMiddleware = require('./middleware/cors');
const requestLogger = require('./middleware/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const { getDatabase, isPostgres, getPgPool, closeDatabase } = require('./db/index');
const { runMigrations } = require('./db/migrator');
const { seedDatabase, bootstrapPostgresAdmin } = require('./db/seed');
const goBridgeRoutes = require('./routes/goBridge');
const HeartbeatBuffer = require('./services/HeartbeatBuffer');
const { initValkey, reportValkeyState, closeValkey } = require('./db/valkey');
const { initTopologySync } = require('./services/TopologySync');
const { startCollector } = require('./services/MetricsCollector');
const { initTopologyWebSocket } = require('./ws/topologyServer');

// Import Route Handlers
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const nodesRoutes = require('./routes/nodes');
const configsRoutes = require('./routes/configs');
const statsRoutes = require('./routes/stats');
const peeringRoutes = require('./routes/peering');
const riskRoutes = require('./routes/risk');
const aclRoutes = require('./routes/acl');
const geofencingRoutes = require('./routes/geofencing');
const cloudPcRoutes = require('./routes/cloudPc');
const nukeRoutes = require('./routes/nuke');
const canaryRoutes = require('./routes/canary');
const securityHeaders = require('./middleware/securityHeaders');
const { requireFeature } = require('./middleware/featureFlag');
const { apiLimiter, enrolmentLimiter } = require('./middleware/rateLimit');

function createApp() {
  const app = express();

  // Trust exactly one proxy hop: the nginx container in front of this service.
  //
  // Without this every request reports nginx's address as req.ip. Rate limiting by
  // address would then put the whole world in one bucket, so a single attacker
  // locks everybody out, and every audit event records the wrong origin. `true`
  // would be worse than nothing: it makes Express believe whatever X-Forwarded-For
  // a client sends, which lets an attacker forge a fresh identity per request and
  // bypass the limiter entirely.
  app.set('trust proxy', Number(process.env.SOVEREIGN_TRUST_PROXY_HOPS || '1'));

  app.disable('x-powered-by');

  // Core Middleware
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(requestLogger);

  // Mount API Sub-Routers

  // Go mesh data-plane bridge. See routes/goBridge.js for the wire contract.
  // Enrolment allocates an overlay address from a finite pool, so it is metered
  // separately and more tightly than ordinary API traffic.
  app.use('/v4/control', enrolmentLimiter, goBridgeRoutes);

  // Baseline budget for every API caller. Endpoint-specific limiters (sign-in,
  // registration) are mounted inside their routers and apply on top of this.
  app.use('/api', apiLimiter);

  app.use('/api', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/nodes', nodesRoutes);
  app.use('/api/nodes', riskRoutes);
  app.use('/api/configs', configsRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/audit', statsRoutes);
  app.use('/api/peering', peeringRoutes);
  app.use('/api/risk', riskRoutes);
  app.use('/api/acl', aclRoutes);
  app.use('/api/geofencing', geofencingRoutes);
  app.use('/api/cloud-pc', requireFeature('cloud_pc'), cloudPcRoutes);
  app.use('/api/nuke', nukeRoutes);
  // The nuke router is mounted at /api/nuke and nowhere else. It used to be mounted
  // at the root as well, so that the warrant canary could be fetched from
  // /.well-known/canary.txt -- which also published every self-destruct and dead
  // man's switch route outside /api, and therefore outside the API rate limiter.
  // Only the canary needs a root address; it keeps its /api/nuke address too,
  // because that is the one /api/nuke/state advertises and the console follows.
  app.use('/api/nuke', canaryRoutes);
  app.use('/', canaryRoutes);

  // 404 & Global Error Handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function initDatabase() {
  try {
    config.assertProductionSecrets();
    initValkey();
    // Give the connection a moment, then say plainly whether it came up. Without
    // this the in-memory fallback is indistinguishable from a working cache.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await reportValkeyState();
    HeartbeatBuffer.startFlusher();
    initTopologySync();

    if (isPostgres()) {
      const pool = getPgPool();
      await runMigrations(pool);
      // Without this a PostgreSQL deployment migrates cleanly and then has no
      // account anyone can log in with: seedDatabase is SQLite-only.
      await bootstrapPostgresAdmin(pool);
    } else {
      const db = getDatabase();
      runMigrations(db);
      seedDatabase(db);
    }

    // After migrations: the collector writes to system_metrics, which the
    // migrations create.
    startCollector();
    logger.info('Database and services initialized and ready.');
  } catch (err) {
    logger.error('Database initialization error:', err);
    throw err;
  }
}

const app = createApp();
let server = null;
let wss = null;

if (require.main === module) {
  initDatabase()
    .then(() => {
      server = http.createServer(app);
      wss = initTopologyWebSocket(server);

      server.listen(config.PORT, config.HOST, () => {
        logger.info(`=======================================================`);
        logger.info(`🚀 NeroNet Management Console Control Plane API running`);
        logger.info(`📡 HTTP: http://${config.HOST}:${config.PORT}`);
        logger.info(`🔌 WebSocket: ws://${config.HOST}:${config.PORT}/ws/topology`);
        logger.info(`🔒 Environment: ${config.NODE_ENV}`);
        logger.info(`=======================================================`);
      });
    })
    .catch((err) => {
      logger.error('Fatal startup error:', err);
      process.exit(1);
    });

  const shutdown = () => {
    logger.info('Gracefully stopping NeroNet Console Control Plane...');
    if (server) {
      server.close(() => {
        closeDatabase();
        closeValkey();
        process.exit(0);
      });
    } else {
      closeDatabase();
      closeValkey();
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { app, createApp, initDatabase };
