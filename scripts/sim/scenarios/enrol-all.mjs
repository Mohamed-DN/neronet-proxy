// enrol-all: every node of the plan is registered, holds its own overlay address and
// has a fresh heartbeat within the time bound.
import { Result, fleetIdentities, runStandalone, waitFor } from '../lib/scenario.mjs';

export const name = 'enrol-all';

const OVERLAY_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/;
const FRESH_MS = 60_000;

export async function run(ctx) {
  const r = new Result(name);
  const total = ctx.fleetNodes.length;

  const identities = await fleetIdentities(ctx);
  const known = [...identities.values()].filter((x) => x.nodeId);
  r.check(known.length === total, `${known.length} of ${total} nodes report an identity in their log`);
  const ids = known.map((x) => x.nodeId);
  r.check(new Set(ids).size === ids.length, 'every node has a distinct node id', `${new Set(ids).size} distinct`);

  let byId = new Map();
  const registered = await waitFor(
    async () => {
      byId = new Map((await ctx.api.nodes()).map((n) => [n.id, n]));
      return ids.every((id) => byId.has(id));
    },
    { timeoutS: ctx.opts.timeout }
  );
  const present = ids.filter((id) => byId.has(id)).length;
  r.check(
    registered.value,
    `${present} of ${total} nodes are registered in the control plane`,
    `after ${registered.seconds} s`
  );

  const fleet = ids.map((id) => byId.get(id)).filter(Boolean);
  const v4 = new Set(fleet.map((n) => n.overlay_ipv4));
  const v6 = new Set(fleet.map((n) => n.overlay_ipv6));
  r.check(
    v4.size === fleet.length && v6.size === fleet.length,
    'every node holds its own overlay address',
    `${v4.size} IPv4, ${v6.size} IPv6 for ${fleet.length} nodes`
  );
  const outside = fleet.filter((n) => !OVERLAY_V4.test(n.overlay_ipv4 ?? ''));
  r.check(
    outside.length === 0,
    'every overlay IPv4 address is inside 100.64.0.0/10',
    outside.map((n) => n.id).join(', ')
  );

  let stale = [];
  const healthy = await waitFor(
    async () => {
      const nodes = new Map((await ctx.api.nodes()).map((n) => [n.id, n]));
      const now = ctx.api.serverTime ?? Date.now();
      stale = ids.filter((id) => {
        const n = nodes.get(id);
        const beat = n?.last_heartbeat ? Date.parse(n.last_heartbeat) : NaN;
        return !(n && n.is_healthy && n.status === 'active' && now - beat <= FRESH_MS);
      });
      return stale.length === 0;
    },
    { timeoutS: ctx.opts.timeout }
  );
  r.check(
    healthy.value,
    `${total - stale.length} of ${total} nodes are healthy with a heartbeat under ${FRESH_MS / 1000} s old`,
    `after ${healthy.seconds} s${stale.length ? `, not yet: ${stale.slice(0, 5).join(', ')}` : ''}`
  );

  return r.finish();
}

await runStandalone(import.meta.url, run);
