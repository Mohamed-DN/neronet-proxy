// control-plane-restart: restart the backend. No node row is lost, every node heartbeats
// again, and each keeps its identity and overlay address, whether it simply continued or
// enrolled again.
import { shapeFleet } from '../shape.mjs';
import { projectContainers } from '../lib/sim.mjs';
import { Result, engine, fleetIdentities, isShaped, runStandalone, waitFor } from '../lib/scenario.mjs';

export const name = 'control-plane-restart';

export async function run(ctx) {
  const r = new Result(name);
  const total = ctx.fleetNodes.length;

  const identities = await fleetIdentities(ctx);
  const beforeNodes = await ctx.api.nodes();
  const beforeById = new Map(beforeNodes.map((n) => [n.id, n]));
  const shaped = ctx.opts.reshape || (await isShaped(ctx));
  r.check(
    [...identities.values()].every((x) => x.nodeId && beforeById.has(x.nodeId)),
    `all ${total} nodes are registered before the restart`,
    `${beforeNodes.length} rows`
  );

  const backend = (await projectContainers(ctx.cfg.project)).get('backend');
  if (!r.check(Boolean(backend), 'the backend container exists')) return r.finish();

  const restartedAt = Date.now();
  await engine(['restart', '-t', '5', backend.id], { check: true });

  const up = await waitFor(() => ctx.api.health(), { timeoutS: 90, everyS: 2 });
  r.check(up.value, 'the backend answers /api/health again', `after ${up.seconds} s`);

  // The container got a new network namespace: apply the shaping again.
  if (shaped) await shapeFleet({ project: ctx.cfg.project, plan: ctx.opts.plan, log: () => {} });

  // A heartbeat stored after the restart, judged on the server's own clock.
  let silent = [];
  const beating = await waitFor(
    async () => {
      const nodes = new Map((await ctx.api.nodes()).map((n) => [n.id, n]));
      const restartOnServerClock = (ctx.api.serverTime ?? Date.now()) - (Date.now() - restartedAt);
      silent = ctx.fleetNodes.filter((e) => {
        const n = nodes.get(identities.get(e.id).nodeId);
        const beat = n?.last_heartbeat ? Date.parse(n.last_heartbeat) : NaN;
        return !(n && beat > restartOnServerClock);
      });
      return silent.length === 0;
    },
    { timeoutS: ctx.opts.timeout }
  );
  r.check(
    beating.value,
    'every node sent a heartbeat after the restart',
    `after ${beating.seconds} s${
      silent.length
        ? `, silent: ${silent
            .slice(0, 5)
            .map((e) => e.id)
            .join(', ')}`
        : ''
    }`
  );

  const afterNodes = await ctx.api.nodes();
  const afterById = new Map(afterNodes.map((n) => [n.id, n]));
  const lost = beforeNodes.filter((n) => !afterById.has(n.id));
  r.check(lost.length === 0, 'no node row was lost', `${beforeNodes.length} rows before, ${afterNodes.length} after`);
  r.check(afterNodes.length === beforeNodes.length, 'no node row was added', `${afterNodes.length} rows`);

  const moved = beforeNodes.filter((n) => {
    const a = afterById.get(n.id);
    return a && (a.overlay_ipv4 !== n.overlay_ipv4 || a.overlay_ipv6 !== n.overlay_ipv6);
  });
  r.check(
    moved.length === 0,
    'every node kept its overlay address',
    moved
      .map((n) => n.id)
      .slice(0, 5)
      .join(', ')
  );

  const after = await fleetIdentities(ctx);
  const changed = ctx.fleetNodes.filter((e) => after.get(e.id).nodeId !== identities.get(e.id).nodeId);
  r.check(changed.length === 0, 'no node changed its node id', changed.map((e) => e.id).join(', '));

  return r.finish();
}

await runStandalone(import.meta.url, run);
