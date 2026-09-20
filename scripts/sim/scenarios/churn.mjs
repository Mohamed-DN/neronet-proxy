// churn: stop and restart 20% of the nodes. They keep their identity and overlay address,
// none appears twice, and the console counts go down while they are away and return to N.
import { prng } from '../fleet.mjs';
import { shapeFleet } from '../shape.mjs';
import { Result, engine, fleetIdentities, isShaped, runStandalone, waitFor } from '../lib/scenario.mjs';

export const name = 'churn';

const FRACTION = 0.2;
const FRESH_MS = 45_000;

export async function run(ctx) {
  const r = new Result(name);
  const total = ctx.fleetNodes.length;

  const before = await fleetIdentities(ctx);
  const beforeNodes = new Map((await ctx.api.nodes()).map((n) => [n.id, n]));
  const baseline = await ctx.api.overview();
  r.check(
    [...before.values()].every((x) => x.nodeId && beforeNodes.has(x.nodeId)),
    `all ${total} nodes are registered before the churn`,
    `console: ${baseline.active_nodes} active of ${baseline.total_nodes}`
  );

  // Deterministic for a plan: the same seed picks the same nodes.
  const random = prng(ctx.plan.seed + 20);
  const count = Math.max(1, Math.round(total * FRACTION));
  const victims = ctx.fleetNodes
    .map((e) => ({ e, k: random() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, count)
    .map((x) => x.e);
  r.info(`stopping ${count} nodes: ${victims.map((e) => e.id).join(', ')}`);

  const shaped = ctx.opts.reshape || (await isShaped(ctx));

  await Promise.all(victims.map((e) => engine(['stop', '-t', '2', before.get(e.id).container.id], { check: true })));

  // The liveness window is what tells the console a node is gone; wait for it to notice.
  const window = baseline.liveness_window_seconds ?? 60;
  const dropped = await waitFor(async () => (await ctx.api.overview()).active_nodes <= baseline.active_nodes - count, {
    timeoutS: window + 45
  });
  const during = await ctx.api.overview();
  r.check(
    dropped.value,
    `the console notices the ${count} missing nodes`,
    `active ${baseline.active_nodes} -> ${during.active_nodes} after ${dropped.seconds} s`
  );

  await Promise.all(victims.map((e) => engine(['start', before.get(e.id).container.id], { check: true })));

  // A restarted container has a new network namespace, so the shaping has to be applied again.
  if (shaped) await shapeFleet({ project: ctx.cfg.project, plan: ctx.opts.plan, log: () => {} });

  let silent = [];
  const back = await waitFor(
    async () => {
      const nodes = new Map((await ctx.api.nodes()).map((n) => [n.id, n]));
      const now = ctx.api.serverTime ?? Date.now();
      silent = victims.filter((e) => {
        const n = nodes.get(before.get(e.id).nodeId);
        const beat = n?.last_heartbeat ? Date.parse(n.last_heartbeat) : NaN;
        return !(n && now - beat <= FRESH_MS);
      });
      return silent.length === 0;
    },
    { timeoutS: ctx.opts.timeout }
  );
  r.check(
    back.value,
    `all ${count} restarted nodes heartbeat again`,
    `after ${back.seconds} s${silent.length ? `, still silent: ${silent.map((e) => e.id).join(', ')}` : ''}`
  );

  const afterIdentities = await fleetIdentities(ctx);
  const changedIdentity = victims.filter((e) => afterIdentities.get(e.id).nodeId !== before.get(e.id).nodeId);
  r.check(
    changedIdentity.length === 0,
    'restarted nodes kept their node id',
    changedIdentity.map((e) => e.id).join(', ')
  );

  const afterNodes = await ctx.api.nodes();
  const afterById = new Map(afterNodes.map((n) => [n.id, n]));
  const moved = victims.filter((e) => {
    const id = before.get(e.id).nodeId;
    const a = afterById.get(id);
    const b = beforeNodes.get(id);
    return a?.overlay_ipv4 !== b?.overlay_ipv4 || a?.overlay_ipv6 !== b?.overlay_ipv6;
  });
  r.check(moved.length === 0, 'restarted nodes kept their overlay addresses', moved.map((e) => e.id).join(', '));

  r.check(
    afterNodes.length === beforeNodes.size,
    'no node row was added or lost',
    `${beforeNodes.size} before, ${afterNodes.length} after`
  );
  const v4 = afterNodes.map((n) => n.overlay_ipv4);
  r.check(
    new Set(v4).size === v4.length,
    'no overlay address is held twice',
    `${new Set(v4).size} distinct in ${v4.length} rows`
  );

  const restored = await waitFor(
    async () => {
      const o = await ctx.api.overview();
      return o.total_nodes === baseline.total_nodes && o.active_nodes >= baseline.active_nodes;
    },
    { timeoutS: 60 }
  );
  const final = await ctx.api.overview();
  r.check(
    restored.value,
    `the console counts return to the baseline of ${baseline.active_nodes} active of ${baseline.total_nodes}`,
    `now ${final.active_nodes} active of ${final.total_nodes}`
  );

  return r.finish();
}

await runStandalone(import.meta.url, run);
