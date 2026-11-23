'use strict';

/**
 * Connection order by scope (ADR 0037): storage, safety checks and the views the API and the
 * netmap use. The decision itself is the pure `resolve` in ConnectionOrderResolver, re-exported
 * here, so the netmap, the preview and the console show one answer.
 *
 * Writing a scope is refused (409) when it would leave a device with no method its gateway runs.
 * The same simulation answers the preview: which devices lose connectivity, and which must
 * import their profile again because the method of their profile left their order.
 */

const { getPgPool } = require('../db/index');
const AclEngine = require('./AclEngine');
const AccessMethodService = require('./AccessMethodService');
const ProfileGatewayService = require('./ProfileGatewayService');
const Resolver = require('./ConnectionOrderResolver');

const DEFAULT_ORG = 'org-default';
const orgKey = (org) => org || DEFAULT_ORG;
const WSS_PATH_PREFIX = /^[A-Za-z0-9_-]{16,128}$/;
const LIST_LIMIT = 200;

class ConnectionOrderError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** The WebSocket tunnel is installation-wide: on when its secret path prefix is configured. */
function wssConfigured() {
  return WSS_PATH_PREFIX.test(process.env.NERONET_WSS_PATH_PREFIX || '');
}

const listOrNull = (value) => (Array.isArray(value) && value.length > 0 ? value : null);

/**
 * Everything needed to resolve every device of one organisation, read once. Plain data, so a
 * change can be laid over it (`withChange`) and resolved again without touching the database.
 */
async function loadContext(organizationId, client = getPgPool()) {
  const org = orgKey(organizationId);
  const orgRes = await client.query(
    `SELECT id, allowed_access_methods, awg_params, vless_params, connection_order, connection_forced, members_choose_connection
       FROM organizations WHERE id = $1`,
    [org]
  );
  const orgRow = orgRes.rows[0];
  if (!orgRow) return null;
  const [lineRes, personRes, deviceRes, gatewayRows] = await Promise.all([
    client.query(
      `SELECT id, name, connection_order, connection_forced, connection_locked FROM compartments
        WHERE organization_id = $1`,
      [org]
    ),
    client.query(
      `SELECT user_id, connection_order, connection_forced FROM user_connection_orders WHERE organization_id = $1`,
      [org]
    ),
    client.query(
      `SELECT id, name, user_id, compartment_id, access_method, gateway_node_id, connection_order,
              connection_forced, connection_locked, connection_owner_set
         FROM nodes
        WHERE device_kind = 'profile' AND COALESCE(organization_id, '${DEFAULT_ORG}') = $1
        ORDER BY id`,
      [org]
    ),
    ProfileGatewayService.gateways(org, client)
  ]);
  const gatewayIds = new Set(gatewayRows.map((g) => g.id));
  const defaultGateway = gatewayRows[0] || null;
  return {
    organizationId: org,
    orgRow,
    wss: wssConfigured(),
    org: {
      allowed: AccessMethodService.allowedOf(orgRow),
      order: listOrNull(orgRow.connection_order),
      forced: Boolean(orgRow.connection_forced),
      membersMayChoose: Boolean(orgRow.members_choose_connection)
    },
    lines: new Map(
      lineRes.rows.map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          order: listOrNull(r.connection_order),
          forced: Boolean(r.connection_forced),
          locked: Boolean(r.connection_locked)
        }
      ])
    ),
    people: new Map(
      personRes.rows.map((r) => [
        r.user_id,
        { order: listOrNull(r.connection_order), forced: Boolean(r.connection_forced) }
      ])
    ),
    devices: deviceRes.rows,
    gateways: gatewayRows,
    gatewayOf: (gatewayNodeId) =>
      (gatewayNodeId && gatewayIds.has(gatewayNodeId) ? gatewayRows.find((g) => g.id === gatewayNodeId) : null) ||
      defaultGateway
  };
}

/** A device row's own setting in the shape `resolve` takes. */
function deviceSetting(row) {
  return {
    id: row.id,
    order: listOrNull(row.connection_order),
    forced: Boolean(row.connection_forced),
    locked: Boolean(row.connection_locked),
    ownerSet: Boolean(row.connection_owner_set)
  };
}

/** What the device's gateway can run now (null when it has no gateway: nothing to filter by). */
function availableFor(ctx, row) {
  const gateway = ctx.gatewayOf(row.gateway_node_id);
  return gateway ? AccessMethodService.usableMethods(ctx.orgRow, gateway, ctx.wss) : undefined;
}

