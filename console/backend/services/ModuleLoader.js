const fs = require('fs');
const path = require('path');
const { getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');
const logger = require('../utils/logger');

class ModuleLoader {
  constructor() {
    this.modules = new Map(); // id -> { manifest, instance, dir }
    this.core = null;
    this.app = null;
  }

  /**
   * Initializes and loads all enabled feature modules.
   */
  loadModules(app, options = {}) {
    this.app = app;
    const modulesDir = path.resolve(__dirname, '../modules');

    if (!fs.existsSync(modulesDir)) {
      logger.info('[MODULES] No modules directory found');
      return;
    }

    // Configured active modules from environment
    // Default: 'nuke,deniability,onion'
    // If explicitly set to empty string or 'none', no modules are loaded
    const rawEnv =
      process.env.SOVEREIGN_MODULES !== undefined ? process.env.SOVEREIGN_MODULES : 'nuke,deniability,onion';
    const enabledModuleIds = new Set(
      rawEnv
        .split(',')
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean)
    );

    const entries = fs.readdirSync(modulesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const moduleName = entry.name;
      const modulePath = path.join(modulesDir, moduleName);
      const manifestPath = path.join(modulePath, 'module.json');

      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestRaw);

        if (!manifest.id || !manifest.version) {
          logger.error(`[MODULES] Invalid manifest in ${manifestPath}: missing id or version`);
          continue;
        }

        // Check if enabled in global build/environment
        if (!enabledModuleIds.has(manifest.id.toLowerCase())) {
          logger.info(`[MODULES] Module ${manifest.id} is excluded by SOVEREIGN_MODULES`);
          continue;
        }

        const entryFile = path.join(modulePath, 'index.js');
        if (!fs.existsSync(entryFile)) {
          logger.error(`[MODULES] Missing index.js in ${modulePath}`);
          continue;
        }

        const moduleInstance = require(entryFile);
        if (typeof moduleInstance.register !== 'function') {
          logger.error(`[MODULES] Module ${manifest.id} does not export register(core)`);
          continue;
        }

        // Build core interface for this module
        const core = this.createCoreInterface(manifest.id);
        moduleInstance.register(core);

        this.modules.set(manifest.id, {
          manifest,
          instance: moduleInstance,
          dir: modulePath
        });

        logger.info(`[MODULES] Successfully registered feature module: ${manifest.id} (v${manifest.version})`);
      } catch (err) {
        logger.error(`[MODULES] Failed to load module ${moduleName}: ${err.message}`);
      }
    }
  }

  /**
   * Constructs the narrow core interface exposed to feature modules.
   */
  createCoreInterface(moduleId) {
    const self = this;

    return {
      moduleId,
      routes: {
        /**
         * Mounts an express router under a given path with automatic
         * per-organization and global module guard.
         */
        mount: (mountPath, router) => {
          if (!self.app) throw new Error('App not initialized');
          self.app.use(mountPath, self.createModuleGuard(moduleId), router);
        }
      },
      scheduler: {
        every: (intervalMs, fn) => {
          const intervalId = setInterval(fn, intervalMs);
          if (intervalId.unref) intervalId.unref();
          return intervalId;
        }
      },
      audit: {
        write: (event) => {
          logAuditEvent(event);
        }
      },
      db: {
        getPool: () => getPgPool()
      },
      logger: {
        info: (msg) => logger.info(`[MODULE:${moduleId}] ${msg}`),
        warn: (msg) => logger.warn(`[MODULE:${moduleId}] ${msg}`),
        error: (msg) => logger.error(`[MODULE:${moduleId}] ${msg}`)
      }
    };
  }

  /**
   * Checks if a module is loaded globally.
   */
  isModuleLoaded(moduleId) {
    return this.modules.has(moduleId);
  }

  /**
   * Returns list of loaded module IDs.
   */
  getLoadedModuleIds() {
    return Array.from(this.modules.keys());
  }

  /**
   * Checks whether a module is enabled for a given organization.
   * If org is regulated -> high-risk modules (nuke, deniability, onion) are false.
   * If organization_modules has enabled = false -> false.
   * Cross-tenant and unknown org checks default to true if module is loaded globally.
   */
  async isModuleEnabledForOrg(orgId, moduleId) {
    if (!this.isModuleLoaded(moduleId)) {
      return false;
    }

    if (!orgId) {
      return true;
    }

    try {
      const pool = getPgPool();
      // Check org profile
      const orgRes = await pool.query('SELECT profile FROM organizations WHERE id = $1', [orgId]);
      if (orgRes.rows.length > 0 && orgRes.rows[0].profile === 'regulated') {
        // Regulated profile forbids high risk modules
        if (['nuke', 'deniability', 'onion'].includes(moduleId)) {
          return false;
        }
      }

      // Check organization_modules table
      const modRes = await pool.query(
        'SELECT enabled FROM organization_modules WHERE organization_id = $1 AND module_id = $2',
        [orgId, moduleId]
      );
      if (modRes.rows.length > 0) {
        return Boolean(modRes.rows[0].enabled);
      }

      return true;
    } catch (err) {
      // In case table does not exist or DB error, fall back to global loaded state
      return true;
    }
  }

  /**
   * Express middleware factory checking module availability.
   * Returns 404 (never 403) when module is disabled or absent.
   */
  createModuleGuard(moduleId) {
    const self = this;
    const jwt = require('jsonwebtoken');
    const config = require('../config/env');

    return async function moduleGuard(req, res, next) {
      if (!self.isModuleLoaded(moduleId)) {
        return res.status(404).json({ error: 'Not found' });
      }

      let orgId = req.user?.organization_id || req.node?.organization_id;

      if (!orgId) {
        const authHeader = req.headers?.authorization || '';
        let token = '';
        if (authHeader.startsWith('Bearer ')) {
          token = authHeader.substring(7).trim();
        } else if (req.cookies && req.cookies.token) {
          token = req.cookies.token;
        }

        if (token && !token.startsWith('nnt1_')) {
          try {
            const decoded = jwt.verify(token, config.JWT_SECRET);
            orgId = decoded.organization_id;
            req.user = req.user || decoded;
          } catch (e) {
            // Downstream authenticateToken middleware handles invalid tokens
          }
        }
      }

      if (orgId) {
        const enabled = await self.isModuleEnabledForOrg(orgId, moduleId);
        if (!enabled) {
          return res.status(404).json({ error: 'Not found' });
        }
      }

      return next();
    };
  }

  /**
   * Update a module's enabled status for an organization.
   */
  async setOrgModuleStatus(orgId, moduleId, enabled, actor) {
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO organization_modules (organization_id, module_id, enabled, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (organization_id, module_id)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [orgId, moduleId, Boolean(enabled)]
    );

    logAuditEvent({
      eventType: 'ORG_MODULE_TOGGLE',
      severity: 'warn',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: orgId,
      targetType: 'organization',
      message: `Module ${moduleId} set to ${enabled ? 'enabled' : 'disabled'} for org ${orgId}`
    });

    return true;
  }
}

const instance = new ModuleLoader();
module.exports = instance;
