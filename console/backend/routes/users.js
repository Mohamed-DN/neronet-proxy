const express = require('express');
const { readPageParams, pageEnvelope } = require('../utils/pagination');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getPgPool } = require('../db/index');
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
    status: row.status,
    bypass_apps: bypassApps || [],
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// 1. List Users (Super-Admin only)
router.get('/', requireRole('super-admin'), async (req, res, next) => {
  try {
    const { limit, offset } = readPageParams(req);

    const pool = getPgPool();
    const total = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const result = await pool.query('SELECT * FROM users ORDER BY created_at ASC, id ASC LIMIT $1 OFFSET $2', [
      limit,
      offset
    ]);
    const rows = result.rows;

    const users = rows.map(formatUser);
    return res.status(200).json({ users, ...pageEnvelope({ items: users, total, limit, offset }) });
  } catch (err) {
    next(err);
  }
});

// 2. Create User (Super-Admin only)
router.post('/', requireRole('super-admin'), async (req, res, next) => {
  try {
    const { username, password, email, role, bypass_apps } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const userId = `usr-${uuidv4().substring(0, 8)}`;
    const userRole = role === 'super-admin' ? 'super-admin' : 'user';
    const userEmail = email || `${username}@sovereign.local`;
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const bypassAppsJson = JSON.stringify(Array.isArray(bypass_apps) ? bypass_apps : []);

    const pool = getPgPool();
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    await pool.query(
      `
      INSERT INTO users (
        id, username, email, password_hash, role, status, bypass_apps
      ) VALUES (
        $1, $2, $3, $4, $5, 'active', $6::jsonb
      )
    `,
      [userId, username, userEmail, passwordHash, userRole, bypassAppsJson]
    );

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
  } catch (err) {
    next(err);
  }
});

// 3. Get User By ID (Super-Admin or Self)
router.get('/:id', requireSelfOrAdmin, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const row = result.rows[0] || null;

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
    if (req.body.status && req.user.role === 'super-admin') {
      updates.push(`status = $${pIdx++}`);
      params.push(req.body.status);
    }
    if (req.body.bypass_apps !== undefined) {
      updates.push(`bypass_apps = $${pIdx++}::jsonb`);
      params.push(JSON.stringify(Array.isArray(req.body.bypass_apps) ? req.body.bypass_apps : []));
    }
    if (req.body.password) {
      if (req.user.id === req.params.id) {
        if (!req.body.current_password) {
          return res.status(400).json({ error: 'Current password is required to change password' });
        }
        const currentMatch = await bcrypt.compare(req.body.current_password, existingRes.rows[0].password_hash);
        if (!currentMatch) {
          return res.status(400).json({ error: 'Incorrect current password' });
        }
      }
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
  } catch (err) {
    next(err);
  }
});

// 5. Delete User (Super-Admin only)
router.delete('/:id', requireRole('super-admin'), async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// 6. Get User Quota (Super-Admin or Self)
router.get('/:id/quota', requireSelfOrAdmin, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userRes.rows[0];
    const countRes = await pool.query('SELECT count(*) as count FROM nodes WHERE user_id = $1', [user.id]);
    const nodeCount = parseInt(countRes.rows[0].count, 10);

    // Usage, not entitlement. There are no tiers and no caps; how many nodes an
    // account has is still worth reporting, what it is allowed is not a thing.
    return res.status(200).json({
      user_id: user.id,
      used_nodes: nodeCount
    });
  } catch (err) {
    next(err);
  }
});

// 7. Revoke All User Sessions (Super-Admin or Self)
router.post('/:id/revoke-sessions', requireSelfOrAdmin, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const result = await pool.query(
      'UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE user_id = $1 AND (revoked = FALSE OR revoked IS NULL)',
      [req.params.id]
    );
    logAuditEvent({
      eventType: 'USER_REVOKE_SESSIONS',
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: req.params.id,
      targetType: 'user',
      message: `All active sessions revoked for user ${req.params.id} by ${req.user.username}`,
      ipAddress: req.ip
    });
    return res.status(200).json({ ok: true, revoked_count: result.rowCount || 0 });
  } catch (err) {
    next(err);
  }
});

// 8. Update Split Tunneling App Bypass (Super-Admin or Self)
router.put('/:id/split-tunneling', requireSelfOrAdmin, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const bypassApps = Array.isArray(req.body?.bypass_apps) ? req.body.bypass_apps : [];
    const result = await pool.query(
      'UPDATE users SET bypass_apps = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING *',
      [JSON.stringify(bypassApps), req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.status(200).json({ user: formatUser(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 9. Generate QR Onboarding Profile (Super-Admin or Self)
router.get('/:id/onboard-qr', requireSelfOrAdmin, async (req, res, next) => {
  try {
    const pool = getPgPool();
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userRes.rows[0];
    const dummyClientIp = '10.42.100.25';
    const configText = `[Interface]
# NeroNet Sovereign Mesh Onboarding Profile for ${user.username}
PrivateKey = <generated-on-client>
Address = ${dummyClientIp}/32
DNS = 100.100.100.100

[Peer]
PublicKey = 4gC5z7y2M3oN9rPt8xV1wK0jL5qS6uI3dF2hB1eA4gA=
Endpoint = vpn.sovereign.mesh:51820
AllowedIPs = 10.42.0.0/16, 100.64.0.0/10
PersistentKeepalive = 25
`;
    return res.status(200).json({
      config_text: configText,
      qr_code_data_url:
        'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="100%" height="100%" fill="white"/><text x="10" y="80" fill="black" font-size="12">NeroNet QR Profile</text></svg>',
      endpoint: 'vpn.sovereign.mesh:51820',
      expires_at: new Date(Date.now() + 86400000).toISOString()
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