/** The effective order of a device row against a context. */
function effectiveFor(ctx, row, { ignoreOwn = false } = {}) {
  const own = deviceSetting(row);
  return Resolver.resolve({
    organization: ctx.org,
    line: row.compartment_id ? ctx.lines.get(row.compartment_id) : undefined,
    device: ignoreOwn ? { id: row.id, order: null, locked: own.locked } : own,
    person: row.user_id ? ctx.people.get(row.user_id) : undefined,
    available: availableFor(ctx, row)
  });
}

/** A copy of the context with one scope's setting replaced. Nothing is written. */
function withChange(ctx, change) {
  const next = { ...ctx };
  const v = change.values;
  if (change.scope === 'organization') {
    next.org = {
      ...ctx.org,
      ...(v.order !== undefined ? { order: v.order } : {}),
      ...(v.forced !== undefined ? { forced: v.forced } : {}),
      ...(v.membersMayChoose !== undefined ? { membersMayChoose: v.membersMayChoose } : {})
    };
  } else if (change.scope === 'line') {
    next.lines = new Map(ctx.lines);
    next.lines.set(change.id, { ...ctx.lines.get(change.id), ...v });
  } else if (change.scope === 'device') {
    next.devices = ctx.devices.map((d) =>
      d.id === change.id
        ? {
            ...d,
            connection_order: v.order,
            connection_forced: v.forced,
            connection_locked: v.locked,
            connection_owner_set: v.ownerSet
          }
        : d
    );
  } else if (change.scope === 'person') {
    next.people = new Map(ctx.people);
    if (v.order === null) next.people.delete(change.id);
    else next.people.set(change.id, { order: v.order, forced: v.forced });
  }
  return next;
}

/**
 * Who a change would affect. `strands` lose every method their gateway runs (the change is
 * refused); `reimport` keep a path but the method their profile was made for left their order, so
 * the person must import a profile for another method.
 */
function plan(ctx, change) {
  return compare(ctx, withChange(ctx, change), []);
}

/**
 * Who a change would affect, `after` being the context with the change laid over it. `removed` are
 * methods the organisation stops allowing: a device whose effective order is forced to one of them
 * is stranded too (its single method is gone and the setting would silently fall back).
 */
function compare(ctx, after, removed) {
  const strands = [];
  const reimport = [];
  const changed = new Map(after.devices.map((d) => [d.id, d]));
  for (const row of ctx.devices) {
    const was = effectiveFor(ctx, row);
    const now = effectiveFor(after, changed.get(row.id));
    const forcedAway = was.forced && was.order.length === 1 && removed.includes(was.order[0]);
    if (was.usable && (!now.usable || forcedAway)) {
      strands.push({ id: row.id, name: row.name });
    } else if (now.usable && was.order.includes(row.access_method) && !now.order.includes(row.access_method)) {
      reimport.push({ id: row.id, name: row.name, access_method: row.access_method });
    }
  }
  return {
    strands: strands.slice(0, LIST_LIMIT),
    strands_total: strands.length,
    reimport: reimport.slice(0, LIST_LIMIT),
    reimport_total: reimport.length
  };
}

/**
 * The same plan for the organisation's access-method switches (ADR 0036 settings): what turning
 * port 443 or AmneziaWG off would do to the devices, lines and people that use it. Null when the
 * organisation is unknown or the body is not two booleans (the writer answers 400 itself).
 */
async function planAllowedChange(organizationId, body) {
  const input = body || {};
  if (typeof input.wireguard_wss !== 'boolean' || typeof input.amneziawg !== 'boolean') return null;
  const ctx = await loadContext(organizationId);
  if (!ctx) return null;
  if (input.vless !== undefined && typeof input.vless !== 'boolean') return null;
  const allowed = [Resolver.WIREGUARD];
  if (input.wireguard_wss) allowed.push(Resolver.WIREGUARD_WSS);
  if (input.amneziawg) allowed.push(Resolver.AMNEZIAWG);
  // `vless` is optional in the request: absent leaves the method as it is.
  if (input.vless === undefined ? ctx.org.allowed.includes(Resolver.VLESS) : input.vless) allowed.push(Resolver.VLESS);
  const removed = ctx.org.allowed.filter((m) => !allowed.includes(m));
  const after = {
    ...ctx,
    org: { ...ctx.org, allowed },
    orgRow: { ...ctx.orgRow, allowed_access_methods: allowed }
  };
  return compare(ctx, after, removed);
}

/** What a person may use at a scope: the methods the bound above allows. */
function boundFor(ctx, row) {
  const line = row && row.compartment_id ? ctx.lines.get(row.compartment_id) : undefined;
  return Resolver.resolve({ organization: ctx.org, line }).order;
}

