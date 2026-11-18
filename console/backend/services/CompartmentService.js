const { v4: uuidv4 } = require('uuid');
const { getPgPool } = require('../db/index');
const { logAuditEvent } = require('../utils/audit');
const AclEngine = require('./AclEngine');
const { previewMove } = require('./CompartmentReach');

// A node with no organisation belongs to the default one (see AclEngine).
const DEFAULT_ORG = 'org-default';
// The most nodes one request may move. A fleet larger than this moves in batches.
const MAX_MEMBERS_PER_REQUEST = 1000;

// The six line tokens of the console design. The database CHECK (migration 054) holds the same list.
const LINE_COLOURS = ['red', 'green', 'blue', 'orange', 'violet', 'sky'];
const MAX_SORT_ORDER = 1000000;
const MAX_REORDER = 500;
const MAX_NAME_LENGTH = 128;

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

const nameInUse = () => httpError(409, 'A line with this name already exists', 'name_in_use');

/** Run fn in one transaction; commit on return, roll back on a throw. */
async function inTransaction(fn) {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the connection is gone; the original error is the one to report
    }
    throw err;
  } finally {
    client.release();
  }
}

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'name is required', 'name_required');
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) throw httpError(400, `name is at most ${MAX_NAME_LENGTH} characters`);
  return trimmed;
}

function slugOf(name) {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function cleanColour(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !LINE_COLOURS.includes(value)) {
    throw httpError(400, `line_colour must be one of ${LINE_COLOURS.join(', ')} or null`, 'bad_line_colour');
  }
  return value;
}

function cleanSortOrder(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_SORT_ORDER) {
    throw httpError(400, `sort_order must be an integer from 0 to ${MAX_SORT_ORDER}`, 'bad_sort_order');
  }
  return value;
}

function cleanNodeIds(nodeIds) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0 || nodeIds.some((id) => typeof id !== 'string' || !id)) {
    throw httpError(400, 'node_ids must be a non-empty array of node ids');
  }
  if (nodeIds.length > MAX_MEMBERS_PER_REQUEST) {
    throw httpError(400, `At most ${MAX_MEMBERS_PER_REQUEST} nodes per request`);
  }
  return [...new Set(nodeIds)];
}

/** Is the name taken in the organisation (names compare without regard to case)? */
async function nameTaken(db, organizationId, name, exceptId = null) {
  const res = await db.query(
    'SELECT 1 FROM compartments WHERE organization_id = $1 AND lower(name) = lower($2) AND id <> $3 LIMIT 1',
    [organizationId, name, exceptId || '']
  );
  return res.rows.length > 0;
}

const isUniqueViolation = (err) => err && err.code === '23505';

const EFFECTIVE_COMPARTMENT = `COALESCE(n.compartment_id, 'cmp-' || COALESCE(n.organization_id, '${DEFAULT_ORG}'))`;

/**
 * Compartments are sub-networks the data plane enforces (ADR 0021): AclEngine only
 * offers a node the peers in its own compartment and in the compartments peered with
 * it. Anything here that changes who is in which compartment, or which compartments
 * are peered, changes compiled policies, so it advances the ACL epoch and the fleet
 * re-fetches within a heartbeat.
 */
