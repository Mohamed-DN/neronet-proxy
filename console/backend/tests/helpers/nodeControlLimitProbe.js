/**
 * Exercises the node control API limiters in a process of their own and prints the
 * result as JSON. The limiters read their disable switch once, at module load, so the
 * suite (which runs with limiting off) cannot test them in-process.
 *
 * Every request carries the same X-Forwarded-For, as a whole fleet behind one proxy or
 * NAT does. Usage: node tests/helpers/nodeControlLimitProbe.js <scenario>
 */

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { mountNodeControlLimits } = require('../../middleware/rateLimit');

const SHARED_ADDRESS = '203.0.113.7';

function app() {
  const a = express();
  a.set('trust proxy', 1);
  a.use(express.json());
  mountNodeControlLimits(a);
  a.post('/v4/control/:route', (req, res) => res.json({ ok: true }));
  return a;
}

function credential() {
  return crypto.randomBytes(24).toString('hex');
}

const scenarios = {
  // A fleet behind one address: each node beats with its own credential. Metered by
  // address, this exhausted a 60-a-minute bucket after 60 beats across the fleet.
  async fleet() {
    const a = app();
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      id: `pk_${String(i).padStart(16, '0')}`,
      cred: credential()
    }));
    const codes = {};
    for (let beat = 0; beat < 8; beat++) {
      for (const node of nodes) {
        const res = await request(a)
          .post('/v4/control/heartbeat')
          .set('X-Forwarded-For', SHARED_ADDRESS)
          .set('Authorization', `Bearer ${node.cred}`)
          .send({ node_id: node.id });
        codes[res.status] = (codes[res.status] || 0) + 1;
      }
    }
    return { codes };
  },

  // Enrolment has no credential yet, so it stays metered by address.
  async enrolment() {
    const a = app();
    let firstRefusal = null;
    for (let i = 1; i <= 62; i++) {
      const res = await request(a)
        .post('/v4/control/register')
        .set('X-Forwarded-For', SHARED_ADDRESS)
        .set('Authorization', `Bearer ${credential()}`)
        .send({});
      if (res.status === 429 && firstRefusal === null) firstRefusal = i;
    }
    return { firstRefusal };
  },

  // One credential cannot hammer the control plane.
  async oneNode() {
    const a = app();
    const cred = credential();
    let firstRefusal = null;
    for (let i = 1; i <= 125; i++) {
      const res = await request(a)
        .post('/v4/control/netmap')
        .set('X-Forwarded-For', SHARED_ADDRESS)
        .set('Authorization', `Bearer ${cred}`)
        .send({ node_id: 'pk_0000000000000001' });
      if (res.status === 429 && firstRefusal === null) firstRefusal = i;
    }
    return { firstRefusal };
  }
};

(async () => {
  const name = process.argv[2];
  const run = scenarios[name];
  if (!run) {
    console.error(`unknown scenario ${name}`);
    process.exit(2);
  }
  const result = await run();
  process.stdout.write(`PROBE_RESULT ${JSON.stringify(result)}\n`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
