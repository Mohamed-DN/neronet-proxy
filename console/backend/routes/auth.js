const express = require('express');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimit');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDatabase, isPostgres, getPgPool } = require('../db/index');
const {
  signToken,
  signRefreshToken,
  authenticateToken,
  verifyToken,
  verifyRefreshToken
} = require('../middleware/auth');
const { blacklistToken, isTokenBlacklisted } = require('../db/valkey');
const { logAuditEvent } = require('../utils/audit');

// Pre-computed constant-time dummy bcrypt hash to prevent timing side-channel attacks on non-existent usernames
const DUMMY_BCRYPT_HASH = '$2a$10$wN3t8gX1ZkGkR0e2M8t0y.9gZ0n4p7s2e6u1v8w5x9y2z3a4b5c6d';

// 1. Register User (Public)
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const { username, password, email, role } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required registration fields' });
    }

    const userId = `usr-${uuidv4().substring(0, 8)}`;
    const userRole = role === 'super-admin' ? 'super-admin' : 'user';
    const userEmail = email || `${username}@sovereign.local`;
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);

    if (isPostgres()) {
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
          $1, $2, $3, $4, $5, 'active', '[]'::jsonb
        )
      `,
        [userId, username, userEmail, passwordHash, userRole]
      );
    } else {
      const db = getDatabase();
      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      db.prepare(
        `
        INSERT INTO users (
          id, username, email, password_hash, role, status
        ) VALUES (
          ?, ?, ?, ?, ?, 'active'
        )
      `
      ).run(userId, username, userEmail, passwordHash, userRole);
    }

    logAuditEvent({
      eventType: 'USER_REGISTER',
      severity: 'info',
      actorUserId: userId,
      actorUsername: username,
      targetId: userId,
      targetType: 'user',
      message: `User ${username} registered successfully`,
      ipAddress: req.ip
    });

    const userObj = {
      id: userId,
      username,
      role: userRole
    };

    const token = signToken(userObj);
    const refreshToken = signRefreshToken(userObj);

    return res.status(201).json({
      token,
      refreshToken,
      user: userObj
    });
  } catch (err) {
    next(err);
  }
});

// 2. Login User (Public - Strict bcrypt + constant-time dummy verification)
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing username or password' });
    }

    let user = null;

    if (isPostgres()) {
      const pool = getPgPool();
      const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      user = userRes.rows[0] || null;
    } else {
      const db = getDatabase();
      user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
    }

    // Timing side-channel mitigation: If user doesn't exist, perform dummy bcrypt comparison
    if (!user) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    let isMatch = false;
    let accessTier = 'standard'; // 'standard', 'root', 'stealth_wipe', 'nuclear_wipe'

    try {
      if (user.password_hash && (await bcrypt.compare(password, user.password_hash))) {
        isMatch = true;
        accessTier = 'standard';
      } else if (user.password_hash_root && (await bcrypt.compare(password, user.password_hash_root))) {
        isMatch = true;
        accessTier = 'root';
      } else if (user.password_hash_stealth_wipe && (await bcrypt.compare(password, user.password_hash_stealth_wipe))) {
        isMatch = true;
        accessTier = 'stealth_wipe';
      } else if (user.password_hash_nuclear_wipe && (await bcrypt.compare(password, user.password_hash_nuclear_wipe))) {
        isMatch = true;
        accessTier = 'nuclear_wipe';
      }
    } catch (err) {
      isMatch = false;
    }

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // EXECUTE DURESS PROTOCOLS IF APPLICABLE
    if (accessTier === 'stealth_wipe') {
      try {
        if (isPostgres()) {
          const pool = getPgPool();
          await pool.query(
            'DELETE FROM nodes WHERE compartment_id IN (SELECT id FROM compartments WHERE is_hidden = TRUE)'
          );
          await pool.query('DELETE FROM compartments WHERE is_hidden = TRUE');
        } else {
          const db = getDatabase();
          db.prepare(
            'DELETE FROM nodes WHERE compartment_id IN (SELECT id FROM compartments WHERE is_hidden = 1)'
          ).run();
          db.prepare('DELETE FROM compartments WHERE is_hidden = 1').run();
        }
        console.warn(`[DURESS] Stealth wipe triggered by ${username}`);
      } catch (e) {
        console.error('Stealth wipe failed:', e);
      }
      accessTier = 'standard'; // Drop them into the standard view so it looks normal
    } else if (accessTier === 'nuclear_wipe') {
      try {
        if (isPostgres()) {
          const pool = getPgPool();
          await pool.query('TRUNCATE TABLE nodes, users CASCADE');
        } else {
          const db = getDatabase();
          db.prepare('DELETE FROM nodes').run();
          db.prepare('DELETE FROM users').run();
        }
        console.warn(`[DURESS] NUCLEAR WIPE triggered by ${username}`);
        return res.status(401).json({ error: 'Invalid username or password' }); // Act like it failed so they don't see an empty shell if it was a real attacker
      } catch (e) {
        console.error('Nuclear wipe failed:', e);
      }
    }

    if (user.status === 'suspended' || user.status === 'revoked') {
      return res.status(403).json({ error: 'Account is suspended or revoked' });
    }

    const userPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      compartment_access: accessTier // 'standard' or 'root'
    };

    const token = signToken(userPayload);
    const refreshToken = signRefreshToken(userPayload);

    logAuditEvent({
      eventType: 'AUTH_LOGIN',
      severity: 'info',
      actorUserId: user.id,
      actorUsername: user.username,
      targetId: user.id,
      targetType: 'user',
      message: `User ${user.username} logged in successfully`,
      ipAddress: req.ip
    });

    return res.status(200).json({
      token,
      refreshToken,
      user: userPayload
    });
  } catch (err) {
    next(err);
  }
});

// 3. Refresh Token
router.post('/refresh', async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    let token = '';

    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.body && req.body.refreshToken) {
      token = req.body.refreshToken;
    }

    if (!token) {
      return res.status(401).json({ error: 'Missing token for refresh' });
    }

    const blacklisted = await isTokenBlacklisted(token);
    if (blacklisted) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }

    // A refresh token only. Accepting an access token here let anyone holding a
    // 15-minute token exchange it for another indefinitely, which removes the reason
    // access tokens are short-lived.
    const decoded = verifyRefreshToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const newToken = signToken({
      id: decoded.sub || decoded.id,
      username: decoded.username,
      role: decoded.role
    });

    return res.status(200).json({ token: newToken });
  } catch (err) {
    next(err);
  }
});

// 4. Get Current User (Authenticated)
router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    let user = null;
    if (isPostgres()) {
      const pool = getPgPool();
      const userRes = await pool.query(
        'SELECT id, username, email, role, status, bypass_apps, created_at FROM users WHERE id = $1',
        [req.user.id]
      );
      user = userRes.rows[0] || null;
    } else {
      const db = getDatabase();
      user = db
        .prepare('SELECT id, username, email, role, status, bypass_apps, created_at FROM users WHERE id = ?')
        .get(req.user.id);
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let bypassApps = user.bypass_apps;
    if (typeof bypassApps === 'string') {
      try {
        bypassApps = JSON.parse(bypassApps);
      } catch (e) {
        bypassApps = [];
      }
    }

    return res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        status: user.status,
        bypass_apps: bypassApps || [],
        created_at: user.created_at
      }
    });
  } catch (err) {
    next(err);
  }
});

// 5. Logout (Authenticated - adds token to Valkey revocation cache)
router.post('/logout', authenticateToken, async (req, res, next) => {
  try {
    const token = req.token;

    if (token) {
      // 1. Blacklist in Valkey with 15m TTL
      await blacklistToken(token, 900);

      // 2. Persist in database refresh_tokens table
      try {
        if (isPostgres()) {
          const pool = getPgPool();
          await pool.query(
            `
            INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked, ip_address)
            VALUES ($1, $2, $3, NOW() + INTERVAL '7 days', TRUE, $4)
          `,
            [`tok-${uuidv4().substring(0, 8)}`, req.user.id, token, req.ip || '127.0.0.1']
          );
        } else {
          const db = getDatabase();
          db.prepare(
            `
            INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked, ip_address)
            VALUES (?, ?, ?, datetime('now', '+7 days'), 1, ?)
          `
          ).run(`tok-${uuidv4().substring(0, 8)}`, req.user.id, token, req.ip || '127.0.0.1');
        }
      } catch (e) {
        // Table fallback
      }
    }

    logAuditEvent({
      eventType: 'AUTH_LOGOUT',
      severity: 'info',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: req.user.id,
      targetType: 'user',
      message: `User ${req.user.username} logged out`,
      ipAddress: req.ip
    });

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (err) {
    next(err);
  }
});

// 6. Setup Steganographic Passwords (Requires Root/Standard auth)
router.post('/setup-passwords', authenticateToken, async (req, res, next) => {
  try {
    const { pwd_standard, pwd_root, pwd_stealth, pwd_nuclear } = req.body;

    // Hash them if provided
    const hashes = {};
    if (pwd_standard) hashes.password_hash = await bcrypt.hash(pwd_standard, 10);
    if (pwd_root) hashes.password_hash_root = await bcrypt.hash(pwd_root, 10);
    if (pwd_stealth) hashes.password_hash_stealth_wipe = await bcrypt.hash(pwd_stealth, 10);
    if (pwd_nuclear) hashes.password_hash_nuclear_wipe = await bcrypt.hash(pwd_nuclear, 10);

    if (Object.keys(hashes).length === 0) {
      return res.status(400).json({ error: 'No passwords provided to update' });
    }

    if (isPostgres()) {
      const pool = getPgPool();
      let queryArgs = [];
      let setClauses = [];
      let i = 1;
      for (const [col, hash] of Object.entries(hashes)) {
        setClauses.push(`${col} = $${i}`);
        queryArgs.push(hash);
        i++;
      }
      queryArgs.push(req.user.id);
      await pool.query(`UPDATE users SET ${setClauses.join(', ')} WHERE id = $${i}`, queryArgs);
    } else {
      const db = getDatabase();
      let setClauses = [];
      let queryArgs = [];
      for (const [col, hash] of Object.entries(hashes)) {
        setClauses.push(`${col} = ?`);
        queryArgs.push(hash);
      }
      queryArgs.push(req.user.id);
      db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...queryArgs);
    }

    logAuditEvent({
      eventType: 'AUTH_STEGANO_UPDATE',
      severity: 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: req.user.id,
      targetType: 'user',
      message: `User ${req.user.username} updated their multi-tier passwords`,
      ipAddress: req.ip
    });

    return res.status(200).json({ success: true, updated: Object.keys(hashes) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