class CompartmentService {
  /**
   * Ensure default compartment exists for organization
   */
  static async ensureDefaultCompartment(organizationId) {
    const pool = getPgPool();
    const defaultId = `cmp-${organizationId}`;
    await pool.query(
      `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden, created_at, updated_at)
       VALUES ($1, $2, 'Default Compartment', 'default', '100.64.0.0/24', FALSE, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [defaultId, organizationId]
    );
  }

  /**
   * List compartments for an organization.
   * If accessTier !== 'root', filter out hidden compartments (is_hidden = TRUE).
   */
  static async listCompartments(organizationId, accessTier = 'standard') {
    const pool = getPgPool();
    let query = 'SELECT * FROM compartments WHERE organization_id = $1';
    const params = [organizationId];

    if (accessTier !== 'root') {
      query += ' AND is_hidden = FALSE';
    }

    query += ' ORDER BY sort_order ASC, created_at ASC, name ASC';
    let res = await pool.query(query, params);

    if (res.rows.length === 0) {
      await CompartmentService.ensureDefaultCompartment(organizationId);
      res = await pool.query(query, params);
    }

    return res.rows;
  }

  /**
   * Get single compartment by ID.
   * Returns null if not found or if is_hidden = TRUE and accessTier !== 'root' (acts like 404).
   */
  static async getCompartment(id, organizationId, accessTier = 'standard') {
    const pool = getPgPool();
    const res = await pool.query('SELECT * FROM compartments WHERE id = $1 AND organization_id = $2', [
      id,
      organizationId
    ]);

    if (res.rows.length === 0) return null;
    const compartment = res.rows[0];

    if (compartment.is_hidden && accessTier !== 'root') {
      return null;
    }

    return compartment;
  }

  /**
   * Create a new compartment within an organization.
   */
  static async createCompartment(
    { organizationId, name, slug, subnetCidr, isHidden = false, lineColour },
    accessTier = 'standard',
    actor
  ) {
    if (!organizationId) {
      throw new Error('Missing required compartment fields');
    }
    name = cleanName(name);

    // Only root access tier can create hidden compartments
    if (isHidden && accessTier !== 'root') {
      throw new Error('Forbidden: root access tier required to create hidden compartments');
    }

    const pool = getPgPool();
    const compSlug = slug || slugOf(name);
    const compId = `cmp-${uuidv4().substring(0, 8)}`;
    const cidr = subnetCidr || '100.64.0.0/24';
    const colour = lineColour === undefined ? null : cleanColour(lineColour);

    if (await nameTaken(pool, organizationId, name)) throw nameInUse();

    let res;
    try {
      res = await pool.query(
        `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden, line_colour, sort_order, created_at, updated_at)
         VALUES ($1, $2::varchar, $3, $4, $5, $6, $7,
                 (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM compartments WHERE organization_id = $2::varchar), NOW(), NOW())
         RETURNING *`,
        [compId, organizationId, name, compSlug, cidr, Boolean(isHidden), colour]
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw nameInUse();
      throw err;
    }

    logAuditEvent({
      eventType: 'COMPARTMENT_CREATE',
      organizationId: res.rows[0].organization_id,
      severity: isHidden ? 'warn' : 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: compId,
      targetType: 'compartment',
      message: `Compartment ${name} created in org ${organizationId}${isHidden ? ' (GHOST/HIDDEN)' : ''}`
    });

    return res.rows[0];
  }

  /**
   * Update compartment.
   */
  static async updateCompartment(id, organizationId, updates, accessTier = 'standard', actor) {
    const pool = getPgPool();
    const existing = await CompartmentService.getCompartment(id, organizationId, accessTier);
    if (!existing) return null;

    const { name, subnetCidr, isHidden, lineColour, sortOrder } = updates;
    const fields = [];
    const args = [];
    let i = 1;

    if (name !== undefined && name !== null && name !== '') {
      const clean = cleanName(name);
      if (await nameTaken(pool, organizationId, clean, id)) throw nameInUse();
      fields.push(`name = $${i++}`);
      args.push(clean);
    }
    if (subnetCidr) {
      fields.push(`subnet_cidr = $${i++}`);
      args.push(subnetCidr);
    }
    if (isHidden !== undefined) {
      if (accessTier !== 'root') {
        throw new Error('Forbidden: root access tier required to toggle hidden status');
      }
      fields.push(`is_hidden = $${i++}`);
      args.push(Boolean(isHidden));
    }
    // Display only: colour and order never touch the ACL epoch.
    if (lineColour !== undefined) {
      fields.push(`line_colour = $${i++}`);
      args.push(cleanColour(lineColour));
    }
    if (sortOrder !== undefined) {
      fields.push(`sort_order = $${i++}`);
      args.push(cleanSortOrder(sortOrder));
    }

    if (fields.length === 0) return existing;

    fields.push(`updated_at = NOW()`);
    args.push(id, organizationId);

    const res = await pool.query(
      `UPDATE compartments SET ${fields.join(', ')} WHERE id = $${i++} AND organization_id = $${i++} RETURNING *`,
      args
    );

    // What changed, before and after, so the log can say "renamed A to B" rather than "updated".
    const before = {};
    const after = {};
    for (const key of ['name', 'subnet_cidr', 'is_hidden', 'line_colour', 'sort_order']) {
      if (res.rows[0] && existing[key] !== res.rows[0][key]) {
        before[key] = existing[key] ?? null;
        after[key] = res.rows[0][key] ?? null;
      }
    }

    logAuditEvent({
      eventType: 'COMPARTMENT_UPDATE',
      organizationId: res.rows[0]?.organization_id || organizationId,
      severity: 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: id,
      targetType: 'compartment',
      message: `Compartment ${id} updated`,
      metadata: { before, after }
    });

    return res.rows[0];
  }

  /**
   * Delete compartment. Invariant: cannot delete the default compartment.
   */
  static async deleteCompartment(id, organizationId, accessTier = 'standard', actor) {
    const pool = getPgPool();
    const existing = await CompartmentService.getCompartment(id, organizationId, accessTier);
    if (!existing) return false;

    if (existing.slug === 'default') {
      throw new Error('Cannot delete the default compartment of an organization');
    }

    // Its nodes fall back to the default compartment (ON DELETE SET NULL), and its
    // peerings go with it (ON DELETE CASCADE): both change who reaches whom.
    await pool.query('DELETE FROM compartments WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    await AclEngine.bumpEpoch('acl');

    logAuditEvent({
      eventType: 'COMPARTMENT_DELETE',
      organizationId: organizationId,
      severity: 'warn',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: id,
      targetType: 'compartment',
      message: `Compartment ${id} deleted`
    });

    return true;
  }

  /**
   * List peering rules between compartments.
   *
   * Below the root tier a peering that touches a hidden compartment is left out: its
   * row carries the hidden compartment's id and name, which is exactly what the
   * compartment list already withholds.
   */
  static async listPeeringRules(organizationId, accessTier = 'standard') {
    const pool = getPgPool();
    const res = await pool.query(
      `SELECT p.*, s.name AS src_name, d.name AS dst_name
       FROM compartment_peerings p
       JOIN compartments s ON p.src_compartment_id = s.id
       JOIN compartments d ON p.dst_compartment_id = d.id
       WHERE p.organization_id = $1
         AND ($2 = 'root' OR (s.is_hidden = FALSE AND d.is_hidden = FALSE))
       ORDER BY p.created_at ASC`,
      [organizationId, accessTier]
    );
    return res.rows;
  }

  /**
   * Create or replace the peering between two compartments.
   *
   * A peering connects its two compartments both ways, so there is one row per pair:
   * an existing row in either direction is replaced. Both compartments must belong to
   * the caller's organisation and be visible at the caller's access tier -- otherwise
   * an id from another tenant, or a hidden compartment's id, would be accepted and
   * now that peerings are enforced, acted on.
   */
  static async createPeeringRule(
    { organizationId, srcCompartmentId, dstCompartmentId, policy = 'allow' },
    actor,
    accessTier = 'standard'
  ) {
    if (!['allow', 'deny'].includes(policy)) {
      throw httpError(400, "policy must be 'allow' or 'deny'");
    }
    if (srcCompartmentId === dstCompartmentId) {
      throw httpError(400, 'A compartment cannot be peered with itself');
    }
    const src = await CompartmentService.getCompartment(srcCompartmentId, organizationId, accessTier);
    const dst = await CompartmentService.getCompartment(dstCompartmentId, organizationId, accessTier);
    if (!src || !dst) {
      throw httpError(404, 'Compartment not found');
    }

    const pool = getPgPool();
    const peerId = `peer-${uuidv4().substring(0, 8)}`;

    await pool.query(
      `DELETE FROM compartment_peerings
        WHERE organization_id = $1
          AND ((src_compartment_id = $2 AND dst_compartment_id = $3) OR (src_compartment_id = $3 AND dst_compartment_id = $2))`,
      [organizationId, srcCompartmentId, dstCompartmentId]
    );
    const res = await pool.query(
      `INSERT INTO compartment_peerings (id, organization_id, src_compartment_id, dst_compartment_id, policy, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [peerId, organizationId, srcCompartmentId, dstCompartmentId, policy]
    );
    await AclEngine.bumpEpoch('acl');

    logAuditEvent({
      eventType: 'COMPARTMENT_PEER_CREATE',
      organizationId: res.rows[0].organization_id,
      severity: 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: peerId,
      targetType: 'compartment_peering',
      message: `Peering ${policy} created between ${srcCompartmentId} and ${dstCompartmentId}`
    });

    return res.rows[0];
  }

