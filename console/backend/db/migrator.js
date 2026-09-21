const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

async function runPostgresMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const res = await client.query('SELECT name FROM _migrations');
    const appliedSet = new Set(res.rows.map((r) => r.name));

    if (fs.existsSync(MIGRATIONS_DIR)) {
      const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        if (!appliedSet.has(file)) {
          logger.info(`Applying PostgreSQL migration: ${file}...`);
          const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
            await client.query('COMMIT');
            logger.info(`PostgreSQL migration ${file} applied successfully.`);
          } catch (mErr) {
            await client.query('ROLLBACK');
            throw mErr;
          }
        }
      }
    }
  } finally {
    client.release();
  }
}

async function runMigrations(dbOrPool) {
  if (dbOrPool && typeof dbOrPool.connect === 'function') {
    return await runPostgresMigrations(dbOrPool);
  }
  const { getPgPool } = require('./index');
  return await runPostgresMigrations(getPgPool());
}

function ensureSchemaIntegrity() {
  // No-op kept for legacy compatibility
}

function runSQLiteMigrations() {
  // No-op kept for legacy compatibility
}

module.exports = {
  runMigrations,
  runPostgresMigrations,
  runSQLiteMigrations,
  ensureSchemaIntegrity
};