// ---- Views -----------------------------------------------------------------------------

function effectiveView(r) {
  return { order: r.order, forced: r.forced, origin: r.origin, usable: r.usable, person_blocked: r.personBlocked };
}

function organizationView(ctx) {
  const eff = Resolver.resolve({ organization: ctx.org });
  return {
    organization_id: ctx.organizationId,
    allowed: ctx.org.allowed,
    own: { order: ctx.org.order, forced: ctx.org.forced },
    members_may_choose: ctx.org.membersMayChoose,
    default_order: Resolver.DEFAULT_ORDER.filter((m) => ctx.org.allowed.includes(m)),
    effective: effectiveView(eff)
  };
}

function lineView(ctx, lineId) {
  const line = ctx.lines.get(lineId);
  if (!line) return null;
  const inherited = Resolver.resolve({ organization: ctx.org });
  return {
    line_id: line.id,
    name: line.name,
    allowed: ctx.org.allowed,
    own: { order: line.order, forced: line.forced, locked: line.locked },
    inherited: effectiveView(inherited),
    effective: effectiveView(Resolver.resolve({ organization: ctx.org, line }))
  };
}

function deviceView(ctx, row) {
  const line = row.compartment_id ? ctx.lines.get(row.compartment_id) : null;
  const own = deviceSetting(row);
  const available = availableFor(ctx, row);
  return {
    device_id: row.id,
    name: row.name,
    access_method: row.access_method,
    line: line ? { id: line.id, name: line.name, locked: line.locked } : null,
    allowed: boundFor(ctx, row),
    available: available || null,
    own: { order: own.order, forced: own.forced, locked: own.locked },
    members_may_choose: ctx.org.membersMayChoose,
    inherited: effectiveView(effectiveFor(ctx, row, { ignoreOwn: true })),
    effective: effectiveView(effectiveFor(ctx, row))
  };
}

function personView(ctx, userId) {
  const own = ctx.people.get(userId) || null;
  const bound = Resolver.resolve({ organization: ctx.org }).order;
  return {
    members_may_choose: ctx.org.membersMayChoose,
    allowed: ctx.org.allowed,
    allowed_for_you: bound,
    own: own ? { order: own.order, forced: own.forced } : { order: null, forced: false },
    effective: effectiveView(
      Resolver.resolve({ organization: ctx.org, person: ctx.org.membersMayChoose ? own || undefined : undefined })
    )
  };
}

// ---- Validation of a request body ---------------------------------------------------------

function orderField(body, current, bound) {
  if (body.order === undefined)
    return { order: current.order, forced: body.forced === undefined ? current.forced : body.forced };
  const v = Resolver.validateOrder(body.order);
  if (!v.ok) throw new ConnectionOrderError(400, v.code, 'The order is not valid');
  const forced = body.forced === undefined ? (v.order === null ? false : current.forced) : body.forced;
  if (v.order !== null) {
    const outside = v.order.filter((m) => !bound.includes(m));
    if (outside.length > 0) {
      throw new ConnectionOrderError(400, 'method_not_allowed', 'A method is not allowed here', { methods: outside });
    }
  }
  return { order: v.order, forced };
}

function checkFlags(body, keys) {
  for (const key of keys) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      throw new ConnectionOrderError(400, 'invalid_flag', `${key} must be true or false`);
    }
  }
}

function finish(values) {
  if (values.forced && values.order === null) {
    throw new ConnectionOrderError(400, 'forced_needs_order', 'Forcing the first method needs an order');
  }
  return values;
}

// ---- Writes ----------------------------------------------------------------------------

