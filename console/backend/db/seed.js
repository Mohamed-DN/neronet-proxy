const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
const config = require('../config/env');

function seedDatabase(db) {
  logger.info('Checking database seed data...');

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (
      id, username, email, password_hash, role, status
    ) VALUES (
      @id, @username, @email, @password_hash, @role, @status
    )
  `);

  const insertNode = db.prepare(`
    INSERT OR IGNORE INTO nodes (
      id, user_id, name, public_key, overlay_ipv4, overlay_ipv6,
      role, ip_class, country_code, city, asn, endpoints,
      onion_routing_enabled, is_healthy, is_quarantined, latency_ms
    ) VALUES (
      @id, @user_id, @name, @public_key, @overlay_ipv4, @overlay_ipv6,
      @role, @ip_class, @country_code, @city, @asn, @endpoints,
      COALESCE(@onion_routing_enabled, 0), @is_healthy, @is_quarantined, @latency_ms
    )
  `);

  const insertApp = db.prepare(`
    INSERT OR IGNORE INTO app_bundles (
      id, user_id, name, type, status,
      endpoint_url, internal_port, cpu_cores, memory_mb, storage_gb,
      scale_to_zero
    ) VALUES (
      @id, @user_id, @name, @type, @status,
      @endpoint_url, @internal_port, @cpu_cores, @memory_mb, @storage_gb,
      @scale_to_zero
    )
  `);

  const insertAudit = db.prepare(`
    INSERT INTO audit_events (
      event_type, severity, actor_user_id, actor_username,
      target_id, target_type, message, ip_address
    ) VALUES (
      @event_type, @severity, @actor_user_id, @actor_username,
      @target_id, @target_type, @message, @ip_address
    )
  `);

  const insertMetric = db.prepare(`
    INSERT INTO system_metrics (
      active_nodes, active_users, total_bandwidth_rx, total_bandwidth_tx,
      cpu_usage_pct, memory_usage_mb, active_circuits, network_health_score
    ) VALUES (
      @active_nodes, @active_users, @total_bandwidth_rx, @total_bandwidth_tx,
      @cpu_usage_pct, @memory_usage_mb, @active_circuits, @network_health_score
    )
  `);

  const salt = bcrypt.genSaltSync(10);
  const adminPassHash = bcrypt.hashSync(config.ADMIN_PASSWORD || 'admin_password', salt);
  const demoPassHash = bcrypt.hashSync('Password123!', salt);

  db.transaction(() => {
    // 1. Super-Admin
    insertUser.run({
      id: 'usr-admin',
      username: config.ADMIN_USERNAME || 'admin',
      email: config.ADMIN_EMAIL || 'admin@darknero.com',
      password_hash: adminPassHash,
      role: 'super-admin',
      status: 'active'
    });

    // 2. Demo Users
    insertUser.run({
      id: 'usr-alice',
      username: 'alice_homelab',
      email: 'alice@homelab.local',
      password_hash: demoPassHash,
      role: 'user',
      status: 'active'
    });

    insertUser.run({
      id: 'usr-bob',
      username: 'bob_cloud',
      email: 'bob@cloud.internal',
      password_hash: demoPassHash,
      role: 'user',
      status: 'active'
    });

    // 3. Seed Nodes
    insertNode.run({
      id: 'svrn-node-seed1',
      user_id: 'usr-admin',
      name: 'US-East-Relay',
      public_key: 'v1eXAmPLePuBL1cKeY1111111111111111111111111=',
      overlay_ipv4: '100.64.0.1',
      overlay_ipv6: 'fd7a:115c:a1e0::1',
      role: 'EXIT_BRIDGE',
      ip_class: 'DATACENTER',
      country_code: 'US',
      city: 'Ashburn',
      asn: 13335,
      endpoints: JSON.stringify(['198.51.100.1:51820', '198.51.100.1:443']),
      onion_routing_enabled: 0,
      is_healthy: 1,
      is_quarantined: 0,
      latency_ms: 12.4
    });

    insertNode.run({
      id: 'svrn-node-seed2',
      user_id: 'usr-alice',
      name: 'Alice-MacBook-Pro',
      public_key: 'a2eXAmPLePuBL1cKeY2222222222222222222222222=',
      overlay_ipv4: '100.64.0.2',
      overlay_ipv6: 'fd7a:115c:a1e0::2',
      role: 'CLIENT_ORIGIN',
      ip_class: 'RESIDENTIAL',
      country_code: 'DE',
      city: 'Frankfurt',
      asn: 24940,
      endpoints: JSON.stringify(['203.0.113.42:51820']),
      onion_routing_enabled: 0,
      is_healthy: 1,
      is_quarantined: 0,
      latency_ms: 24.1
    });

    // 4. Seed Apps
    insertApp.run({
      id: 'app-seed-guac',
      user_id: 'usr-admin',
      name: 'Guacamole Bastion',
      type: 'guacamole',
      status: 'running',
      endpoint_url: 'https://guacamole.internal.darknero.com',
      internal_port: 8080,
      cpu_cores: 2.0,
      memory_mb: 4096,
      storage_gb: 50,
      scale_to_zero: 0
    });

    insertApp.run({
      id: 'app-seed-nextcloud',
      user_id: 'usr-alice',
      name: 'Alice Private Cloud',
      type: 'nextcloud',
      status: 'stopped',
      endpoint_url: 'https://nextcloud.internal.darknero.com',
      internal_port: 8080,
      cpu_cores: 4.0,
      memory_mb: 8192,
      storage_gb: 500,
      scale_to_zero: 1
    });

    // 5. Initial Cloud PC and Custom Domain if empty and table exists
    const cloudPcTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_pcs'").all();
    if (cloudPcTable.length > 0) {
      const cpcCount = db.prepare('SELECT count(*) as count FROM cloud_pcs').get().count;
      if (cpcCount === 0) {
        db.prepare(
          `
          INSERT OR IGNORE INTO cloud_pcs (id, name, user_id, device_id, specs, status, signaling_url, custom_domain)
          VALUES ('cpc-0001', 'Admin GPU Workstation', 'usr-admin', 'svrn-node-seed1', '{"vcpus": 8, "ram_gb": 32, "gpu": "RTX 4090"}', 'active', 'wss://signal.internal.darknero.com/ws/selkies', 'desktop.admin.darknero.com')
        `
        ).run();
      }
    }

    const domainTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_domains'").all();
    if (domainTable.length > 0) {
      const domCount = db.prepare('SELECT count(*) as count FROM custom_domains').get().count;
      if (domCount === 0) {
        db.prepare(
          `
          INSERT OR IGNORE INTO custom_domains (id, domain_name, cloud_pc_id, user_id, sso_gateway_enabled, otp_secret)
          VALUES ('cdom-0001', 'desktop.admin.darknero.com', 'cpc-0001', 'usr-admin', 1, ?)
        `
        ).run(require('crypto').randomBytes(20).toString('hex'));
      }
    }

    // 6. Initial Audit Log if empty
    const auditCount = db.prepare('SELECT count(*) as count FROM audit_events').get().count;
    if (auditCount === 0) {
      insertAudit.run({
        event_type: 'SYSTEM_INIT',
        severity: 'info',
        actor_user_id: 'usr-admin',
        actor_username: 'system',
        target_id: 'database',
        target_type: 'system',
        message: 'NeroNet Enterprise Management Console database initialized.',
        ip_address: '127.0.0.1'
      });
    }

    // 7. Initial Metrics if empty
    const metricCount = db.prepare('SELECT count(*) as count FROM system_metrics').get().count;
    if (metricCount === 0) {
      insertMetric.run({
        active_nodes: 2,
        active_users: 3,
        total_bandwidth_rx: 104857600,
        total_bandwidth_tx: 52428800,
        cpu_usage_pct: 12.5,
        memory_usage_mb: 512.0,
        active_circuits: 5,
        network_health_score: 98
      });
    }
  })();

  logger.info('Database seeding completed successfully.');
}

module.exports = { seedDatabase };

/**
 * Create the super-admin account on a PostgreSQL deployment.
 *
 * seedDatabase() is SQLite-only -- it uses better-sqlite3 prepared statements -- and
 * server.js only called it on the SQLite branch. A PostgreSQL deployment therefore
 * migrated cleanly and then had no account anyone could log in with.
 *
 * This deliberately does NOT create the demo users that seedDatabase() adds. Those
 * exist to make a development database useful and share one hardcoded password;
 * PostgreSQL is the production path, and provisioning known-credential accounts
 * there would undo the secret handling the rest of the config enforces.
 *
 * Idempotent: safe to run on every boot.
 */
async function bootstrapPostgresAdmin(pool) {
  const bcryptLib = require('bcryptjs');
  const appConfig = require('../config/env');

  const existing = await pool.query('SELECT id FROM users WHERE role = $1 LIMIT 1', ['super-admin']);
  if (existing.rowCount > 0) {
    logger.info('Super-admin account already present, skipping bootstrap.');
    return false;
  }

  const passwordHash = bcryptLib.hashSync(appConfig.ADMIN_PASSWORD, bcryptLib.genSaltSync(10));

  await pool.query(
    `INSERT INTO users (
       id, username, email, password_hash, role, status
     ) VALUES ($1, $2, $3, $4, 'super-admin', 'active')
     ON CONFLICT (username) DO NOTHING`,
    ['usr-admin', appConfig.ADMIN_USERNAME, appConfig.ADMIN_EMAIL, passwordHash]
  );

  logger.info(`Bootstrapped super-admin account '${appConfig.ADMIN_USERNAME}'.`);
  return true;
}

module.exports.bootstrapPostgresAdmin = bootstrapPostgresAdmin;
