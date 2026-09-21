const { Pool } = require('pg');
const { runPostgresMigrations } = require('../../db/migrator');
const { seedPostgresDatabase } = require('../../db/seed');
const { getPgPool, closeDatabase, setUsePostgres } = require('../../db/index');
const logger = require('../../utils/logger');

const TEMPLATE_DB_NAME = 'neronet_test_template';
const ADVISORY_LOCK_ID = 7429148;

// Preserve the initial base database connection URL so that multiple setupTestDatabase calls
// within the same process (e.g. freshDb in vip_allocation.test.js) do not attempt to use
// an ephemeral database name that has already been dropped.
let INITIAL_BASE_DB_URL = null;

function getBaseDatabaseUrl() {
  if (!INITIAL_BASE_DB_URL) {
    INITIAL_BASE_DB_URL =
      process.env.TEST_MAINTENANCE_DATABASE_URL ||
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      'postgresql://neronet:neronet_dev_password@127.0.0.1:5432/neronet_test';
  }
  return INITIAL_BASE_DB_URL;
}

/**
 * Ensure the master template database exists with all migrations and seed data.
 * Protected by a PostgreSQL session-level advisory lock to prevent races when
 * multiple test workers initialize concurrently.
 */
async function ensureTemplateDatabase(baseDbUrl) {
  const parsed = new URL(baseDbUrl);
  // Connect to the base maintenance database
  const maintenancePool = new Pool({
    connectionString: baseDbUrl,
    max: 2,
    connectionTimeoutMillis: 10000
  });

  const client = await maintenancePool.connect();
  try {
    // Acquire exclusive advisory lock
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

    // Check if template database already exists
    const checkRes = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEMPLATE_DB_NAME]);

    if (checkRes.rowCount === 0) {
      logger.info(`Creating master template database: ${TEMPLATE_DB_NAME}...`);
      await client.query(`CREATE DATABASE "${TEMPLATE_DB_NAME}"`);

      // Connect to template database to run migrations and seeds
      const tplUrl = new URL(baseDbUrl);
      tplUrl.pathname = `/${TEMPLATE_DB_NAME}`;

      const tplPool = new Pool({
        connectionString: tplUrl.toString(),
        max: 5,
        connectionTimeoutMillis: 10000
      });

      try {
        await runPostgresMigrations(tplPool);
        await seedPostgresDatabase(tplPool);
      } finally {
        await tplPool.end();
      }

      // Terminate any lingering connections to template DB before using as template
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEMPLATE_DB_NAME]
      );
      logger.info(`Master template database ${TEMPLATE_DB_NAME} ready.`);
    }

    // Release advisory lock
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
  } finally {
    client.release();
    await maintenancePool.end();
  }
}

/**
 * Creates an isolated database for the current test file cloned from the template.
 * Updates environment variables and reconfigures the shared pg pool.
 *
 * @returns {Promise<{ pool: Pool, dbName: string, cleanup: Function }>}
 */
async function setupTestDatabase() {
  const baseDbUrl = getBaseDatabaseUrl();
  await ensureTemplateDatabase(baseDbUrl);

  const parsedBase = new URL(baseDbUrl);
  const dbName = `neronet_t_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const maintenancePool = new Pool({
    connectionString: baseDbUrl,
    max: 2,
    connectionTimeoutMillis: 10000
  });

  try {
    // Terminate any background connections that might have attached to template
    await maintenancePool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEMPLATE_DB_NAME]
    );

    // Fast clone from template database (~10-20ms)
    await maintenancePool.query(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB_NAME}"`);
  } finally {
    await maintenancePool.end();
  }

  // Configure runtime environment for this test file
  const testDbUrl = new URL(baseDbUrl);
  testDbUrl.pathname = `/${dbName}`;

  process.env.DATABASE_URL = testDbUrl.toString();
  process.env.PGDATABASE = dbName;
  process.env.DB_TYPE = 'postgres';

  setUsePostgres(true);
  closeDatabase(); // Discard any prior pool instance

  const pool = getPgPool();

  const cleanup = async () => {
    try {
      closeDatabase();
    } catch (e) {
      // ignore
    }

    const dropPool = new Pool({
      connectionString: baseDbUrl,
      max: 1,
      connectionTimeoutMillis: 10000
    });

    try {
      // DROP DATABASE ... WITH (FORCE) terminates open backends and drops DB
      await dropPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } catch (err) {
      logger.warn(`Failed to drop test database ${dbName}: ${err.message}`);
    } finally {
      await dropPool.end();
      process.env.DATABASE_URL = baseDbUrl;
    }
  };

  return {
    pool,
    dbName,
    cleanup
  };
}

module.exports = {
  setupTestDatabase,
  ensureTemplateDatabase,
  TEMPLATE_DB_NAME
};