async function commit(ctx, change, write) {
  const result = plan(ctx, change);
  if (result.strands_total > 0) {
    throw new ConnectionOrderError(409, 'would_strand_devices', 'Some devices would have no way to connect', {
      devices: result.strands,
      total: result.strands_total
    });
  }
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    await write(client);
    await AclEngine.bumpNetmap(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return result;
}

const own = (o) => ({ order: o.order, forced: o.forced });

/** Organisation: its own order, forced flag, and "members may choose". Owner or admin only (route). */
async function setOrganization(organizationId, body) {
  const ctx = await loadContext(organizationId);
  if (!ctx) return null;
  const input = body || {};
  checkFlags(input, ['forced', 'members_may_choose']);
  const before = { ...own(ctx.org), members_may_choose: ctx.org.membersMayChoose };
  const f = finish(orderField(input, ctx.org, ctx.org.allowed));
  const membersMayChoose = input.members_may_choose === undefined ? ctx.org.membersMayChoose : input.members_may_choose;
  const change = { scope: 'organization', values: { order: f.order, forced: f.forced, membersMayChoose } };
  const result = await commit(ctx, change, (client) =>
    client.query(
      `UPDATE organizations SET connection_order = $2::text[], connection_forced = $3, members_choose_connection = $4
        WHERE id = $1`,
      [ctx.organizationId, f.order, f.forced, membersMayChoose]
    )
  );
  const after = { order: f.order, forced: f.forced, members_may_choose: membersMayChoose };
  return { before, after, plan: result, view: organizationView(await loadContext(organizationId)) };
}

async function setLine(organizationId, lineId, body) {
  const ctx = await loadContext(organizationId);
  const line = ctx && ctx.lines.get(lineId);
  if (!line) return null;
  const input = body || {};
  checkFlags(input, ['forced', 'locked']);
  const before = { ...own(line), locked: line.locked };
  const f = finish(orderField(input, line, ctx.org.allowed));
  const locked = input.locked === undefined ? line.locked : input.locked;
  const change = { scope: 'line', id: lineId, values: { order: f.order, forced: f.forced, locked } };
  const result = await commit(ctx, change, (client) =>
    client.query(
      `UPDATE compartments SET connection_order = $2::text[], connection_forced = $3, connection_locked = $4,
              updated_at = NOW() WHERE id = $1`,
      [lineId, f.order, f.forced, locked]
    )
  );
  return {
    before,
    after: { order: f.order, forced: f.forced, locked },
    plan: result,
    view: lineView(await loadContext(organizationId), lineId)
  };
}

/**
 * Device. An administrator may set anything. The owner may set order and forced when the
 * organisation lets members choose and neither the line nor the device is locked; the owner never
 * sets `locked`.
 */
async function setDevice(organizationId, deviceId, body, actor) {
  const ctx = await loadContext(organizationId);
  const row = ctx && ctx.devices.find((d) => d.id === deviceId);
  if (!row) return null;
  const input = body || {};
  checkFlags(input, ['forced', 'locked']);
  const isAdmin = Boolean(actor && actor.isAdmin);
  if (!isAdmin) {
    if (!actor || row.user_id !== actor.id) throw new ConnectionOrderError(403, 'not_permitted', 'Not your device');
    const line = row.compartment_id ? ctx.lines.get(row.compartment_id) : null;
    if (!ctx.org.membersMayChoose) {
      throw new ConnectionOrderError(403, 'members_may_not_choose', 'Members may not choose here');
    }
    if (row.connection_locked || (line && line.locked)) {
      throw new ConnectionOrderError(403, 'locked', 'An administrator locked this setting');
    }
    if (input.locked !== undefined) throw new ConnectionOrderError(403, 'admin_only', 'Only an administrator locks');
  }
  const current = deviceSetting(row);
  const before = { order: current.order, forced: current.forced, locked: current.locked };
  const f = finish(orderField(input, current, boundFor(ctx, row)));
  const locked = isAdmin && input.locked !== undefined ? input.locked : current.locked;
  const ownerSet = !isAdmin && f.order !== null;
  const change = { scope: 'device', id: deviceId, values: { order: f.order, forced: f.forced, locked, ownerSet } };
  const result = await commit(ctx, change, (client) =>
    client.query(
      `UPDATE nodes SET connection_order = $2::text[], connection_forced = $3, connection_locked = $4,
              connection_owner_set = $5 WHERE id = $1`,
      [deviceId, f.order, f.forced, locked, ownerSet]
    )
  );
  const fresh = await loadContext(organizationId);
  return {
    before,
    after: { order: f.order, forced: f.forced, locked },
    plan: result,
    view: deviceView(
      fresh,
      fresh.devices.find((d) => d.id === deviceId)
    )
  };
}

/** Person: the caller's default for their own devices. Only while the organisation lets members choose. */
async function setPerson(organizationId, userId, body) {
  const ctx = await loadContext(organizationId);
  if (!ctx) return null;
  if (!ctx.org.membersMayChoose) {
    throw new ConnectionOrderError(403, 'members_may_not_choose', 'Members may not choose here');
  }
  const input = body || {};
  checkFlags(input, ['forced']);
  const current = ctx.people.get(userId) || { order: null, forced: false };
  const before = own(current);
  const f = finish(orderField(input, current, Resolver.resolve({ organization: ctx.org }).order));
  const change = { scope: 'person', id: userId, values: { order: f.order, forced: f.forced } };
  const result = await commit(ctx, change, (client) =>
    f.order === null
      ? client.query('DELETE FROM user_connection_orders WHERE user_id = $1 AND organization_id = $2', [
          userId,
          ctx.organizationId
        ])
      : client.query(
          `INSERT INTO user_connection_orders (user_id, organization_id, connection_order, connection_forced)
           VALUES ($1, $2, $3::text[], $4)
           ON CONFLICT (user_id, organization_id)
           DO UPDATE SET connection_order = EXCLUDED.connection_order,
                         connection_forced = EXCLUDED.connection_forced, updated_at = NOW()`,
          [userId, ctx.organizationId, f.order, f.forced]
        )
  );
  return { before, after: own(f), plan: result, view: personView(await loadContext(organizationId), userId) };
}

/** Who would lose connectivity if `scope` were set to `body`; writes nothing. */
async function preview(organizationId, scope, id, body, actor) {
  const ctx = await loadContext(organizationId);
  if (!ctx) return null;
  const input = body || {};
  let change;
  if (scope === 'organization') {
    checkFlags(input, ['forced', 'members_may_choose']);
    const f = finish(orderField(input, ctx.org, ctx.org.allowed));
    change = {
      scope,
      values: {
        order: f.order,
        forced: f.forced,
        membersMayChoose: input.members_may_choose === undefined ? ctx.org.membersMayChoose : input.members_may_choose
      }
    };
  } else if (scope === 'line') {
    const line = ctx.lines.get(id);
    if (!line) return null;
    checkFlags(input, ['forced', 'locked']);
    const f = finish(orderField(input, line, ctx.org.allowed));
    change = {
      scope,
      id,
      values: { order: f.order, forced: f.forced, locked: input.locked === undefined ? line.locked : input.locked }
    };
  } else if (scope === 'device') {
    const row = ctx.devices.find((d) => d.id === id);
    if (!row) return null;
    checkFlags(input, ['forced', 'locked']);
    const current = deviceSetting(row);
    const f = finish(orderField(input, current, boundFor(ctx, row)));
    change = {
      scope,
      id,
      values: {
        order: f.order,
        forced: f.forced,
        locked: input.locked === undefined ? current.locked : input.locked,
        ownerSet: !(actor && actor.isAdmin) && f.order !== null
      }
    };
  } else {
    return null;
  }
  return plan(ctx, change);
}

/**
 * For a device about to be added: the order the person's profile and alternative downloads follow.
 * `usable` is what the gateway that would serve it runs; the answer is that, in effective order.
 */
async function orderForNewDevice(organizationId, userId, usable) {
  const ctx = await loadContext(organizationId);
  if (!ctx) return { order: usable.slice(), origin: { scope: 'default' } };
  const r = Resolver.resolve({
    organization: ctx.org,
    person: userId ? ctx.people.get(userId) : undefined,
    available: usable
  });
  return { order: r.order.length > 0 ? r.order : usable.slice(), origin: r.origin };
}

/** The effective order and origin of a device row, small enough for a netmap entry. */
function netmapFields(ctx, row) {
  const r = effectiveFor(ctx, row);
  return { connection_order: r.order, connection_origin: r.origin };
}

module.exports = {
  ...Resolver,
  ConnectionOrderError,
  wssConfigured,
  loadContext,
  effectiveFor,
  plan,
  planAllowedChange,
  withChange,
  organizationView,
  lineView,
  deviceView,
  personView,
  getOrganization: async (id) => {
    const ctx = await loadContext(id);
    return ctx ? organizationView(ctx) : null;
  },
  getLine: async (organizationId, lineId) => {
    const ctx = await loadContext(organizationId);
    return ctx ? lineView(ctx, lineId) : null;
  },
  getDevice: async (organizationId, deviceId) => {
    const ctx = await loadContext(organizationId);
    const row = ctx && ctx.devices.find((d) => d.id === deviceId);
    return row ? { view: deviceView(ctx, row), ownerId: row.user_id, lineLocked: lineLockedOf(ctx, row) } : null;
  },
  getPerson: async (organizationId, userId) => {
    const ctx = await loadContext(organizationId);
    return ctx ? personView(ctx, userId) : null;
  },
  setOrganization,
  setLine,
  setDevice,
  setPerson,
  preview,
  orderForNewDevice,
  netmapFields
};

function lineLockedOf(ctx, row) {
  const line = row.compartment_id ? ctx.lines.get(row.compartment_id) : null;
  return Boolean(line && line.locked);
}
