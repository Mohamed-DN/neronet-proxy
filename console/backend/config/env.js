const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const logger = require('../utils/logger');

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config(); // fallback to local directory .env

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

// Secrets that were missing when this module loaded, collected so the process can
// report all of them at once rather than failing on the first one.
const missingSecrets = [];

// Secrets that were set, but set to a value published in this repository.
const compromisedSecrets = [];

// SHA-256 of every default secret this project has shipped in a committed file:
// console/.env.example, docker-compose.yml, and the former in-code fallbacks.
//
// Requiring a variable to be *set* is not enough on its own. The example env file
// arrives with these values filled in and docker-compose.yml passes one of them
// inline alongside NODE_ENV=production, so the most likely way to deploy this
// project was to satisfy a presence check with a secret that is public. Hashes are
// stored rather than the literals so this file does not become one more copy.
const PUBLISHED_SECRET_HASHES = new Set([
  '6d4525c2a21f9be1cca9e41f3aa402e0765ee5fcc3e7fea34a169b1730ae386e',
  'e4016c6d60e80cc89e97952bf618eb6da5731cfb4cf257e65442914ff756db48',
  'afa66a8109f7e3402afe12b48e6dcac17cf5bc0a3a5b24ebd5270eeaeaa00e9e',
  '040c3811488fa58b9cb87fe049a74c34a662232a0816f09b35f5f4e985ced86f'
]);

/** Report whether a value is one of the defaults published in this repository. */
function isPublishedDefault(value) {
  const digest = crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  return PUBLISHED_SECRET_HASHES.has(digest);
}

/**
 * Resolve a security-critical setting.
 *
 * In production a missing value is fatal. The alternative -- quietly substituting a
 * default that is committed to a public repository -- means a deployment that forgets
 * one variable still boots, signs tokens with a secret anyone can read, and shows no
 * sign that anything is wrong. Refusing to start is the only outcome that surfaces
 * the mistake while it is still cheap to fix.
 *
 * Outside production the development default is used and a warning is logged.
 */
function requireSecret(name, devFallback) {
  const value = process.env[name];
  if (value && value.length > 0) {
    if (IS_PRODUCTION && isPublishedDefault(value)) {
      compromisedSecrets.push(name);
      return null;
    }
    return value;
  }

  if (IS_PRODUCTION) {
    missingSecrets.push(name);
    return null;
  }

  logger.warn(`${name} is not set - falling back to a well-known development value. Never deploy this way.`);
  return devFallback;
}

const config = {
  NODE_ENV,
  IS_PRODUCTION,
  HOST: process.env.SOVEREIGN_API_HOST || process.env.HOST || '127.0.0.1',
  PORT: parseInt(process.env.SOVEREIGN_API_PORT || process.env.PORT || '8082', 10),

  // Directory for state this service writes to disk: the SQLite file and the mesh's
  // peering identity.
  //
  // Explicit rather than derived from __dirname. The repository nests this service
  // under console/backend while the image flattens it to /app, so the same relative
  // path resolves inside the repo and outside the image -- which put the federation
  // identity key at /data, beyond any volume, where a container recreation would
  // destroy it.
  DATA_DIR: process.env.SOVEREIGN_DATA_DIR || path.resolve(__dirname, '../../data'),

  // Database Configuration
  DB_PATH:
    process.env.SOVEREIGN_DB_PATH ||
    path.join(process.env.SOVEREIGN_DATA_DIR || path.resolve(__dirname, '../../data'), 'neronet.db'),

  // JWT & Authentication Configuration
  JWT_SECRET: requireSecret('SOVEREIGN_JWT_SECRET', 'dev-only-jwt-secret-do-not-deploy'),
  JWT_EXPIRES_IN: process.env.SOVEREIGN_JWT_EXPIRES_IN || '15m',
  REFRESH_SECRET: requireSecret('SOVEREIGN_REFRESH_SECRET', 'dev-only-refresh-secret-do-not-deploy'),
  REFRESH_EXPIRES_IN: process.env.SOVEREIGN_REFRESH_EXPIRES_IN || '7d',

  // Default Super-Admin Credentials
  ADMIN_USERNAME: process.env.SOVEREIGN_ADMIN_USER || 'admin',
  ADMIN_PASSWORD: requireSecret('SOVEREIGN_ADMIN_PASS', 'admin_password'),
  ADMIN_EMAIL: process.env.SOVEREIGN_ADMIN_EMAIL || 'admin@darknero.com',

  // CORS Configuration
  CORS_ORIGINS: (process.env.CORS_ORIGIN || 'http://127.0.0.1:8081,http://localhost:8081,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3000,http://localhost:3000')
    .split(',')
    .map(origin => origin.trim()),

  // Mesh Relay & Master Server Public Key Configuration
  SERVER_ENDPOINT: process.env.SOVEREIGN_SERVER_ENDPOINT || 'relay-us.neronet.darknero.com:51820',
  SERVER_PUBKEY: process.env.SOVEREIGN_SERVER_PUBKEY || 'NeroNetServerMasterPublicKeyBase64Placeholder=',
  CONTROL_PLANE_URL: process.env.SOVEREIGN_CONTROL_PLANE_URL || 'https://neronet.darknero.com/v4/control',

  // Overlay Network VIP Defaults
  OVERLAY_IPV4_BASE: '100.64.0.',
  OVERLAY_IPV6_BASE: 'fd7a:115c:a1e0::'
};

/**
 * Abort startup if any security-critical setting is missing in production.
 *
 * Exported rather than run at import time so that tooling which only needs to read
 * the configuration shape is not forced to satisfy every production requirement.
 * server.js calls this before binding a port.
 */
function assertProductionSecrets() {
  const problems = [];

  if (missingSecrets.length > 0) {
    problems.push(`unset: ${missingSecrets.join(', ')}`);
  }
  if (compromisedSecrets.length > 0) {
    problems.push(`set to a value published in this repository: ${compromisedSecrets.join(', ')}`);
  }

  if (problems.length === 0) {
    return;
  }

  throw new Error(
    `Refusing to start: NODE_ENV=production but ${problems.join('; ')}. ` +
    'Generate a fresh value for each with `openssl rand -base64 48`.'
  );
}

config.assertProductionSecrets = assertProductionSecrets;
config.missingSecrets = missingSecrets;
config.compromisedSecrets = compromisedSecrets;
config.isPublishedDefault = isPublishedDefault;

module.exports = config;
