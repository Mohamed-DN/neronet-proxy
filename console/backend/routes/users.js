const express = require('express');
const { readPageParams, pageEnvelope } = require('../utils/pagination');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const { authenticateToken, requireRole, requireSelfOrAdmin } = require('../middleware/auth');
const { logAuditEvent } = require('../utils/audit');

router.use(authenticateToken);

function formatUser(row) {
  if (!row) return null;
  let bypassApps = row.bypass_apps;
  if (typeof bypassApps === 'string') {
    try {
      bypassApps = JSON.parse(bypassApps);
    } catch (e) {
      bypassApps = [];
    }
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    tier: row.tier,
    status: row.status,
    bypass_apps: bypassApps || [],
    quota: {
      max_nodes: row.max_nodes,
      max_bandwidth_gb: row.bandwidth_quota_gb,
      bandwidth_used_bytes: Number(row.bandwidth_used_bytes) || 0
    },
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// 1. List Users (Super-Admin only)
router.get('/', requireRole('super-admin'), async (req, res, next) => {
  try {
    const { limit, offset } = readPageParams(req);

    let rows = [];
    let total = 0;

    if (isPostgres()) {
      const pool = getPgPool();
      total = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
      const result = await pool.query(
        'SELECT * FROM users ORDER BY created_at ASC, id ASC LIMIT $1 OFFSET $2',
        [limit, offset]
      );
      rows = result.rows;
    } else {
      const db = getDatabase();
      total = db.prepare('SELECT count(*) AS n FROM users').get().n;
      rows = db
        .prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?')
        .all(limit, offset);
    }

    const users = rows.map(formatUser);
    return res.status(200).json({ users, ...pageEnvelope({ items: users, total, limit, offset }) });
  } catch (err) {
    next(err);
  }
});

// 2. Create User (Super-Admin only)
router.post('/', requireRole('super-admin'), async (req, res, next) => {
  try {
    const { username, password, email, role, tier, quota, bypass_apps } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const userId = `usr-${uuidv4().substring(0, 8)}`;
    const userRole = role === 'super-admin' ? 'super-admin' : 'user';
    const userTier = tier || 'hybrid_byos';
    const userEmail = email || `${username}@sovereign.local`;
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const bypassAppsJson = JSON.stringify(Array.isArray(bypass_apps) ? bypass_apps : []);

    const maxNodes = (quota && quota.max_nodes !== undefined) ? quota.max_nodes : (userTier === 'cloud_managed' || userTier === 'managed_cloud' ? 50 : 5);
    const maxBwGb = (quota && quota.max_bandwidth_gb !== undefined) ? quota.max_bandwidth_gb : (userTier === 'cloud_managed' || userTier === 'managed_cloud' ? 1000 : 100);

    if (isPostgres()) {
      const pool = getPgPool();
      const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      await pool.query(`
        INSERT INTO users (
          id, username, email, password_hash, role, tier, status,
          bandwidth_quota_gb, bandwidth_used_bytes, max_nodes, bypass_apps
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 'active', $7, 0, $8, $9::jsonb
        )
      `, [userId, username, userEmail, passwordHash, userRole, userTier, maxBwGb, maxNodes, bypassAppsJson]);

      const createdRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      const createdUser = formatUser(createdRes.rows[0]);

      logAuditEvent({
        eventType: 'USER_CREATE',
        severity: 'info',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: userId,
        targetType: 'user',
        message: `User ${username} created by ${req.user.username}`,
        ipAddress: req.ip
      });

      return res.status(201).json({ user: createdUser });
    } else {
      const db = getDatabase();
      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      db.prepare(`
        INSERT INTO users (
          id, username, email, password_hash, role, tier, status,
          bandwidth_quota_gb, bandwidth_used_bytes, max_nodes, bypass_apps
        ) VALUES (
          ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?
        )
      `).run(userId, username, userEmail, passwordHash, userRole, userTier, maxBwGb, maxNodes, bypassAppsJson);

      const createdUser = formatUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));

      logAuditEvent({
        eventType: 'USER_CREATE',
        severity: 'info',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: userId,
        targetType: 'user',
        message: `User ${username} created by ${req.user.username}`,
        ipAddress: req.ip
      });

      return res.status(201).json({ user: createdUser });
    }
  } catch (err) {
    next(err);
  }
});

// 3. Get User By ID (Super-Admin or Self)
router.get('/:id', requireSelfOrAdmin, async (req, res, next) => {
  try {
    let row = null;
    if (isPostgres()) {
      const pool = getPgPool();
      const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
      row = result.rows[0] || null;
    } else {
      const db = getDatabase();
      row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) || null;
    }

    if (!row) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.status(200).json({ user: formatUser(row) });
  } catch (err) {
    next(err);
  }
});

