const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getPgPool } = require('../../db/index');
const { authenticateToken } = require('../../middleware/auth');
const { logAuditEvent } = require('../../utils/audit');

// Request field -> column, in the order sign-in tries them.
const TIERS = [
  ['pwd_standard', 'password_hash'],
  ['pwd_root', 'password_hash_root'],
  ['pwd_stealth', 'password_hash_stealth_wipe'],
  ['pwd_nuclear', 'password_hash_nuclear_wipe']
];

// Setup Steganographic Passwords
//
// These passwords can destroy data, so setting one needs the current password, the
// same as changing the ordinary one does (PUT /api/users/:id). A stolen session alone
// must not be enough to plant a wipe that the next sign-in would trigger.
router.post('/setup-passwords', authenticateToken, async (req, res, next) => {
  try {
    const body = req.body || {};
    const provided = TIERS.filter(([field]) => body[field]).map(([field, column]) => ({
      field,
      column,
      value: String(body[field])
    }));

    if (provided.length === 0) {
      return res.status(400).json({ error: 'No passwords provided to update' });
    }
    if (!body.current_password) {
      return res.status(400).json({ error: 'Current password is required to change passwords' });
    }

    const pool = getPgPool();
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userRes.rows[0];
    if (!user || !user.password_hash || !(await bcrypt.compare(String(body.current_password), user.password_hash))) {
      return res.status(400).json({ error: 'Incorrect current password' });
    }

    // Sign-in stops at the first tier that matches, so a password shared by two tiers
    // silently disables the later one. Refuse that rather than store a duress
    // password that can never fire.
    const values = provided.map((p) => p.value);
    if (new Set(values).size !== values.length) {
      return res.status(400).json({ error: 'Each password must be different' });
    }
    const replaced = new Set(provided.map((p) => p.column));
    for (const [, column] of TIERS) {
      const storedHash = user[column];
      if (!storedHash || replaced.has(column)) continue;
      for (const p of provided) {
        if (await bcrypt.compare(p.value, storedHash)) {
          return res.status(400).json({ error: 'Each password must be different' });
        }
      }
    }

    const setClauses = [];
    const queryArgs = [];
    for (const p of provided) {
      queryArgs.push(await bcrypt.hash(p.value, 10));
      setClauses.push(`${p.column} = $${queryArgs.length}`);
    }
    queryArgs.push(req.user.id);
    await pool.query(
      `UPDATE users SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${queryArgs.length}`,
      queryArgs
    );

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

    return res.status(200).json({ success: true, updated: provided.map((p) => p.column) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
