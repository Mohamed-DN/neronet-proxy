const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

const SQLITE_MIGRATIONS = [
  {
    name: '001_initial_schema',
    sql: `
      -- 1. Users Table
      CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('super-admin', 'user')),
          tier TEXT NOT NULL DEFAULT 'free_core' CHECK (tier IN ('cloud_managed', 'managed_cloud', 'hybrid_byos', 'free_core')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
          bandwidth_quota_gb INTEGER NOT NULL DEFAULT 100,
          bandwidth_used_bytes INTEGER NOT NULL DEFAULT 0,
          max_nodes INTEGER NOT NULL DEFAULT 5,
          bypass_apps TEXT DEFAULT '[]',
          scheduled_deletion_at DATETIME,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);

      -- 2. Nodes Table
      CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          public_key TEXT NOT NULL UNIQUE,
          preshared_key TEXT,
          overlay_ipv4 TEXT NOT NULL UNIQUE,
          overlay_ipv6 TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'CLIENT_ORIGIN' CHECK (role IN ('CLIENT_ORIGIN', 'EXIT_BRIDGE', 'HYBRID', 'RELAY')),
          ip_class TEXT NOT NULL DEFAULT 'RESIDENTIAL' CHECK (ip_class IN ('RESIDENTIAL', 'MOBILE_5G', 'DATACENTER', 'UNKNOWN')),
          country_code TEXT NOT NULL DEFAULT 'US',
          city TEXT DEFAULT '',
          asn INTEGER DEFAULT 0,
          endpoints TEXT DEFAULT '[]',
          onion_routing_enabled INTEGER NOT NULL DEFAULT 0,
          onion_hops INTEGER NOT NULL DEFAULT 0,
          kill_switch_enabled INTEGER NOT NULL DEFAULT 0,
          is_healthy INTEGER NOT NULL DEFAULT 1,
          is_quarantined INTEGER NOT NULL DEFAULT 0,
          quarantine_reason TEXT,
          risk_score INTEGER NOT NULL DEFAULT 0,
          last_geo_drift_at DATETIME,
          last_heartbeat DATETIME,
          latency_ms REAL NOT NULL DEFAULT 0.0,
          tx_bytes INTEGER NOT NULL DEFAULT 0,
          rx_bytes INTEGER NOT NULL DEFAULT 0,
          cpu_usage_pct REAL DEFAULT 0.0,
          memory_usage_pct REAL DEFAULT 0.0,
          battery_pct REAL DEFAULT 100.0,
          posture_checks TEXT DEFAULT '{"compliant": true, "disk_encrypted": true, "os": "Linux"}',
          metadata TEXT DEFAULT '{}',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_user_id ON nodes(user_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_public_key ON nodes(public_key);
      CREATE INDEX IF NOT EXISTS idx_nodes_overlay_ipv4 ON nodes(overlay_ipv4);
      CREATE INDEX IF NOT EXISTS idx_nodes_role ON nodes(role);
      CREATE INDEX IF NOT EXISTS idx_nodes_country_code ON nodes(country_code);
      CREATE INDEX IF NOT EXISTS idx_nodes_is_quarantined ON nodes(is_quarantined);

      -- 3. App Bundles Table
      CREATE TABLE IF NOT EXISTS app_bundles (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('guacamole', 'nextcloud', 'immich', 'seafile')),
          tier TEXT NOT NULL DEFAULT 'managed_cloud' CHECK (tier IN ('managed_cloud', 'self_hosted_byos')),
          status TEXT NOT NULL DEFAULT 'stopped' CHECK (status IN ('provisioning', 'running', 'stopped', 'error', 'suspended', 'hibernated')),
          endpoint_url TEXT NOT NULL,
          internal_port INTEGER NOT NULL DEFAULT 8080,
          container_id TEXT,
          cpu_cores REAL NOT NULL DEFAULT 2.0,
          memory_mb INTEGER NOT NULL DEFAULT 2048,
          storage_gb INTEGER NOT NULL DEFAULT 50,
          scale_to_zero INTEGER NOT NULL DEFAULT 1,
          inactivity_timeout_min INTEGER DEFAULT 30,
          config_json TEXT DEFAULT '{}',
          last_accessed_at DATETIME,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_bundles_user_id ON app_bundles(user_id);
      CREATE INDEX IF NOT EXISTS idx_app_bundles_type ON app_bundles(type);
      CREATE INDEX IF NOT EXISTS idx_app_bundles_status ON app_bundles(status);

      -- 4. Audit Events Table
      CREATE TABLE IF NOT EXISTS audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'error', 'critical')),
          actor_user_id TEXT,
          actor_username TEXT,
          target_id TEXT,
          target_type TEXT,
          message TEXT NOT NULL,
          ip_address TEXT,
          user_agent TEXT,
          metadata_json TEXT DEFAULT '{}',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_audit_events_severity ON audit_events(severity);
      CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id);

      -- 5. System Metrics Table
      CREATE TABLE IF NOT EXISTS system_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          active_nodes INTEGER NOT NULL DEFAULT 0,
          active_users INTEGER NOT NULL DEFAULT 0,
          total_bandwidth_rx INTEGER NOT NULL DEFAULT 0,
          total_bandwidth_tx INTEGER NOT NULL DEFAULT 0,
          cpu_usage_pct REAL NOT NULL DEFAULT 0.0,
          memory_usage_mb REAL NOT NULL DEFAULT 0.0,
          active_circuits INTEGER NOT NULL DEFAULT 0,
          network_health_score INTEGER NOT NULL DEFAULT 100
      );

      CREATE INDEX IF NOT EXISTS idx_system_metrics_timestamp ON system_metrics(timestamp DESC);

      -- 6. Refresh Tokens Table
      CREATE TABLE IF NOT EXISTS refresh_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at DATETIME NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          user_agent TEXT,
          ip_address TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

      -- 7. NeroDrop P2P File Transfer Sessions Table
      CREATE TABLE IF NOT EXISTS nerodrop_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          file_name TEXT NOT NULL,
          file_size_bytes INTEGER NOT NULL,
          file_type TEXT DEFAULT 'application/octet-stream',
          blake3_hash TEXT NOT NULL,
          chunk_size_bytes INTEGER NOT NULL DEFAULT 65536,
          total_chunks INTEGER NOT NULL,
          transferred_chunks INTEGER NOT NULL DEFAULT 0,
          bytes_transferred INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'pending', 'transferring', 'completed', 'failed', 'cancelled')),
          webrtc_signal_json TEXT DEFAULT '{}',
          started_at DATETIME,
          completed_at DATETIME,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_nerodrop_user_id ON nerodrop_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_nerodrop_status ON nerodrop_sessions(status);

      -- 8. App Share Links Table
      CREATE TABLE IF NOT EXISTS app_share_links (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL REFERENCES app_bundles(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          share_token TEXT NOT NULL UNIQUE,
          public_url TEXT NOT NULL,
          auth_mode TEXT NOT NULL DEFAULT 'temporary_password' CHECK (auth_mode IN ('temporary_password', 'sso_gateway', 'passkey')),
          temporary_password TEXT,
          expires_at DATETIME NOT NULL,
          max_uses INTEGER DEFAULT 0,
          use_count INTEGER DEFAULT 0,
          is_revoked INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_share_links_token ON app_share_links(share_token);
      CREATE INDEX IF NOT EXISTS idx_app_share_links_app_id ON app_share_links(app_id);
      CREATE INDEX IF NOT EXISTS idx_app_share_links_user_id ON app_share_links(user_id);
    `
  },
  {
    name: '002_onion_and_share_links',
    sql: `
      CREATE TABLE IF NOT EXISTS app_share_links (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL REFERENCES app_bundles(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          share_token TEXT NOT NULL UNIQUE,
          public_url TEXT NOT NULL,
          auth_mode TEXT NOT NULL DEFAULT 'temporary_password' CHECK (auth_mode IN ('temporary_password', 'sso_gateway', 'passkey')),
          temporary_password TEXT,
          expires_at DATETIME NOT NULL,
          max_uses INTEGER DEFAULT 0,
          use_count INTEGER DEFAULT 0,
          is_revoked INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_app_share_links_token ON app_share_links(share_token);
      CREATE INDEX IF NOT EXISTS idx_app_share_links_app_id ON app_share_links(app_id);
      CREATE INDEX IF NOT EXISTS idx_app_share_links_user_id ON app_share_links(user_id);
    `,
    run: (db) => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'").all();
      if (tables.length > 0) {
        const nodeCols = db.pragma('table_info(nodes)').map(c => c.name);
        if (!nodeCols.includes('onion_routing_enabled')) {
          db.exec('ALTER TABLE nodes ADD COLUMN onion_routing_enabled INTEGER NOT NULL DEFAULT 0;');
        }
        if (!nodeCols.includes('kill_switch_enabled')) {
          db.exec('ALTER TABLE nodes ADD COLUMN kill_switch_enabled INTEGER NOT NULL DEFAULT 0;');
        }
      }
    }
  },
  {
    name: '003_m2_advanced_engines',
    sql: `
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

      CREATE TABLE IF NOT EXISTS node_telemetry_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          ip_address TEXT NOT NULL,
          latitude REAL,
          longitude REAL,
          country_code TEXT NOT NULL DEFAULT 'US',
          latency_ms REAL NOT NULL DEFAULT 0.0,
          calculated_speed_kmh REAL DEFAULT 0.0,
          is_impossible_travel INTEGER NOT NULL DEFAULT 0,
          recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_node_telemetry_node_time ON node_telemetry_history(node_id, recorded_at DESC);

      CREATE TABLE IF NOT EXISTS peering_agreements (
          id TEXT PRIMARY KEY,
          initiator_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          peer_name TEXT NOT NULL,
          peer_endpoint TEXT NOT NULL,
          peer_token_ed25519 TEXT NOT NULL,
          peer_public_key_ed25519 TEXT NOT NULL,
          scope_mode TEXT NOT NULL DEFAULT 'ALL' CHECK (scope_mode IN ('ALL', 'SPECIFIC_DEVICES', 'SPECIFIC_SUBNETS')),
          shared_device_ids TEXT NOT NULL DEFAULT '[]',
          shared_subnets TEXT NOT NULL DEFAULT '[]',
          imported_nodes TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
          expires_at DATETIME NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_peering_status ON peering_agreements(status);

      CREATE TABLE IF NOT EXISTS cloud_pcs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL,
          specs TEXT NOT NULL DEFAULT '{"vcpus": 4, "ram_gb": 16}',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('provisioning', 'active', 'stopped', 'error')),
          signaling_url TEXT NOT NULL DEFAULT 'wss://signal.internal.darknero.com/ws/selkies',
          custom_domain TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_pcs_user ON cloud_pcs(user_id);

      CREATE TABLE IF NOT EXISTS custom_domains (
          id TEXT PRIMARY KEY,
          domain_name TEXT NOT NULL UNIQUE,
          cloud_pc_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          sso_gateway_enabled INTEGER NOT NULL DEFAULT 1,
          otp_secret TEXT,
          webrtc_signaling_endpoint TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON custom_domains(domain_name);
    `,
    run: (db) => {
      const adminUser = db.prepare("SELECT id FROM users WHERE role = 'super-admin' LIMIT 1").get();
      const node = db.prepare("SELECT id FROM nodes LIMIT 1").get();
      if (adminUser && node) {
        const count = db.prepare('SELECT count(*) as cnt FROM cloud_pcs').get();
        if (count && count.cnt === 0) {
          db.prepare(`
            INSERT OR IGNORE INTO cloud_pcs (id, name, user_id, device_id, specs, status, signaling_url, custom_domain)
            VALUES ('cpc-0001', 'Admin GPU Workstation', ?, ?, '{"vcpus": 8, "ram_gb": 32, "gpu": "RTX 4090"}', 'active', 'wss://signal.internal.darknero.com/ws/selkies', 'desktop.admin.darknero.com')
          `).run(adminUser.id, node.id);

          // Random even for the demo row: a seeded domain with a known OTP secret is
          // a live bypass on any database that was ever seeded.
          db.prepare(`
            INSERT OR IGNORE INTO custom_domains (id, domain_name, cloud_pc_id, user_id, sso_gateway_enabled, otp_secret)
            VALUES ('cdom-0001', 'desktop.admin.darknero.com', 'cpc-0001', ?, 1, ?)
          `).run(adminUser.id, require('crypto').randomBytes(20).toString('hex'));
        }
      }
    }
  }
];

