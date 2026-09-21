const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
const config = require('../config/env');

async function seedPostgresDatabase(pool) {
  logger.info('Checking PostgreSQL database seed data...');
  const salt = bcrypt.genSaltSync(10);
  const adminPassHash = bcrypt.hashSync(config.ADMIN_PASSWORD || 'admin_password', salt);
  const demoPassHash = bcrypt.hashSync('Password123!', salt);

  // 1. Super-Admin
  await pool.query(
    `
    INSERT INTO users (id, username, email, password_hash, role, status)
    VALUES ($1, $2, $3, $4, 'super-admin', 'active')
    ON CONFLICT (id) DO NOTHING
  `,
    ['usr-admin', config.ADMIN_USERNAME || 'admin', config.ADMIN_EMAIL || 'admin@darknero.com', adminPassHash]
  );

  // 2. Demo Users
  await pool.query(
    `
    INSERT INTO users (id, username, email, password_hash, role, status)
    VALUES ($1, $2, $3, $4, 'user', 'active')
    ON CONFLICT (id) DO NOTHING
  `,
    ['usr-alice', 'alice_homelab', 'alice@homelab.local', demoPassHash]
  );

  await pool.query(
    `
    INSERT INTO users (id, username, email, password_hash, role, status)
    VALUES ($1, $2, $3, $4, 'user', 'active')
    ON CONFLICT (id) DO NOTHING
  `,
    ['usr-bob', 'bob_cloud', 'bob@cloud.internal', demoPassHash]
  );

  // 3. Seed Nodes
  await pool.query(
    `
    INSERT INTO nodes (
      id, user_id, name, public_key, overlay_ipv4, overlay_ipv6,
      role, ip_class, country_code, city, asn, endpoints,
      onion_routing_enabled, is_healthy, is_quarantined, latency_ms
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12::jsonb,
      $13, $14, $15, $16
    ) ON CONFLICT (id) DO NOTHING
  `,
    [
      'svrn-node-seed1',
      'usr-admin',
      'US-East-Relay',
      'v1eXAmPLePuBL1cKeY1111111111111111111111111=',
      '100.64.0.1',
      'fd7a:115c:a1e0::1',
      'EXIT_BRIDGE',
      'DATACENTER',
      'US',
      'Ashburn',
      13335,
      JSON.stringify(['198.51.100.1:51820', '198.51.100.1:443']),
      false,
      true,
      false,
      12.4
    ]
  );

  await pool.query(
    `
    INSERT INTO nodes (
      id, user_id, name, public_key, overlay_ipv4, overlay_ipv6,
      role, ip_class, country_code, city, asn, endpoints,
      onion_routing_enabled, is_healthy, is_quarantined, latency_ms
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12::jsonb,
      $13, $14, $15, $16
    ) ON CONFLICT (id) DO NOTHING
  `,
    [
      'svrn-node-seed2',
      'usr-alice',
      'Alice-MacBook-Pro',
      'a2eXAmPLePuBL1cKeY2222222222222222222222222=',
      '100.64.0.2',
      'fd7a:115c:a1e0::2',
      'CLIENT_ORIGIN',
      'RESIDENTIAL',
      'DE',
      'Frankfurt',
      24940,
      JSON.stringify(['203.0.113.42:51820']),
      false,
      true,
      false,
      24.1
    ]
  );

  // 5. Initial Cloud PC and Custom Domain if empty and table exists
  const cpcCheck = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'cloud_pcs'");
  if (cpcCheck.rowCount > 0) {
    const cpcCount = await pool.query('SELECT count(*) as count FROM cloud_pcs');
    if (parseInt(cpcCount.rows[0].count, 10) === 0) {
      await pool.query(`
        INSERT INTO cloud_pcs (id, name, user_id, device_id, specs, status, signaling_url, custom_domain)
        VALUES ('cpc-0001', 'Admin GPU Workstation', 'usr-admin', 'svrn-node-seed1', '{"vcpus": 8, "ram_gb": 32, "gpu": "RTX 4090"}'::jsonb, 'active', 'wss://signal.internal.darknero.com/ws/selkies', 'desktop.admin.darknero.com')
        ON CONFLICT (id) DO NOTHING
      `);
    }
  }

  const domCheck = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'custom_domains'");
  if (domCheck.rowCount > 0) {
    const domCount = await pool.query('SELECT count(*) as count FROM custom_domains');
    if (parseInt(domCount.rows[0].count, 10) === 0) {
      await pool.query(
        `
        INSERT INTO custom_domains (id, domain_name, cloud_pc_id, user_id, sso_gateway_enabled, otp_secret)
        VALUES ('cdom-0001', 'desktop.admin.darknero.com', 'cpc-0001', 'usr-admin', true, $1)
        ON CONFLICT (id) DO NOTHING
      `,
        [require('crypto').randomBytes(20).toString('hex')]
      );
    }
  }

  // 6. Initial Audit Log if empty
  const auditRes = await pool.query('SELECT count(*) as count FROM audit_events');
  if (parseInt(auditRes.rows[0].count, 10) === 0) {
    await pool.query(`
      INSERT INTO audit_events (
        event_type, severity, actor_user_id, actor_username,
        target_id, target_type, message, ip_address
      ) VALUES (
        'SYSTEM_INIT', 'info', 'usr-admin', 'system',
        'database', 'system', 'NeroNet Enterprise Management Console database initialized.',
        '127.0.0.1'
      )
    `);
  }

  // 7. Initial Metrics if empty
  const metricRes = await pool.query('SELECT count(*) as count FROM system_metrics');
  if (parseInt(metricRes.rows[0].count, 10) === 0) {
    await pool.query(`
      INSERT INTO system_metrics (
        active_nodes, active_users, total_bandwidth_rx, total_bandwidth_tx,
        cpu_usage_pct, memory_usage_mb, active_circuits, network_health_score
      ) VALUES (
        2, 3, 104857600, 52428800,
        12.5, 512.0, 5, 98
      )
    `);
  }

  logger.info('PostgreSQL database seeding completed successfully.');
}

function seedDatabase(dbOrPool) {
  if (dbOrPool && typeof dbOrPool.query === 'function') {
    return seedPostgresDatabase(dbOrPool);
  }
  const { getPgPool } = require('./index');
  return seedPostgresDatabase(dbOrPool || getPgPool());
}

module.exports = { seedDatabase, seedPostgresDatabase };

/**
 * Create the super-admin account on a PostgreSQL deployment.
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
