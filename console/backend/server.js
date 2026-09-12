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
const { initValkey, closeValkey } = require('./db/valkey');
const { initTopologySync } = require('./services/TopologySync');
const { initTopologyWebSocket } = require('./ws/topologyServer');

// Import Route Handlers
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const nodesRoutes = require('./routes/nodes');
const configsRoutes = require('./routes/configs');
const appsRoutes = require('./routes/apps');
const nerodropRoutes = require('./routes/nerodrop');
const statsRoutes = require('./routes/stats');
const peeringRoutes = require('./routes/peering');
const riskRoutes = require('./routes/risk');
const geofencingRoutes = require('./routes/geofencing');
const cloudPcRoutes = require('./routes/cloudPc');
const nukeRoutes = require('./routes/nuke');

function createApp() {
  const app = express();

  // Core Middleware
  app.use(corsMiddleware);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // Mount API Sub-Routers
  
  // Go mesh data-plane bridge. See routes/goBridge.js for the wire contract.
  app.use('/v4/control', goBridgeRoutes);

  app.use('/api', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/nodes', nodesRoutes);
  app.use('/api/nodes', riskRoutes);
  app.use('/api/configs', configsRoutes);
  app.use('/api/apps', appsRoutes);
  app.use('/api/nerodrop', nerodropRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/audit', statsRoutes);
  app.use('/api/peering', peeringRoutes);
  app.use('/api/risk', riskRoutes);
  app.use('/api/geofencing', geofencingRoutes);
  app.use('/api/cloud-pc', cloudPcRoutes);
  app.use('/api/nuke', nukeRoutes);
  app.use('/', nukeRoutes);

  // 404 & Global Error Handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function initDatabase() {
  try {
    config.assertProductionSecrets();
    initValkey();
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
  initDatabase().then(() => {
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
  }).catch((err) => {
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