const SQLITE_MIGRATION_010 = {
  name: '010_nodes_fillfactor',
  // No SQLite equivalent. Fill factor is a PostgreSQL page-packing setting; SQLite
  // has no HOT update path for it to enable. Registered so the two migration
  // sequences stay aligned and the numbering does not drift.
  sql: ''
};

const SQLITE_MIGRATION_009 = {
  name: '009_key_revocation',
  sql: `
      -- Mirrors migration 009 on the PostgreSQL side.
      CREATE TABLE IF NOT EXISTS revoked_keys (
          public_key_hex TEXT PRIMARY KEY,
          node_id TEXT,
          reason TEXT NOT NULL DEFAULT 'manual',
          revoked_by TEXT,
          revoked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_revoked_keys_expiry ON revoked_keys(expires_at);
  `
};

const SQLITE_MIGRATION_008 = {
  name: '008_network_routes',
  sql: `
      -- Mirrors migration 008 on the PostgreSQL side.
      CREATE TABLE IF NOT EXISTS network_routes (
          id TEXT PRIMARY KEY,
          network_id TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          network_cidr TEXT NOT NULL,
          masquerade INTEGER NOT NULL DEFAULT 1,
          failover_mode TEXT NOT NULL DEFAULT 'ACTIVE_PASSIVE'
              CHECK (failover_mode IN ('ACTIVE_PASSIVE', 'ACTIVE_ACTIVE_ECMP')),
          routing_peers TEXT NOT NULL DEFAULT '[]',
          groups TEXT NOT NULL DEFAULT '[]',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_network_routes_enabled ON network_routes(enabled);
      CREATE INDEX IF NOT EXISTS idx_network_routes_network ON network_routes(network_id);
  `
};

