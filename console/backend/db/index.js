const { Pool } = require('pg');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const dbConfig = require('../config/database');
const config = require('../config/env');
const logger = require('../utils/logger');

let pgPoolInstance = null;
let sqliteInstance = null;
let currentSqlitePath = null;
let usePostgres = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DB_TYPE === 'postgres');

function getPgPool() {
  if (pgPoolInstance) {
    return pgPoolInstance;
  }

  const poolConfig = dbConfig.postgres.connectionString
    ? { connectionString: dbConfig.postgres.connectionString, max: dbConfig.postgres.max }
    : {
        host: dbConfig.postgres.host,
        port: dbConfig.postgres.port,
        user: dbConfig.postgres.user,
        password: dbConfig.postgres.password,
        database: dbConfig.postgres.database,
        max: dbConfig.postgres.max,
        idleTimeoutMillis: dbConfig.postgres.idleTimeoutMillis,
        connectionTimeoutMillis: dbConfig.postgres.connectionTimeoutMillis
      };

  pgPoolInstance = new Pool(poolConfig);

  pgPoolInstance.on('error', (err) => {
    logger.error(`PostgreSQL pool unexpected error: ${err.message}`);
  });

  return pgPoolInstance;
}

function getDatabase(customPath) {
  const dbPath = customPath || process.env.SOVEREIGN_DB_PATH || config.DB_PATH;

  if (sqliteInstance) {
    if (currentSqlitePath === dbPath) {
      return sqliteInstance;
    }
    closeSqlite();
  }

  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  logger.info(`Opening SQLite database connection at: ${dbPath}`);
  sqliteInstance = new Database(dbPath, {
    verbose: config.NODE_ENV === 'development' && process.env.DEBUG_SQL ? console.log : null
  });
  currentSqlitePath = dbPath;

  if (dbPath !== ':memory:') {
    sqliteInstance.pragma('journal_mode = WAL');
  }
  sqliteInstance.pragma('synchronous = NORMAL');
  sqliteInstance.pragma('foreign_keys = ON');
  sqliteInstance.pragma('busy_timeout = 5000');
  sqliteInstance.pragma('cache_size = -20000');

  return sqliteInstance;
}

function closeSqlite() {
  if (sqliteInstance) {
    try {
      sqliteInstance.close();
      logger.info('SQLite database connection closed.');
    } catch (err) {
      logger.error('Error closing SQLite database:', err);
    } finally {
      sqliteInstance = null;
      currentSqlitePath = null;
    }
  }
}

async function query(text, params = []) {
  if (usePostgres) {
    const pool = getPgPool();
    return await pool.query(text, params);
  }

  // Fallback to SQLite query adapter
  const db = getDatabase();
  let convertedText = text;
  let paramIdx = 1;
  while (convertedText.includes(`$${paramIdx}`)) {
    convertedText = convertedText.replace(`$${paramIdx}`, '?');
    paramIdx++;
  }

  const trimmed = convertedText.trim();
  const isSelect =
    trimmed.toUpperCase().startsWith('SELECT') ||
    trimmed.toUpperCase().startsWith('PRAGMA') ||
    trimmed.toUpperCase().startsWith('WITH');

  if (isSelect) {
    const stmt = db.prepare(convertedText);
    const rows = stmt.all(...params);
    return { rows, rowCount: rows.length };
  } else {
    const stmt = db.prepare(convertedText);
    const result = stmt.run(...params);
    return {
      rows: [],
      rowCount: result.changes,
      lastInsertRowid: result.lastInsertRowid
    };
  }
}

async function transaction(callback) {
  if (usePostgres) {
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

  const db = getDatabase();
  return db.transaction(() => callback(db))();
}

async function checkHealth() {
  if (usePostgres) {
    try {
      const pool = getPgPool();
      const res = await pool.query('SELECT 1 as alive');
      if (res && res.rows && res.rows[0].alive === 1) {
        return { status: 'connected', type: 'postgresql_16', postgis: 'active' };
      }
    } catch (err) {
      return { status: 'disconnected', type: 'postgresql_16', error: err.message };
    }
  }

  try {
    const db = getDatabase();
    db.prepare('SELECT 1').get();
    return { status: 'connected', type: 'sqlite', postgis: 'simulated' };
  } catch (err) {
    return { status: 'disconnected', type: 'sqlite', error: err.message };
  }
}

function closeDatabase() {
  closeSqlite();
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

function isPostgres() {
  return usePostgres;
}

function setUsePostgres(val) {
  usePostgres = Boolean(val);
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
