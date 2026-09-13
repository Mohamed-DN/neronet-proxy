const path = require('path');
const config = require('./env');

// PGSSL enables TLS to PostgreSQL. PGSSL_INSECURE additionally disables certificate
// verification.
//
// These are two separate switches on purpose. Folding them together -- which is what
// `ssl: { rejectUnauthorized: false }` did -- meant that turning SSL "on" produced a
// connection that encrypts but authenticates nothing, so an attacker who can answer
// on the database's address reads every credential and row in transit. That is a
// weaker position than plaintext on a trusted socket, while looking stronger.
function buildSslConfig() {
  if (process.env.PGSSL !== 'true') {
    return false;
  }

  if (process.env.PGSSL_INSECURE === 'true') {
    if (config.IS_PRODUCTION) {
      throw new Error('Refusing to start: PGSSL_INSECURE=true disables certificate verification and is not permitted in production.');
    }
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
}

/**
 * Resolve the PostgreSQL password.
 *
 * Only enforced when PostgreSQL is actually the selected backend, so a SQLite
 * deployment is not asked for a credential it will never use.
 */
function resolvePostgresPassword() {
  const value = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD;
  if (value && value.length > 0) {
    // Being set is not enough. The JWT and admin secrets are checked against the
    // hashes of every default this repository has shipped; this one was not, so a
    // deployment could pass the published database password and boot in production
    // with no error at all.
    if (config.IS_PRODUCTION && config.isPublishedDefault(value)) {
      throw new Error(
        'Refusing to start: PGPASSWORD (or POSTGRES_PASSWORD) is set to a value published in this repository. ' +
        'Rotate it with ALTER USER — changing the environment variable alone does not rotate a password already ' +
        'written into the database volume.'
      );
    }
    return value;
  }

  if (config.IS_PRODUCTION) {
    throw new Error('Refusing to start: PGPASSWORD (or POSTGRES_PASSWORD) must be set when running PostgreSQL in production.');
  }

  return 'neronet_dev_password';
}

const dbConfig = {
  // PostgreSQL 16 Configuration
  postgres: {
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || null,
    host: process.env.PGHOST || process.env.POSTGRES_HOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.PGUSER || process.env.POSTGRES_USER || 'neronet',
    get password() {
      return resolvePostgresPassword();
    },
    database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'neronet_db',
    max: parseInt(process.env.PGPOOL_MAX || '20', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    get ssl() {
      return buildSslConfig();
    }
  },

  // Valkey 7 / Redis Configuration
  valkey: {
    url: process.env.VALKEY_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    host: process.env.VALKEY_HOST || process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.VALKEY_PORT || process.env.REDIS_PORT || '6379', 10),
    password: process.env.VALKEY_PASSWORD || process.env.REDIS_PASSWORD || null,
    db: parseInt(process.env.VALKEY_DB || '0', 10),
    connectTimeout: 3000,
    // NOT lazyConnect. With it, ioredis waits for the first command before dialling,
    // so the 'connect' event never fires at startup, isConnected stays false, and
    // every caller silently takes the in-memory fallback instead. The fallback works,
    // so nothing ever errors -- the token blacklist, the topology bus and rate
    // limiting all quietly become per-process, which is exactly the guarantee they
    // exist to provide across processes.
    lazyConnect: false,
    maxRetriesPerRequest: 1
  },

  // Fallback SQLite Path
  sqlite: {
    path: config.DB_PATH || path.resolve(__dirname, '../../data/neronet.db')
  }
};

module.exports = dbConfig;