const SQLITE_MIGRATION_007 = {
  name: '007_acl_rules',
  sql: `
      -- Mirrors migration 007 on the PostgreSQL side.
      CREATE TABLE IF NOT EXISTS acl_rules (
          id TEXT PRIMARY KEY,
          priority INTEGER NOT NULL DEFAULT 100,
          source_cidr TEXT NOT NULL DEFAULT '0.0.0.0/0',
          destination_cidr TEXT NOT NULL DEFAULT '0.0.0.0/0',
          protocol TEXT NOT NULL DEFAULT 'ALL' CHECK (protocol IN ('TCP', 'UDP', 'ICMP', 'ALL')),
          port_start INTEGER NOT NULL DEFAULT 0,
          port_end INTEGER NOT NULL DEFAULT 65535,
          action TEXT NOT NULL DEFAULT 'ACCEPT' CHECK (action IN ('ACCEPT', 'DROP')),
          description TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_acl_rules_priority ON acl_rules(priority, id);
      CREATE INDEX IF NOT EXISTS idx_acl_rules_enabled ON acl_rules(enabled);

      CREATE TABLE IF NOT EXISTS mesh_epochs (
          name TEXT PRIMARY KEY,
          epoch INTEGER NOT NULL DEFAULT 1,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT OR IGNORE INTO mesh_epochs (name, epoch) VALUES ('acl', 1);
      INSERT OR IGNORE INTO mesh_epochs (name, epoch) VALUES ('routes', 1);
  `
};

