// Runs in its own process with rate limiting really enabled (see the caller).
// Sprays wrong second-factor codes at one password-step challenge while varying the
// username in the body, and prints the HTTP statuses as JSON on stdout.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { createApp } = require('../../server');
const { setupTestDatabase } = require('./db');
const Totp = require('../../services/TotpService');

async function main() {
  const db = await setupTestDatabase();
  try {
    const app = createApp();
    const id = `usr-mfa-limit-${crypto.randomUUID().slice(0, 8)}`;
    const password = 'MfaChallengeLimit123!';
    await db.pool.query(
      `INSERT INTO users(id,username,email,password_hash,role,status,organization_id,totp_enabled,totp_secret)
       VALUES($1,$1,$2,$3,'user','active','org-default',TRUE,$4)`,
      [id, `${id}@test.local`, await bcrypt.hash(password, 4), Totp.generateSecret()]
    );
    const pending = await request(app).post('/api/auth/login').send({ username: id, password });
    if (pending.status !== 200 || !pending.body.mfa_token) throw new Error('Fixture MFA challenge failed');
    const statuses = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await request(app)
        .post('/api/auth/mfa/verify')
        .send({ username: `spray-${attempt}`, mfa_token: pending.body.mfa_token, code: '000000' });
      statuses.push(response.status);
    }
    // Application logs share stdout; the result travels on its own marked line.
    process.stdout.write(`\nPROBE_RESULT ` + JSON.stringify({ statuses }) + '\n');
  } finally {
    await db.cleanup();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(String(error?.stack || error));
    process.exit(1);
  }
);
