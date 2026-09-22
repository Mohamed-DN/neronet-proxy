const http = require('http');
const express = require('express');
const config = require('./config/env');
const logger = require('./utils/logger');
const corsMiddleware = require('./middleware/cors');
const requestLogger = require('./middleware/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { cookieParser } = require('./utils/cookies');

const { getPgPool, closeDatabase } = require('./db/index');
const { runMigrations } = require('./db/migrator');
const { seedDatabase, bootstrapPostgresAdmin } = require('./db/seed');
const goBridgeRoutes = require('./routes/goBridge');
const HeartbeatBuffer = require('./services/HeartbeatBuffer');
const { initValkey, reportValkeyState, closeValkey } = require('./db/valkey');
const { initTopologySync } = require('./services/TopologySync');
const { startCollector } = require('./services/MetricsCollector');
const { initTopologyWebSocket } = require('./ws/topologyServer');

// Import Route Handlers
const metricsRoutes = require('./routes/metrics');
const requestMetrics = require('./middleware/requestMetrics');
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
const canaryRoutes = require('./routes/canary');
const preauthKeysRoutes = require('./routes/preauthKeys');
const organizationsRoutes = require('./routes/organizations');
const compartmentsRoutes = require('./routes/compartments');
const ModuleLoader = require('./services/ModuleLoader');
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
  app.use(cookieParser);
  app.use(requestLogger);
  app.use(requestMetrics);

  // Prometheus Metrics Endpoints (Root /metrics and /api/metrics)
  app.use('/metrics', metricsRoutes);
  app.use('/api/metrics', metricsRoutes);

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
  app.use('/api/preauth-keys', preauthKeysRoutes);
  app.use('/api/organizations', organizationsRoutes);
  app.use('/api/compartments', compartmentsRoutes);

  // Load and mount discrete feature modules (WP-107: nuke, onion, deniability)
  ModuleLoader.loadModules(app);

  // The canary router remains accessible at /api/nuke/canary.txt and /.well-known/canary.txt
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

    const pool = getPgPool();
    await runMigrations(pool);
    await bootstrapPostgresAdmin(pool);

    const { getControlPlaneKeypair } = require('./services/ControlPlaneKeyService');
    getControlPlaneKeypair();

    if (process.env.SOVEREIGN_BOOTSTRAP_PREAUTH_KEY) {
      const { ensureBootstrapKey } = require('./services/PreAuthKeyService');
      const adminRes = await pool.query(
        "SELECT id FROM users WHERE role = 'super-admin' ORDER BY created_at ASC LIMIT 1"
      );
      if (adminRes.rows.length > 0) {
        await ensureBootstrapKey(process.env.SOVEREIGN_BOOTSTRAP_PREAUTH_KEY, adminRes.rows[0].id);
      }
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