const SQLITE_MIGRATION_006 = {
  name: '006_vip_counter',
  sql: `
      -- SQLite has no sequences, so the counter is a single row updated inside a
      -- transaction. Mirrors migration 006 on the PostgreSQL side; see that file for
      -- why allocation stopped scanning the nodes table.
      CREATE TABLE IF NOT EXISTS vip_allocator (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          next_offset INTEGER NOT NULL
      );
  `,
  run(db) {
    const existing = db.prepare('SELECT next_offset FROM vip_allocator WHERE id = 1').get();
    if (existing) {
      return;
    }

    // Position the counter past every address already handed out.
    const rows = db.prepare("SELECT overlay_ipv4 FROM nodes WHERE overlay_ipv4 LIKE '100.%'").all();

    let highest = 0;
    for (const row of rows) {
      const parts = String(row.overlay_ipv4).split('.');
      if (parts.length !== 4) continue;

      const [, o2, o3, o4] = parts.map(Number);
      if (!Number.isInteger(o2) || o2 < 64 || o2 > 127) continue;

      const offset = (o2 - 64) * 65536 + o3 * 256 + o4;
      if (offset > highest) highest = offset;
    }

    db.prepare('INSERT INTO vip_allocator (id, next_offset) VALUES (1, ?)').run(highest + 1);
  }
};

const SQLITE_MIGRATION_005 = {
  name: '005_schema_parity',
  sql: `
      -- Mirrors migration 005 on the PostgreSQL side.
      --
      -- custom_domains.device_id was declared for PostgreSQL only, so any code path
      -- writing it worked on one backend and failed on the other.
      ALTER TABLE custom_domains ADD COLUMN device_id TEXT REFERENCES nodes(id) ON DELETE CASCADE;
  `,
  run(db) {
    // SQLite cannot drop a column default in place, so the table is rebuilt without
    // it. A shared default OTP secret means every row created without an explicit
    // value carries the same credential, committed in the schema itself.
    const columns = db.pragma('table_info(custom_domains)');
    const hasSharedDefault = columns.some(
      (c) => c.name === 'otp_secret' && c.dflt_value !== null
    );
    if (!hasSharedDefault) {
      return;
    }

    db.exec(`
      CREATE TABLE custom_domains_rebuilt (
          id TEXT PRIMARY KEY,
          domain_name TEXT NOT NULL UNIQUE,
          cloud_pc_id TEXT NOT NULL,
          device_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          sso_gateway_enabled INTEGER NOT NULL DEFAULT 1,
          otp_secret TEXT,
          webrtc_signaling_endpoint TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO custom_domains_rebuilt (
          id, domain_name, cloud_pc_id, device_id, user_id, sso_gateway_enabled,
          otp_secret, webrtc_signaling_endpoint, status, created_at, updated_at
      )
      SELECT id, domain_name, cloud_pc_id, device_id, user_id, sso_gateway_enabled,
             otp_secret, webrtc_signaling_endpoint, status, created_at, updated_at
      FROM custom_domains;

      DROP TABLE custom_domains;
      ALTER TABLE custom_domains_rebuilt RENAME TO custom_domains;
      CREATE INDEX IF NOT EXISTS idx_custom_domains_name ON custom_domains(domain_name);
    `);
  }
};

