const { issueConsoleTestToken } = require('./helpers/consoleSession');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { setupTestDatabase } = require('./helpers/db');
const { createApp } = require('../server');
const AclEngine = require('../services/AclEngine');
const { settleAuditWrites } = require('../utils/audit');

const ORG = 'org-lines';

describe('Network map lines API (appearance, order, split, merge, preview)', () => {
  let db;
  let pool;
  let app;
  let owner;
  let root;
  let member;
  let netAdmin;
  const nodes = {};

  const as = (token) => ({ Authorization: `Bearer ${token}` });
  const get = (path, t = owner) => request(app).get(`/api/compartments${path}`).set(as(t));
  const post = (path, body, t = owner) =>
    request(app)
      .post(`/api/compartments${path}`)
      .set(as(t))
      .send(body || {});
  const put = (path, body, t = owner) =>
    request(app)
      .put(`/api/compartments${path}`)
      .set(as(t))
      .send(body || {});
  const epoch = () => AclEngine.getEpoch('acl');
  const nodeComp = async (id) =>
    (await pool.query('SELECT compartment_id FROM nodes WHERE id = $1', [id])).rows[0].compartment_id;
  const defaultId = `cmp-${ORG}`;

  async function line(name, extra = {}, t = owner) {
    const res = await post('', { name, ...extra }, t);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.compartment;
  }

  async function auditFor(type) {
    await settleAuditWrites();
    const r = await pool.query(
      'SELECT target_id, metadata_json FROM audit_events WHERE event_type = $1 ORDER BY sequence_num DESC LIMIT 1',
      [type]
    );
    return r.rows[0];
  }

  async function mkUser(id, role, tier) {
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, role, organization_id)
       VALUES ($1, $3, $4, 'x', 'user', $2) ON CONFLICT (id) DO NOTHING`,
      [id, ORG, id, `${id}@example.com`]
    );
    await pool.query(
      `INSERT INTO memberships (id, user_id, organization_id, role) VALUES ($4, $1, $2, $3)
       ON CONFLICT (user_id, organization_id) DO NOTHING`,
      [id, ORG, role, `m-${id}`]
    );
    return issueConsoleTestToken({
      sub: id,
      id,
      username: id,
      role: 'user',
      organization_id: ORG,
      compartment_access: tier
    });
  }

  async function mkNode(key, n) {
    await pool.query(
      `INSERT INTO nodes (id, organization_id, user_id, name, overlay_ipv4, overlay_ipv6, public_key, role, is_healthy, is_quarantined)
       VALUES ($1, $2, 'ln-owner', $3, $4, $5, $6, 'CLIENT_ORIGIN', TRUE, FALSE)`,
      [`ln-${key}`, ORG, `Device ${key}`, `10.77.0.${n}`, `fd00:77::${n}`, `LinesKey${key}`.padEnd(44, 'x')]
    );
    nodes[key] = `ln-${key}`;
  }

  before(async () => {
    db = await setupTestDatabase();
    pool = db.pool;
    app = createApp();
    await pool.query(
      `INSERT INTO organizations (id, name, slug, default_policy) VALUES ($1, 'Lines Org', 'lines-org', 'open')
       ON CONFLICT (id) DO NOTHING`,
      [ORG]
    );
    owner = await mkUser('ln-owner', 'owner', 'standard');
    root = await mkUser('ln-root', 'owner', 'root');
    member = await mkUser('ln-member', 'member', 'standard');
    netAdmin = await mkUser('ln-netadmin', 'network_admin', 'standard');
    for (const [i, k] of ['a', 'b', 'c', 'd', 'e'].entries()) await mkNode(k, i + 1);
    await get(''); // seeds the default line
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('appearance and order', () => {
    it('migration adds line_colour (nullable, constrained) and sort_order', async () => {
      const cols = await pool.query(
        "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='compartments' AND column_name IN ('line_colour','sort_order')"
      );
      const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.is_nullable]));
      assert.strictEqual(byName.line_colour, 'YES');
      assert.strictEqual(byName.sort_order, 'NO');
      await assert.rejects(pool.query("UPDATE compartments SET line_colour = 'pink' WHERE id = $1", [defaultId]));
    });

    it('PUT sets colour and order, and moves no ACL epoch', async () => {
      const l = await line('Appearance');
      const before = await epoch();
      const res = await put(`/${l.id}`, { line_colour: 'violet', sort_order: 7 });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.compartment.line_colour, 'violet');
      assert.strictEqual(res.body.compartment.sort_order, 7);
      assert.strictEqual(await epoch(), before);
    });

    it('PUT null clears the colour; a name outside the palette or a bad order is a 400', async () => {
      const l = await line('Palette');
      await put(`/${l.id}`, { line_colour: 'red' });
      const cleared = await put(`/${l.id}`, { line_colour: null });
      assert.strictEqual(cleared.body.compartment.line_colour, null);
      assert.strictEqual((await put(`/${l.id}`, { line_colour: 'pink' })).status, 400);
      assert.strictEqual((await put(`/${l.id}`, { sort_order: 'x' })).status, 400);
      assert.strictEqual((await put(`/${l.id}`, { sort_order: -1 })).status, 400);
      assert.strictEqual((await put(`/${l.id}`, { sort_order: 1.5 })).status, 400);
    });

    it('lists by sort_order, then created_at; a new line goes last', async () => {
      const x = await line('Order X');
      const y = await line('Order Y');
      const list = (await get('')).body.compartments;
      assert.ok(list.findIndex((c) => c.id === x.id) < list.findIndex((c) => c.id === y.id));
      assert.ok(y.sort_order > x.sort_order);
    });

    it('PUT /reorder sets sort_order in one go and rejects unknown or repeated ids', async () => {
      const p = await line('Re P');
      const q = await line('Re Q');
      const before = await epoch();
      const res = await put('/reorder', { ids: [q.id, p.id] });
      assert.strictEqual(res.status, 200);
      const list = res.body.compartments;
      assert.ok(list.findIndex((c) => c.id === q.id) < list.findIndex((c) => c.id === p.id));
      assert.strictEqual(await epoch(), before);

      const bad = await put('/reorder', { ids: [p.id, 'cmp-nope'] });
      assert.strictEqual(bad.status, 400);
      const again = await get('');
      assert.ok(
        again.body.compartments.findIndex((c) => c.id === q.id) <
          again.body.compartments.findIndex((c) => c.id === p.id),
        'a refused reorder changed nothing'
      );
      assert.strictEqual((await put('/reorder', { ids: [p.id, p.id] })).status, 400);
      assert.strictEqual((await put('/reorder', { ids: [] })).status, 400);
    });

    it('a member cannot edit appearance', async () => {
      assert.strictEqual((await put(`/${defaultId}`, { line_colour: 'red' }, member)).status, 403);
      assert.strictEqual((await put('/reorder', { ids: [defaultId] }, member)).status, 403);
    });
  });

  describe('duplicate names', () => {
    it('create with a name already used is 409 name_in_use, not 500', async () => {
      await line('Twin');
      const res = await post('', { name: 'Twin' });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, 'name_in_use');
      assert.strictEqual((await post('', { name: 'twin' })).status, 409);
      assert.strictEqual((await post('', { name: 'Other', slug: 'twin' })).status, 409);
    });

    it('rename onto another line name is 409, onto its own name is fine', async () => {
      const a = await line('Rename A');
      await line('Rename B');
      const res = await put(`/${a.id}`, { name: 'rename b' });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, 'name_in_use');
      assert.strictEqual((await put(`/${a.id}`, { name: 'Rename A', line_colour: 'blue' })).status, 200);
    });

    it('a missing or blank name is a 400', async () => {
      assert.strictEqual((await post('', { name: '   ' })).status, 400);
      assert.strictEqual((await post('', {})).status, 400);
    });
  });

  describe('split', () => {
    it('creates the line, moves the nodes, bumps the epoch once, audits it, and reports peerings not inherited', async () => {
      const src = await line('Split Src');
      const peer = await line('Split Peer');
      await post('/peerings/create', { src_compartment_id: src.id, dst_compartment_id: peer.id });
      await post(`/${src.id}/members`, { node_ids: [nodes.a, nodes.b, nodes.c] });

      const before = await epoch();
      const res = await post(`/${src.id}/split`, {
        name: 'Split New',
        node_ids: [nodes.a, nodes.b],
        line_colour: 'sky'
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const created = res.body.compartment;
      assert.strictEqual(created.name, 'Split New');
      assert.strictEqual(created.line_colour, 'sky');
      assert.deepStrictEqual(res.body.moved.sort(), [nodes.a, nodes.b]);
      assert.strictEqual(res.body.peerings_not_inherited.count, 1);
      assert.deepStrictEqual(res.body.peerings_not_inherited.peers, ['Split Peer']);
      assert.strictEqual(await nodeComp(nodes.a), created.id);
      assert.strictEqual(await nodeComp(nodes.c), src.id);
      assert.strictEqual(await epoch(), before + 1, 'one epoch bump');
      const peers = await get('/peerings/list');
      assert.ok(
        !peers.body.peerings.some((p) => p.src_compartment_id === created.id || p.dst_compartment_id === created.id)
      );

      const ev = await auditFor('COMPARTMENT_SPLIT');
      assert.strictEqual(ev.target_id, created.id);
      assert.strictEqual(ev.metadata_json.from, src.id);
      assert.strictEqual(ev.metadata_json.to, created.id);
      assert.deepStrictEqual([...ev.metadata_json.node_ids].sort(), [nodes.a, nodes.b]);
    });

    it('rolls everything back when a node is not in the source line', async () => {
      const src = await line('Split Rollback');
      await post(`/${src.id}/members`, { node_ids: [nodes.d] });
      const before = await epoch();
      const res = await post(`/${src.id}/split`, { name: 'Never Made', node_ids: [nodes.d, nodes.e] });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, 'nodes_not_in_source');
      assert.strictEqual(await nodeComp(nodes.d), src.id);
      assert.strictEqual(await epoch(), before);
      const names = (await get('')).body.compartments.map((c) => c.name);
      assert.ok(!names.includes('Never Made'));
    });

    it('treats a node with no line as being in the default line', async () => {
      await pool.query('UPDATE nodes SET compartment_id = NULL WHERE id = $1', [nodes.e]);
      const res = await post(`/${defaultId}/split`, { name: 'From Default', node_ids: [nodes.e] });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(await nodeComp(nodes.e), res.body.compartment.id);
    });

    it('refuses a duplicate name (409, nothing moved), empty node list, and a member caller', async () => {
      const src = await line('Split Dup');
      await post(`/${src.id}/members`, { node_ids: [nodes.a] });
      assert.strictEqual((await post(`/${src.id}/split`, { name: 'split dup', node_ids: [nodes.a] })).status, 409);
      assert.strictEqual(await nodeComp(nodes.a), src.id);
      assert.strictEqual((await post(`/${src.id}/split`, { name: 'Z', node_ids: [] })).status, 400);
      assert.strictEqual((await post(`/${src.id}/split`, { name: 'Z', node_ids: [nodes.a] }, member)).status, 403);
      assert.strictEqual((await post('/cmp-nope/split', { name: 'Z', node_ids: [nodes.a] })).status, 404);
    });

    it('a network_admin may split', async () => {
      const src = await line('Split NA');
      await post(`/${src.id}/members`, { node_ids: [nodes.b] });
      const res = await post(`/${src.id}/split`, { name: 'Split NA Child', node_ids: [nodes.b] }, netAdmin);
      assert.strictEqual(res.status, 201);
    });
  });

  describe('merge', () => {
    it('moves every member, drops the peerings of the merged line and names them, deletes it, one epoch bump, audits it', async () => {
      const from = await line('Merge From');
      const into = await line('Merge Into');
      const pA = await line('Merge Peer A');
      const pB = await line('Merge Peer B');
      await post('/peerings/create', { src_compartment_id: from.id, dst_compartment_id: pA.id });
      await post('/peerings/create', { src_compartment_id: pB.id, dst_compartment_id: from.id });
      await post('/peerings/create', { src_compartment_id: into.id, dst_compartment_id: pA.id });
      await post(`/${from.id}/members`, { node_ids: [nodes.a, nodes.b] });

      const before = await epoch();
      const res = await post(`/${from.id}/merge`, { into: into.id });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.moved.sort(), [nodes.a, nodes.b]);
      assert.strictEqual(res.body.dropped_peerings.count, 2);
      assert.deepStrictEqual(res.body.dropped_peerings.peers, ['Merge Peer A', 'Merge Peer B']);
      assert.strictEqual(res.body.compartment.id, into.id);
      assert.strictEqual(await nodeComp(nodes.a), into.id);
      assert.strictEqual(await epoch(), before + 1);
      const gone = await pool.query('SELECT 1 FROM compartments WHERE id = $1', [from.id]);
      assert.strictEqual(gone.rows.length, 0);
      const kept = await pool.query('SELECT 1 FROM compartment_peerings WHERE src_compartment_id = $1', [into.id]);
      assert.strictEqual(kept.rows.length, 1, 'the target keeps its own peerings');

      const ev = await auditFor('COMPARTMENT_MERGE');
      assert.strictEqual(ev.metadata_json.from, from.id);
      assert.strictEqual(ev.metadata_json.into, into.id);
      assert.deepStrictEqual([...ev.metadata_json.node_ids].sort(), [nodes.a, nodes.b]);
      assert.strictEqual(ev.metadata_json.dropped_peerings, 2);
    });

    it('refuses the default line, itself, an unknown line and a network_admin', async () => {
      const other = await line('Merge Other');
      const r1 = await post(`/${defaultId}/merge`, { into: other.id });
      assert.strictEqual(r1.status, 400);
      assert.strictEqual(r1.body.error, 'default_line');
      assert.strictEqual((await post(`/${other.id}/merge`, { into: other.id })).status, 400);
      assert.strictEqual((await post(`/${other.id}/merge`, { into: 'cmp-nope' })).status, 404);
      assert.strictEqual((await post(`/${other.id}/merge`, { into: defaultId }, netAdmin)).status, 403);
      assert.strictEqual((await post(`/${other.id}/merge`, {})).status, 400);
    });

    it('can merge into the default line', async () => {
      const l = await line('Merge Default');
      await post(`/${l.id}/members`, { node_ids: [nodes.c] });
      const res = await post(`/${l.id}/merge`, { into: defaultId });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(await nodeComp(nodes.c), defaultId);
    });
  });

  describe('preview', () => {
    it('preview-move reports gains and losses and writes nothing', async () => {
      const l1 = await line('Prev One');
      const l2 = await line('Prev Two');
      await post(`/${l1.id}/members`, { node_ids: [nodes.a, nodes.b] });
      await post(`/${l2.id}/members`, { node_ids: [nodes.c, nodes.d] });
      const before = await epoch();
      const res = await post('/preview-move', { node_ids: [nodes.a], to: l2.id });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const a = res.body.nodes.find((n) => n.node_id === nodes.a);
      assert.deepStrictEqual(a.losses.names, ['Device b']);
      assert.deepStrictEqual(a.gains.names, ['Device c', 'Device d']);
      assert.strictEqual(a.gains.count, 2);
      assert.deepStrictEqual(res.body.summary, { nodes_moved: 1, gains: 2, losses: 1 });
      assert.strictEqual(await nodeComp(nodes.a), l1.id);
      assert.strictEqual(await epoch(), before);
    });

    it('preview-move honours allow peerings in the target position', async () => {
      const l1 = await line('Prev Peer One');
      const l2 = await line('Prev Peer Two');
      const l3 = await line('Prev Peer Three');
      await post(`/${l1.id}/members`, { node_ids: [nodes.a] });
      await post(`/${l2.id}/members`, { node_ids: [nodes.b] });
      await post(`/${l3.id}/members`, { node_ids: [nodes.c] });
      await post('/peerings/create', { src_compartment_id: l2.id, dst_compartment_id: l3.id });
      const res = await post('/preview-move', { node_ids: [nodes.a], to: l2.id });
      const a = res.body.nodes[0];
      assert.ok(a.gains.names.includes('Device b'));
      assert.ok(a.gains.names.includes('Device c'));
    });

    it('preview-split shows the new line cut off from everything but its own members', async () => {
      const l = await line('Prev Split');
      await post(`/${l.id}/members`, { node_ids: [nodes.a, nodes.b, nodes.c] });
      const before = await epoch();
      const res = await post(`/${l.id}/preview-split`, { node_ids: [nodes.a] });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.nodes[0].losses.names.includes('Device b'));
      assert.ok(res.body.nodes[0].losses.names.includes('Device c'));
      assert.strictEqual(res.body.nodes[0].gains.count, 0);
      assert.strictEqual(await epoch(), before);
      const bad = await post(`/${l.id}/preview-split`, { node_ids: [nodes.d] });
      assert.strictEqual(bad.status, 400);
    });

    it('validates input and role', async () => {
      assert.strictEqual((await post('/preview-move', { node_ids: [], to: defaultId })).status, 400);
      assert.strictEqual((await post('/preview-move', { node_ids: [nodes.a], to: 'cmp-nope' })).status, 404);
      assert.strictEqual((await post('/preview-move', { node_ids: [nodes.a], to: defaultId }, member)).status, 403);
    });
  });

  describe('audit detail', () => {
    it('COMPARTMENT_MEMBERS_SET carries node ids and from/to lines', async () => {
      const f = await line('Audit From');
      const t = await line('Audit To');
      await post(`/${f.id}/members`, { node_ids: [nodes.a, nodes.b] });
      await post(`/${t.id}/members`, { node_ids: [nodes.a, nodes.b] });
      const ev = await auditFor('COMPARTMENT_MEMBERS_SET');
      assert.strictEqual(ev.metadata_json.to, t.id);
      assert.deepStrictEqual([...ev.metadata_json.node_ids].sort(), [nodes.a, nodes.b]);
      assert.deepStrictEqual([...ev.metadata_json.from[f.id]].sort(), [nodes.a, nodes.b]);
    });

    it('COMPARTMENT_UPDATE carries before and after of what changed', async () => {
      const l = await line('Audit Upd');
      await put(`/${l.id}`, { name: 'Audit Upd 2', line_colour: 'green' });
      const ev = await auditFor('COMPARTMENT_UPDATE');
      assert.deepStrictEqual(ev.metadata_json.before, { name: 'Audit Upd', line_colour: null });
      assert.deepStrictEqual(ev.metadata_json.after, { name: 'Audit Upd 2', line_colour: 'green' });
    });
  });

  describe('hidden lines', () => {
    it('never appear to a standard caller in split, merge or preview, and root cannot merge across hiddenness', async () => {
      const hidden = (await post('', { name: 'Ghost Line', is_hidden: true }, root)).body.compartment;
      const visible = await line('Visible Line');
      await post(`/${hidden.id}/members`, { node_ids: [nodes.d] }, root);

      assert.strictEqual((await post(`/${hidden.id}/split`, { name: 'S', node_ids: [nodes.d] })).status, 404);
      assert.strictEqual((await post(`/${hidden.id}/merge`, { into: visible.id })).status, 404);
      assert.strictEqual((await post(`/${visible.id}/merge`, { into: hidden.id })).status, 404);
      assert.strictEqual((await post('/preview-move', { node_ids: [nodes.a], to: hidden.id })).status, 404);

      // A hidden device is not named in a visible preview.
      await post(`/${visible.id}/members`, { node_ids: [nodes.a, nodes.b] });
      const prev = await post('/preview-move', { node_ids: [nodes.a], to: defaultId });
      assert.ok(!JSON.stringify(prev.body).includes('Device d'));
      assert.ok(!JSON.stringify(prev.body).includes('Ghost'));

      // Peerings with a hidden line are not named when a visible line is merged.
      await post('/peerings/create', { src_compartment_id: visible.id, dst_compartment_id: hidden.id }, root);
      const res = await post(`/${visible.id}/merge`, { into: defaultId });
      assert.strictEqual(res.status, 200);
      assert.ok(!JSON.stringify(res.body).includes('Ghost'));

      const h2 = (await post('', { name: 'Ghost Two', is_hidden: true }, root)).body.compartment;
      const mix = await post(`/${h2.id}/merge`, { into: defaultId }, root);
      assert.strictEqual(mix.status, 400);
      assert.strictEqual(mix.body.error, 'hidden_mismatch');
    });

    it('a split of a hidden line by root stays hidden', async () => {
      const h = (await post('', { name: 'Ghost Three', is_hidden: true }, root)).body.compartment;
      await post(`/${h.id}/members`, { node_ids: [nodes.e] }, root);
      const res = await post(`/${h.id}/split`, { name: 'Ghost Three B', node_ids: [nodes.e] }, root);
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.compartment.is_hidden, true);
    });
  });
});