  /** Remove a peering. Returns false when the organisation has no such peering. */
  static async deletePeeringRule(id, organizationId, actor) {
    const pool = getPgPool();
    const res = await pool.query(
      'DELETE FROM compartment_peerings WHERE id = $1 AND organization_id = $2 RETURNING organization_id, src_compartment_id, dst_compartment_id',
      [id, organizationId]
    );
    if (res.rows.length === 0) return false;
    await AclEngine.bumpEpoch('acl');

    logAuditEvent({
      eventType: 'COMPARTMENT_PEER_DELETE',
      organizationId: res.rows[0].organization_id,
      severity: 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: id,
      targetType: 'compartment_peering',
      message: `Peering between ${res.rows[0].src_compartment_id} and ${res.rows[0].dst_compartment_id} removed`
    });

    return true;
  }

  /**
   * Move nodes into a compartment.
   *
   * Only nodes of the organisation move; ids from elsewhere are ignored rather than
   * reported, so the answer does not confirm another tenant's node ids. Below the root
   * tier, nodes in a hidden compartment are left where they are, for the same reason
   * the compartment itself reads as absent there. Returns the ids that moved, or null
   * when the compartment is not found.
   *
   * The audit event names the nodes and the compartment each one came from.
   */
  static async setMembers(compartmentId, organizationId, nodeIds, accessTier = 'standard', actor) {
    const ids = cleanNodeIds(nodeIds);

    const target = await CompartmentService.getCompartment(compartmentId, organizationId, accessTier);
    if (!target) return null;

    const { moved, from } = await inTransaction(async (client) => {
      const res = await client.query(
        `WITH before AS (
           SELECT n.id, ${EFFECTIVE_COMPARTMENT} AS from_id
             FROM nodes n
            WHERE n.id = ANY($2::text[])
              AND COALESCE(n.organization_id, '${DEFAULT_ORG}') = $3
              AND ($4 = 'root' OR NOT EXISTS (SELECT 1 FROM compartments c WHERE c.id = n.compartment_id AND c.is_hidden = TRUE))
              FOR UPDATE OF n
         ), upd AS (
           UPDATE nodes n SET compartment_id = $1 FROM before b WHERE n.id = b.id RETURNING n.id
         )
         SELECT b.id, b.from_id FROM before b JOIN upd u ON u.id = b.id`,
        [compartmentId, ids, organizationId, accessTier]
      );
      const rows = res.rows.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
      if (rows.length > 0) await AclEngine.bumpEpoch('acl', client);
      const grouped = {};
      for (const r of rows) (grouped[r.from_id] ||= []).push(r.id);
      return { moved: rows.map((r) => r.id), from: grouped };
    });

    if (moved.length > 0) {
      logAuditEvent({
        eventType: 'COMPARTMENT_MEMBERS_SET',
        organizationId: target.organization_id,
        severity: target.is_hidden ? 'warn' : 'info',
        actorUserId: actor?.id,
        actorUsername: actor?.username,
        targetId: compartmentId,
        targetType: 'compartment',
        message: `${moved.length} node(s) moved into compartment ${compartmentId}`,
        metadata: { to: compartmentId, node_ids: moved, from }
      });
    }

    return moved;
  }