// 4. Update User (Super-Admin or Self)
router.put('/:id', requireSelfOrAdmin, async (req, res, next) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: 'Missing update body' });
    }

    if (isPostgres()) {
      const pool = getPgPool();
      const existingRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
      if (existingRes.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const updates = [];
      const params = [];
      let pIdx = 1;

      if (req.body.email) {
        updates.push(`email = $${pIdx++}`);
        params.push(req.body.email);
      }
      if (req.body.tier) {
        updates.push(`tier = $${pIdx++}`);
        params.push(req.body.tier);
      }
      if (req.body.status && req.user.role === 'super-admin') {
        updates.push(`status = $${pIdx++}`);
        params.push(req.body.status);
      }
      if (req.body.bypass_apps !== undefined) {
        updates.push(`bypass_apps = $${pIdx++}::jsonb`);
        params.push(JSON.stringify(Array.isArray(req.body.bypass_apps) ? req.body.bypass_apps : []));
      }
      if (req.body.quota) {
        if (req.body.quota.max_nodes !== undefined) {
          updates.push(`max_nodes = $${pIdx++}`);
          params.push(req.body.quota.max_nodes);
        }
        if (req.body.quota.max_bandwidth_gb !== undefined) {
          updates.push(`bandwidth_quota_gb = $${pIdx++}`);
          params.push(req.body.quota.max_bandwidth_gb);
        }
      }
      if (req.body.password) {
        const salt = bcrypt.genSaltSync(10);
        updates.push(`password_hash = $${pIdx++}`);
        params.push(bcrypt.hashSync(req.body.password, salt));
      }

      if (updates.length > 0) {
        updates.push('updated_at = NOW()');
        params.push(req.params.id);
        await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${pIdx}`, params);
      }

      const updatedRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
      return res.status(200).json({ user: formatUser(updatedRes.rows[0]) });
    } else {
      const db = getDatabase();
      const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }

      const updates = [];
      const params = [];

      if (req.body.email) {
        updates.push('email = ?');
        params.push(req.body.email);
      }
      if (req.body.tier) {
        updates.push('tier = ?');
        params.push(req.body.tier);
      }
      if (req.body.status && req.user.role === 'super-admin') {
        updates.push('status = ?');
        params.push(req.body.status);
      }
      if (req.body.bypass_apps !== undefined) {
        updates.push('bypass_apps = ?');
        params.push(JSON.stringify(Array.isArray(req.body.bypass_apps) ? req.body.bypass_apps : []));
      }
      if (req.body.quota) {
        if (req.body.quota.max_nodes !== undefined) {
          updates.push('max_nodes = ?');
          params.push(req.body.quota.max_nodes);
        }
        if (req.body.quota.max_bandwidth_gb !== undefined) {
          updates.push('bandwidth_quota_gb = ?');
          params.push(req.body.quota.max_bandwidth_gb);
        }
      }
      if (req.body.password) {
        const salt = bcrypt.genSaltSync(10);
        updates.push('password_hash = ?');
        params.push(bcrypt.hashSync(req.body.password, salt));
      }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        params.push(req.params.id);
        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }

      const updated = formatUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id));
      return res.status(200).json({ user: updated });
    }
  } catch (err) {
    next(err);
  }
});

// 5. Delete User (Super-Admin only)
router.delete('/:id', requireRole('super-admin'), async (req, res, next) => {
  try {
    if (isPostgres()) {
      const pool = getPgPool();
      const existingRes = await pool.query('SELECT id, username FROM users WHERE id = $1', [req.params.id]);
      if (existingRes.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const existing = existingRes.rows[0];
      await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);

      logAuditEvent({
        eventType: 'USER_DELETE',
        severity: 'warn',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: req.params.id,
        targetType: 'user',
        message: `User ${existing.username} (${req.params.id}) deleted by ${req.user.username}`,
        ipAddress: req.ip
      });

      return res.status(200).json({ success: true, message: 'User deleted successfully' });
    } else {
      const db = getDatabase();
      const existing = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }

      db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

      logAuditEvent({
        eventType: 'USER_DELETE',
        severity: 'warn',
        actorUserId: req.user.id,
        actorUsername: req.user.username,
        targetId: req.params.id,
        targetType: 'user',
        message: `User ${existing.username} (${req.params.id}) deleted by ${req.user.username}`,
        ipAddress: req.ip
      });

      return res.status(200).json({ success: true, message: 'User deleted successfully' });
    }
  } catch (err) {
    next(err);
  }
});

// 6. Get User Quota (Super-Admin or Self)
router.get('/:id/quota', requireSelfOrAdmin, async (req, res, next) => {
  try {
    if (isPostgres()) {
      const pool = getPgPool();
      const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const user = userRes.rows[0];
      const countRes = await pool.query('SELECT count(*) as count FROM nodes WHERE user_id = $1', [user.id]);
      const nodeCount = parseInt(countRes.rows[0].count, 10);

      return res.status(200).json({
        user_id: user.id,
        max_nodes: user.max_nodes,
        used_nodes: nodeCount,
        max_bandwidth_gb: user.bandwidth_quota_gb,
        used_bandwidth_bytes: Number(user.bandwidth_used_bytes) || 0,
        tier: user.tier
      });
    } else {
      const db = getDatabase();
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const nodeCount = db.prepare('SELECT count(*) as count FROM nodes WHERE user_id = ?').get(user.id).count;

      return res.status(200).json({
        user_id: user.id,
        max_nodes: user.max_nodes,
        used_nodes: nodeCount,
        max_bandwidth_gb: user.bandwidth_quota_gb,
        used_bandwidth_bytes: user.bandwidth_used_bytes || 0,
        tier: user.tier
      });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
