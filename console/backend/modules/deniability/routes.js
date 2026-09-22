const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getPgPool } = require('../../db/index');
const { authenticateToken } = require('../../middleware/auth');
const { logAuditEvent } = require('../../utils/audit');

// Setup Steganographic Passwords (Requires Root/Standard auth)
router.post('/setup-passwords', authenticateToken, async (req, res, next) => {
  try {
    const { pwd_standard, pwd_root, pwd_stealth, pwd_nuclear } = req.body || {};

    const hashes = {};
    if (pwd_standard) hashes.password_hash = await bcrypt.hash(pwd_standard, 10);
    if (pwd_root) hashes.password_hash_root = await bcrypt.hash(pwd_root, 10);
    if (pwd_stealth) hashes.password_hash_stealth_wipe = await bcrypt.hash(pwd_stealth, 10);
    if (pwd_nuclear) hashes.password_hash_nuclear_wipe = await bcrypt.hash(pwd_nuclear, 10);

    if (Object.keys(hashes).length === 0) {
      return res.status(400).json({ error: 'No passwords provided to update' });
    }

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