  /**
   * Set the order lines are listed and drawn in: ids[0] first. One transaction, so a
   * refused request changes nothing. Lines not named keep their number; ties fall back
   * to creation order. Display only: no ACL epoch bump. Returns the new list.
   */
  static async reorderCompartments(organizationId, ids, accessTier = 'standard', actor) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id)) {
      throw httpError(400, 'ids must be a non-empty array of compartment ids');
    }
    if (ids.length > MAX_REORDER) throw httpError(400, `At most ${MAX_REORDER} lines per request`);
    if (new Set(ids).size !== ids.length) throw httpError(400, 'ids must not repeat', 'duplicate_ids');

    await inTransaction(async (client) => {
      const known = await client.query(
        `SELECT id FROM compartments
          WHERE organization_id = $1 AND id = ANY($2::text[]) AND ($3 = 'root' OR is_hidden = FALSE)
          FOR UPDATE`,
        [organizationId, ids, accessTier]
      );
      if (known.rows.length !== ids.length) {
        throw httpError(400, 'Unknown compartment in ids', 'unknown_compartment');
      }
      await client.query(
        `UPDATE compartments c SET sort_order = t.ord - 1, updated_at = NOW()
           FROM unnest($1::text[]) WITH ORDINALITY AS t(id, ord)
          WHERE c.id = t.id AND c.organization_id = $2`,
        [ids, organizationId]
      );
    });

    logAuditEvent({
      eventType: 'COMPARTMENT_REORDER',
      organizationId,
      severity: 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetType: 'compartment',
      message: `${ids.length} line(s) reordered`,
      metadata: { ids }
    });

    return CompartmentService.listCompartments(organizationId, accessTier);
  }

  /**
   * The fleet and the allow-peerings as AclEngine sees them, for a what-if.
   * Below the root tier devices in hidden compartments are left out: they are neither
   * reachable in the answer nor named in it.
   */
  static async loadReachInput(db, organizationId, accessTier) {
    const nodeRows = await db.query(
      `SELECT n.id, n.name, n.is_quarantined, ${EFFECTIVE_COMPARTMENT} AS compartment
         FROM nodes n
        WHERE COALESCE(n.organization_id, '${DEFAULT_ORG}') = $1
        ORDER BY n.id ASC`,
      [organizationId]
    );
    const comps = await db.query('SELECT id, is_hidden FROM compartments WHERE organization_id = $1', [organizationId]);
    const hidden = new Set(comps.rows.filter((c) => c.is_hidden).map((c) => c.id));
    const peerRows = await db.query(
      `SELECT src_compartment_id AS src, dst_compartment_id AS dst FROM compartment_peerings
        WHERE organization_id = $1 AND policy = 'allow'`,
      [organizationId]
    );
    const nodes = nodeRows.rows
      .filter((n) => accessTier === 'root' || !hidden.has(n.compartment))
      .map((n) => ({ id: n.id, name: n.name, compartment: n.compartment, quarantined: Boolean(n.is_quarantined) }));
    return { nodes, allowPeerings: peerRows.rows };
  }

  /**
   * What moving devices into a compartment would change, with nothing written.
   * Returns null when the target is not found (or hidden from the caller).
   */
  static async previewMove(organizationId, nodeIds, toId, accessTier = 'standard') {
    const ids = cleanNodeIds(nodeIds);
    const target =
      typeof toId === 'string' ? await CompartmentService.getCompartment(toId, organizationId, accessTier) : null;
    if (!target) return null;

    const input = await CompartmentService.loadReachInput(getPgPool(), organizationId, accessTier);
    const known = new Set(input.nodes.map((n) => n.id));
    const movable = ids.filter((id) => known.has(id));
    const preview = previewMove({ ...input, nodeIds: movable, toCompartment: target.id });
    return { ...preview, ignored: ids.length - movable.length };
  }

  /** The same for a split: the new line has no peerings, so its devices keep only each other. */
  static async previewSplit(id, organizationId, nodeIds, accessTier = 'standard') {
    const ids = cleanNodeIds(nodeIds);
    const source = await CompartmentService.getCompartment(id, organizationId, accessTier);
    if (!source) return null;

    const input = await CompartmentService.loadReachInput(getPgPool(), organizationId, accessTier);
    const inSource = new Set(input.nodes.filter((n) => n.compartment === id).map((n) => n.id));
    if (ids.some((n) => !inSource.has(n))) {
      throw httpError(400, 'Every device must currently be in this line', 'nodes_not_in_source');
    }
    const peerings = await CompartmentService.peeringsOf(getPgPool(), id, organizationId, accessTier);
    const preview = previewMove({ ...input, nodeIds: ids, toCompartment: '__new_line__' });
    return { ...preview, peerings_not_inherited: { count: peerings.count, peers: peerings.peers } };
  }

  /**
   * The peerings of a compartment: how many, and the names of the compartments on the
   * other side. Below the root tier a peering with a hidden compartment is neither
   * counted nor named.
   */
  static async peeringsOf(db, id, organizationId, accessTier) {
    const res = await db.query(
      `SELECT p.id, o.name AS peer_name, o.is_hidden
         FROM compartment_peerings p
         JOIN compartments o ON o.id = CASE WHEN p.src_compartment_id = $1 THEN p.dst_compartment_id ELSE p.src_compartment_id END
        WHERE p.organization_id = $2 AND (p.src_compartment_id = $1 OR p.dst_compartment_id = $1)`,
      [id, organizationId]
    );
    const visible = res.rows.filter((r) => accessTier === 'root' || !r.is_hidden);
    return {
      count: visible.length,
      peers: [...new Set(visible.map((r) => r.peer_name))].sort((a, b) => a.localeCompare(b)),
      ids: res.rows.map((r) => r.id)
    };
  }

  /**
   * Split devices off a line into a new one, in one transaction: create the line, move
   * the devices (each must be in the source now), one ACL epoch bump. The new line has
   * no peerings, so the result says how many the source has that it did not get. A split
   * of a hidden line stays hidden. Returns null when the source is not found.
   */
  static async splitCompartment(id, organizationId, { name, nodeIds, lineColour }, accessTier = 'standard', actor) {
    const cleanedName = cleanName(name);
    const ids = cleanNodeIds(nodeIds);
    const colour = lineColour === undefined || lineColour === null ? null : cleanColour(lineColour);

    const visible = await CompartmentService.getCompartment(id, organizationId, accessTier);
    if (!visible) return null;

    let result;
    try {
      result = await inTransaction(async (client) => {
        const locked = await client.query(
          'SELECT * FROM compartments WHERE id = $1 AND organization_id = $2 FOR UPDATE',
          [id, organizationId]
        );
        const source = locked.rows[0];
        if (!source) return null;
        if (await nameTaken(client, organizationId, cleanedName)) throw nameInUse();

        const inSource = await client.query(
          `SELECT n.id FROM nodes n
            WHERE n.id = ANY($1::text[]) AND COALESCE(n.organization_id, '${DEFAULT_ORG}') = $2
              AND ${EFFECTIVE_COMPARTMENT} = $3
            FOR UPDATE OF n`,
          [ids, organizationId, id]
        );
        if (inSource.rows.length !== ids.length) {
          throw httpError(400, 'Every device must currently be in this line', 'nodes_not_in_source');
        }

        const newId = `cmp-${uuidv4().substring(0, 8)}`;
        const created = await client.query(
          `INSERT INTO compartments (id, organization_id, name, slug, subnet_cidr, is_hidden, line_colour, sort_order, created_at, updated_at)
           VALUES ($1, $2::varchar, $3, $4, $5, $6, $7,
                   (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM compartments WHERE organization_id = $2::varchar), NOW(), NOW())
           RETURNING *`,
          [newId, organizationId, cleanedName, slugOf(cleanedName), source.subnet_cidr, source.is_hidden, colour]
        );
        const moved = await client.query(
          'UPDATE nodes SET compartment_id = $1 WHERE id = ANY($2::text[]) RETURNING id',
          [newId, ids]
        );
        const peerings = await CompartmentService.peeringsOf(client, id, organizationId, accessTier);
        await AclEngine.bumpEpoch('acl', client);
        return {
          compartment: created.rows[0],
          moved: moved.rows.map((r) => r.id).sort(),
          peerings_not_inherited: { count: peerings.count, peers: peerings.peers },
          hidden: Boolean(source.is_hidden)
        };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameInUse();
      throw err;
    }
    if (!result) return null;

    logAuditEvent({
      eventType: 'COMPARTMENT_SPLIT',
      organizationId,
      severity: result.hidden ? 'warn' : 'info',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: result.compartment.id,
      targetType: 'compartment',
      message: `${result.moved.length} node(s) split from compartment ${id} into ${result.compartment.id}`,
      metadata: { from: id, to: result.compartment.id, node_ids: result.moved, name: cleanedName }
    });

    const { hidden: _hidden, ...body } = result;
    return body;
  }

  /**
   * Merge a line into another, in one transaction: every device of `id` moves into
   * `intoId`, the peerings of `id` are dropped (they described the merged line, and the
   * answer counts and names them), `id` is deleted, one ACL epoch bump. The default line
   * cannot be merged away, and a hidden line merges only with another hidden one.
   * Returns null when either line is not found.
   */
  static async mergeCompartment(id, organizationId, intoId, accessTier = 'standard', actor) {
    if (typeof intoId !== 'string' || !intoId) throw httpError(400, 'into is required', 'into_required');
    if (intoId === id) throw httpError(400, 'A line cannot be merged into itself', 'same_line');

    const from = await CompartmentService.getCompartment(id, organizationId, accessTier);
    const into = await CompartmentService.getCompartment(intoId, organizationId, accessTier);
    if (!from || !into) return null;
    if (from.slug === 'default') {
      throw httpError(400, 'The default line cannot be merged into another', 'default_line');
    }
    if (Boolean(from.is_hidden) !== Boolean(into.is_hidden)) {
      throw httpError(400, 'A hidden line can only be merged with another hidden line', 'hidden_mismatch');
    }

    const result = await inTransaction(async (client) => {
      const locked = await client.query(
        'SELECT id FROM compartments WHERE id = ANY($1::text[]) AND organization_id = $2 ORDER BY id FOR UPDATE',
        [[id, intoId], organizationId]
      );
      if (locked.rows.length !== 2) return null;

      const peerings = await CompartmentService.peeringsOf(client, id, organizationId, accessTier);
      const moved = await client.query(
        `UPDATE nodes n SET compartment_id = $1
          WHERE COALESCE(n.organization_id, '${DEFAULT_ORG}') = $3 AND ${EFFECTIVE_COMPARTMENT} = $2
          RETURNING n.id`,
        [intoId, id, organizationId]
      );
      const dropped = await client.query(
        'DELETE FROM compartment_peerings WHERE organization_id = $1 AND (src_compartment_id = $2 OR dst_compartment_id = $2)',
        [organizationId, id]
      );
      await client.query('DELETE FROM compartments WHERE id = $1 AND organization_id = $2', [id, organizationId]);
      await AclEngine.bumpEpoch('acl', client);
      return {
        moved: moved.rows.map((r) => r.id).sort(),
        peerings,
        droppedTotal: dropped.rowCount
      };
    });
    if (!result) return null;

    logAuditEvent({
      eventType: 'COMPARTMENT_MERGE',
      organizationId,
      severity: 'warn',
      actorUserId: actor?.id,
      actorUsername: actor?.username,
      targetId: intoId,
      targetType: 'compartment',
      message: `Compartment ${id} merged into ${intoId} (${result.moved.length} node(s), ${result.droppedTotal} peering(s) dropped)`,
      metadata: { from: id, into: intoId, node_ids: result.moved, dropped_peerings: result.droppedTotal }
    });

    return {
      compartment: into,
      moved: result.moved,
      dropped_peerings: { count: result.peerings.count, peers: result.peerings.peers }
    };
  }
}

module.exports = CompartmentService;
