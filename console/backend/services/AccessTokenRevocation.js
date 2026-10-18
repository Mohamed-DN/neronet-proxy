const crypto = require('crypto');
const { getPgPool } = require('../db');

async function revokeAccessTokenAndRefresh({ token, userId, refreshToken, expiresAt }) {
  let client;
  try {
    client = await getPgPool().connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO access_token_revocations (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO NOTHING`,
      [crypto.createHash('sha256').update(token).digest('hex'), userId, expiresAt ? new Date(expiresAt) : null]
    );
    if (refreshToken) {
      const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await client.query(
        `UPDATE refresh_tokens SET revoked=TRUE, revoked_at=NOW()
          WHERE user_id=$1 AND (token_hash=$2 OR token_hash=$3)`,
        [userId, hash, refreshToken]
      );
    } else {
      // Existing API semantics without a refresh credential: revoke this user's
      // refresh credentials. Other access tokens need the separate family model.
      await client.query(
        'UPDATE refresh_tokens SET revoked=TRUE, revoked_at=NOW() WHERE user_id=$1 AND revoked=FALSE',
        [userId]
      );
    }
    await client.query('COMMIT');
  } catch {
    if (client) await client.query('ROLLBACK').catch(() => {});
    const error = new Error('Session revocation unavailable');
    error.status = 503;
    throw error;
  } finally {
    client?.release();
  }
}

module.exports = { revokeAccessTokenAndRefresh };