const SQLITE_MIGRATION_004 = {
  name: '004_node_latlng',
  sql: `
      -- Mirrors migration 004 on the PostgreSQL side, which replaced a PostGIS
      -- GEOMETRY column with plain coordinates. Both backends now declare the same
      -- logical schema, which is what makes the drift check in the test suite
      -- meaningful: the two schemas are maintained by hand in separate files and
      -- had already diverged before this.
      ALTER TABLE nodes ADD COLUMN latitude REAL;
      ALTER TABLE nodes ADD COLUMN longitude REAL;
      CREATE INDEX IF NOT EXISTS idx_nodes_latlng ON nodes(latitude, longitude);
  `
};

function ensureSchemaIntegrity(db) {
  if (typeof db.prepare !== 'function') return;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'").all();
  if (tables.length > 0) {
    const nodeCols = db.pragma('table_info(nodes)').map(c => c.name);
    if (!nodeCols.includes('onion_routing_enabled')) {
      logger.info('Schema healing: Adding missing onion_routing_enabled column to nodes table...');
      db.exec('ALTER TABLE nodes ADD COLUMN onion_routing_enabled INTEGER NOT NULL DEFAULT 0;');
    }
    if (!nodeCols.includes('kill_switch_enabled')) {
      logger.info('Schema healing: Adding missing kill_switch_enabled column to nodes table...');
      db.exec('ALTER TABLE nodes ADD COLUMN kill_switch_enabled INTEGER NOT NULL DEFAULT 0;');
    }
  }
}

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
    const appliedSet = new Set(res.rows.map(r => r.name));

    if (fs.existsSync(MIGRATIONS_DIR)) {
      const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
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

function runSQLiteMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedRows = db.prepare('SELECT name FROM _migrations').all();
  const appliedSet = new Set(appliedRows.map(r => r.name));

  const migrations = [
    ...SQLITE_MIGRATIONS,
    SQLITE_MIGRATION_004,
    SQLITE_MIGRATION_005,
    SQLITE_MIGRATION_006,
    SQLITE_MIGRATION_007,
    SQLITE_MIGRATION_008,
    SQLITE_MIGRATION_009,
    SQLITE_MIGRATION_010
  ];

  for (const migration of migrations) {
    if (!appliedSet.has(migration.name)) {
      logger.info(`Applying SQLite migration: ${migration.name}...`);
      db.transaction(() => {
        if (migration.sql) {
          db.exec(migration.sql);
        }
        if (typeof migration.run === 'function') {
          migration.run(db);
        }
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.name);
      })();
      logger.info(`Migration ${migration.name} applied successfully.`);
    }
  }

  ensureSchemaIntegrity(db);
}

function runMigrations(dbOrPool) {
  if (dbOrPool && typeof dbOrPool.connect === 'function') {
    return runPostgresMigrations(dbOrPool);
  }
  if (dbOrPool && typeof dbOrPool.prepare === 'function') {
    return runSQLiteMigrations(dbOrPool);
  }
  const { isPostgres, getPgPool, getDatabase } = require('./index');
  if (isPostgres()) {
    return runPostgresMigrations(getPgPool());
  } else {
    return runSQLiteMigrations(getDatabase());
  }
}

module.exports = {
  SQLITE_MIGRATION_004,
  SQLITE_MIGRATION_005,
  SQLITE_MIGRATION_006,
  SQLITE_MIGRATION_007,
  SQLITE_MIGRATION_008,
  SQLITE_MIGRATION_009,
  SQLITE_MIGRATION_010,
  runMigrations,
  runPostgresMigrations,
  runSQLiteMigrations,
  ensureSchemaIntegrity,
  MIGRATIONS: SQLITE_MIGRATIONS
};
