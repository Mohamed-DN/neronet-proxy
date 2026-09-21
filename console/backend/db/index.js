const { Pool } = require('pg');
const dbConfig = require('../config/database');
const logger = require('../utils/logger');

let pgPoolInstance = null;

function getPgPool() {
  if (pgPoolInstance) {
    return pgPoolInstance;
  }

  const poolConfig = dbConfig.postgres.connectionString
    ? {
        connectionString: dbConfig.postgres.connectionString,
        max: dbConfig.postgres.max,
        idleTimeoutMillis: dbConfig.postgres.idleTimeoutMillis,
        connectionTimeoutMillis: dbConfig.postgres.connectionTimeoutMillis,
        ssl: dbConfig.postgres.ssl
      }
    : {
        host: dbConfig.postgres.host,
        port: dbConfig.postgres.port,
        user: dbConfig.postgres.user,
        password: dbConfig.postgres.password,
        database: dbConfig.postgres.database,
        max: dbConfig.postgres.max,
        idleTimeoutMillis: dbConfig.postgres.idleTimeoutMillis,
        connectionTimeoutMillis: dbConfig.postgres.connectionTimeoutMillis,
        ssl: dbConfig.postgres.ssl
      };

  pgPoolInstance = new Pool(poolConfig);

  pgPoolInstance.on('error', (err) => {
    logger.error(`PostgreSQL pool unexpected error: ${err.message}`);
  });

  return pgPoolInstance;
}

/**
 * Returns the active database connection pool.
 * Kept as getDatabase for compatibility with legacy call sites.
 */
function getDatabase() {
  return getPgPool();
}

function closeDatabase() {
  if (pgPoolInstance) {
    try {
      pgPoolInstance.end();
      logger.info('PostgreSQL connection pool closed.');
    } catch (err) {
      logger.error('Error closing PostgreSQL pool:', err);
    } finally {
      pgPoolInstance = null;
    }
  }
}

function closeSqlite() {
  // No-op kept for legacy interface compatibility
}

async function query(text, params = []) {
  const pool = getPgPool();
  return await pool.query(text, params);
}

async function transaction(callback) {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function checkHealth() {
  try {
    const pool = getPgPool();
    const res = await pool.query('SELECT 1 as alive');
    if (res && res.rows && res.rows[0].alive === 1) {
      return { status: 'connected', type: 'postgresql', version: '18' };
    }
  } catch (err) {
    return { status: 'disconnected', type: 'postgresql', error: err.message };
  }
  return { status: 'disconnected', type: 'postgresql', error: 'No response' };
}

function isPostgres() {
  return true;
}

function setUsePostgres() {
  // No-op: PostgreSQL is the only supported database
}

module.exports = {
  getPgPool,
  getDatabase,
  closeDatabase,
  closeSqlite,
  query,
  transaction,
  checkHealth,
  isPostgres,
  setUsePostgres
};
