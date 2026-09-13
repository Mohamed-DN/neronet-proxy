const express = require('express');
const router = express.Router();
const { checkHealth } = require('../db/index');
const { checkValkeyHealth } = require('../db/valkey');
const { auditHealth } = require('../utils/audit');

router.get('/health', async (req, res) => {
  let dbHealth = { status: 'disconnected', type: 'unknown' };
  let valkeyHealth = { status: 'disconnected', type: 'unknown' };
  let isHealthy = true;

  try {
    dbHealth = await checkHealth();
    if (dbHealth.status === 'disconnected') {
      isHealthy = false;
    }
  } catch (err) {
    dbHealth = { status: 'disconnected', type: 'unknown', error: err.message };
    isHealthy = false;
  }

  try {
    valkeyHealth = await checkValkeyHealth();
  } catch (err) {
    valkeyHealth = { status: 'disconnected', type: 'unknown', error: err.message };
  }

  const responseData = {
    status: isHealthy ? 'ok' : 'degraded',
    version: '4.0.0',
    database: dbHealth.status,
    database_type: dbHealth.type,
    postgis: dbHealth.postgis || 'inactive',
    valkey: valkeyHealth.status,
    valkey_type: valkeyHealth.type,
    // An audit ledger that is not recording is a compliance failure, not a log line.
    audit: auditHealth(),
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  };

  return res.status(isHealthy ? 200 : 503).json(responseData);
});

module.exports = router;
