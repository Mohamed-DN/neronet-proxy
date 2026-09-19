/**
 * PolicyEngine.js
 * Geo-Fencing Policy Engine (R7)
 *
 * Features:
 * - Evaluates ISO 3166-1 alpha-2 country-level routing rules (ALLOW, BLOCK, QUARANTINE).
 * - Implements default-allow for censorship-heavy jurisdictions (RU, EG, CN, IN).
 * - Full CRUD persistence for geo-fencing policies with PostGIS / SQLite support.
 */

const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const { COUNTRY_NAMES } = require('../utils/countries');
const logger = require('../utils/logger');

const CENSORSHIP_BYPASS_COUNTRIES = new Set(['RU', 'EG', 'CN', 'IN']);
const VALID_ACTIONS = new Set(['ALLOW', 'BLOCK', 'QUARANTINE']);

function ensureGeofencingSchema(db) {
  if (!isPostgres() && db && typeof db.exec === 'function') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS geofencing_policies (
        id TEXT PRIMARY KEY,
        country_code TEXT NOT NULL UNIQUE,
        country_name TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'ALLOW' CHECK (action IN ('ALLOW', 'BLOCK', 'QUARANTINE')),
        description TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_geofencing_policies_country ON geofencing_policies(country_code);
    `);
  }
}

/**
 * Returns all configured geo-fencing policies.
 */
async function listPolicies() {
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM geofencing_policies ORDER BY country_code ASC');
    return res.rows.map(withResolvedCountryName);
  } else {
    const db = getDatabase();
    ensureGeofencingSchema(db);
    return db.prepare('SELECT * FROM geofencing_policies ORDER BY country_code ASC').all().map(withResolvedCountryName);
  }
}

/**
 * Retrieves a single policy by ID or country code.
 */
async function getPolicyById(policyId) {
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM geofencing_policies WHERE id = $1', [policyId]);
    return res.rows[0] || null;
  } else {
    const db = getDatabase();
    ensureGeofencingSchema(db);
    return db.prepare('SELECT * FROM geofencing_policies WHERE id = ?').get(policyId) || null;
  }
}

async function getPolicyByCountryCode(countryCode) {
  const cc = (countryCode || '').toUpperCase();
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM geofencing_policies WHERE country_code = $1', [cc]);
    return res.rows[0] || null;
  } else {
    const db = getDatabase();
    ensureGeofencingSchema(db);
    return db.prepare('SELECT * FROM geofencing_policies WHERE country_code = ?').get(cc) || null;
  }
}

/**
 * Creates or updates a geo-fencing policy rule.
 */
async function createOrUpdatePolicy({ country_code, country_name, action = 'ALLOW', description = '' }) {
  if (!country_code || typeof country_code !== 'string') {
    const err = new Error('Missing country_code in policy payload');
    err.status = 400;
    throw err;
  }

  const cc = country_code.trim().toUpperCase();
  if (cc.length !== 2 || !/^[A-Z]{2}$/.test(cc)) {
    const err = new Error('country_code must be ISO 2-letter format');
    err.status = 400;
    throw err;
  }

  const act = (action || '').toUpperCase();
  if (!VALID_ACTIONS.has(act)) {
    const err = new Error('action must be ALLOW, BLOCK, or QUARANTINE');
    err.status = 400;
    throw err;
  }

  // Was `Country (IR)` — a placeholder built from the code and then persisted, so
  // the console displayed the code twice. The ISO table already exists for the
  // country column elsewhere. A caller-supplied name still wins, but a stored
  // placeholder does not: rows written before this are repaired on read.
  const name = country_name && !isPlaceholderName(country_name, cc) ? country_name : COUNTRY_NAMES[cc] || cc;
  const existing = await getPolicyByCountryCode(cc);
  const nowIso = new Date().toISOString();

  if (existing) {
    if (isPostgres()) {
      const pool = getPgPool();
      const res = await pool.query(
        `UPDATE geofencing_policies SET
          country_name = $1,
          action = $2,
          description = $3,
          is_active = TRUE,
          updated_at = $4
         WHERE id = $5
         RETURNING *`,
        [name, act, description, nowIso, existing.id]
      );
      return res.rows[0];
    } else {
      const db = getDatabase();
      ensureGeofencingSchema(db);
      db.prepare(
        `UPDATE geofencing_policies SET
          country_name = ?,
          action = ?,
          description = ?,
          is_active = 1,
          updated_at = ?
         WHERE id = ?`
      ).run(name, act, description, nowIso, existing.id);
      return { ...existing, country_name: name, action: act, description, updated_at: nowIso };
    }
  }

  const policyId = `pol-${Math.random().toString(36).substring(2, 9)}`;
  if (isPostgres()) {
    const pool = getPgPool();
    const res = await pool.query(
      `INSERT INTO geofencing_policies
       (id, country_code, country_name, action, description, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6, $6)
       RETURNING *`,
      [policyId, cc, name, act, description, nowIso]
    );
    return res.rows[0];
  } else {
    const db = getDatabase();
    ensureGeofencingSchema(db);
    db.prepare(
      `INSERT INTO geofencing_policies
       (id, country_code, country_name, action, description, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(policyId, cc, name, act, description, nowIso, nowIso);
    return {
      id: policyId,
      country_code: cc,
      country_name: name,
      action: act,
      description,
      is_active: 1,
      created_at: nowIso,
      updated_at: nowIso
    };
  }
}

/**
 * Deletes a policy by ID.
 */
async function deletePolicy(policyId) {
  const policy = await getPolicyById(policyId);
  if (!policy) {
    const err = new Error('Geo-fencing policy not found');
    err.status = 404;
    throw err;
  }

  if (isPostgres()) {
    const pool = getPgPool();
    await pool.query('DELETE FROM geofencing_policies WHERE id = $1', [policyId]);
  } else {
    const db = getDatabase();
    ensureGeofencingSchema(db);
    db.prepare('DELETE FROM geofencing_policies WHERE id = ?').run(policyId);
  }

  return { success: true, message: 'Policy deleted', id: policyId };
}

/**
 * Evaluates a country code against configured policies and default rules.
 */
async function evaluateCountry(countryCode) {
  if (!countryCode || typeof countryCode !== 'string') {
    const err = new Error('Invalid country code for evaluation');
    err.status = 400;
    throw err;
  }

  const cc = countryCode.trim().toUpperCase();
  if (cc.length !== 2 || !/^[A-Z]{2}$/.test(cc)) {
    const err = new Error('Invalid country code for evaluation');
    err.status = 400;
    throw err;
  }

  const policy = await getPolicyByCountryCode(cc);
  if (policy && (policy.is_active === true || policy.is_active === 1)) {
    const action = policy.action;
    return {
      country_code: cc,
      action,
      allowed: action === 'ALLOW',
      description: policy.description || '',
      policy_id: policy.id
    };
  }

  // Default-allow for censorship bypass jurisdictions (RU, EG, CN, IN) and unconfigured countries
  return {
    country_code: cc,
    action: 'ALLOW',
    allowed: true,
    is_censorship_bypass: CENSORSHIP_BYPASS_COUNTRIES.has(cc),
    is_default: true
  };
}

/** True when a stored name is the old `Country (XX)` placeholder for this code. */
function isPlaceholderName(name, cc) {
  return String(name).trim() === `Country (${cc})`;
}

/**
 * Replaces a persisted placeholder with the real country name.
 *
 * Applied on read so existing rows do not need a migration and no row has to be
 * rewritten to be displayed correctly.
 */
function withResolvedCountryName(row) {
  if (!row) return row;
  const cc = row.country_code;
  if (!row.country_name || isPlaceholderName(row.country_name, cc)) {
    return { ...row, country_name: COUNTRY_NAMES[cc] || cc };
  }
  return row;
}

module.exports = {
  withResolvedCountryName,
  listPolicies,
  getPolicyById,
  getPolicyByCountryCode,
  createOrUpdatePolicy,
  deletePolicy,
  evaluateCountry,
  ensureGeofencingSchema,
  CENSORSHIP_BYPASS_COUNTRIES
};
