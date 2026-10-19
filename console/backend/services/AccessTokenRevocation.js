const crypto = require('crypto');
const { transaction, currentUser, lockFamily, revokeFamily } = require('./ConsoleSessionService');

async function revokeAccessTokenAndRefresh({ token, userId, sessionId, expiresAt }) {
  try {
    await transaction(async (client) => {
      await currentUser(client, userId);
      await lockFamily(client, userId, sessionId);
      await client.query(
        `INSERT INTO access_token_revocations (token_hash, user_id, expires_at)
         VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO NOTHING`,
        [crypto.createHash('sha256').update(token).digest('hex'), userId, expiresAt ? new Date(expiresAt) : null]
      );
      // The authenticated family, never a credential supplied in the body, sets scope.
      await revokeFamily(client, userId, sessionId, 'logout');
    });
  } catch (error) {
    if (error.status === 401) throw error;
    const unavailable = new Error('Session revocation unavailable');
    unavailable.status = 503;
    throw unavailable;
  }
}

module.exports = { revokeAccessTokenAndRefresh };
