const crypto = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../server');
const { setupTestDatabase } = require('./db');

async function main() {
  const db = await setupTestDatabase();
  try {
    const app = createApp();
    const protocol = { 'X-NeroNet-Browser-Protocol': '2', Origin: 'http://localhost:8081' };
    const id = crypto.randomUUID();
    const first = await request(app).post('/api/auth/browser/context').set(protocol).send({ context_id: id });
    const cookie = (first.headers['set-cookie'] || [])[0]?.split(';')[0];
    if (first.status !== 200 || !cookie) throw new Error('Fixture context bootstrap failed');
    const creates = [first.status];
    for (let n = 0; n < 10; n += 1)
      creates.push(
        (await request(app).post('/api/auth/browser/context').set(protocol).send({ context_id: crypto.randomUUID() }))
          .status
      );
    const reads = [];
    for (let n = 0; n < 12; n += 1)
      reads.push(
        (
          await request(app)
            .post('/api/auth/browser/context')
            .set(protocol)
            .set('Cookie', cookie)
            .send({ context_id: id })
        ).status
      );
    const registration = await request(app).post('/api/auth/register').send({});
    const forgedId = crypto.randomUUID();
    const forged = await request(app)
      .post('/api/auth/browser/context')
      .set(protocol)
      .set('Cookie', `nn_ctx_${forgedId}=${'0'.repeat(64)}`)
      .send({ context_id: forgedId });
    const createdWithForgedBinding = (
      await db.pool.query('SELECT id FROM console_browser_contexts WHERE id=$1', [forgedId])
    ).rowCount;
    return {
      creates,
      reads,
      registrationStatus: registration.status,
      forgedStatus: forged.status,
      createdWithForgedBinding
    };
  } finally {
    await db.cleanup();
  }
}
main()
  .then((result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error.stack);
    process.exit(1);
  });
