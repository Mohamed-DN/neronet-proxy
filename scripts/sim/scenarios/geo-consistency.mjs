// geo-consistency: what the API returns for every node is what the plan declared for it.
import { Result, fleetIdentities, runStandalone } from '../lib/scenario.mjs';

export const name = 'geo-consistency';

// Degrees. The coordinate columns are single precision on PostgreSQL.
const COORDINATE_TOLERANCE = 0.001;

const ROLE_OF = { exit: 'EXIT_BRIDGE', client: 'CLIENT_ORIGIN' };

export async function run(ctx) {
  const r = new Result(name);
  const identities = await fleetIdentities(ctx);
  const list = new Map((await ctx.api.nodes()).map((n) => [n.id, n]));

  const wrong = [];
  let compared = 0;
  for (const entity of ctx.fleetNodes) {
    const nodeId = identities.get(entity.id)?.nodeId;
    // The detail endpoint is what the console's node page reads; the list is what the
    // map reads. Both are compared with the plan.
    const detail = nodeId ? (await ctx.api.get(`/api/nodes/${nodeId}`)).node : null;

    for (const [source, node] of [
      ['list', list.get(nodeId)],
      ['detail', detail]
    ]) {
      if (!node) {
        wrong.push(`${entity.id}: missing from the ${source}`);
        continue;
      }
      compared++;
      const problems = [];
      if (node.country_code !== entity.country) problems.push(`country ${node.country_code} != ${entity.country}`);
      if (node.city !== entity.city)
        problems.push(`city ${JSON.stringify(node.city)} != ${JSON.stringify(entity.city)}`);
      if (!(Math.abs(node.latitude - entity.lat) <= COORDINATE_TOLERANCE))
        problems.push(`latitude ${node.latitude} != ${entity.lat}`);
      if (!(Math.abs(node.longitude - entity.lon) <= COORDINATE_TOLERANCE))
        problems.push(`longitude ${node.longitude} != ${entity.lon}`);
      if (node.location_source !== 'declared')
        problems.push(`location_source ${JSON.stringify(node.location_source)} != "declared"`);
      if (node.role !== ROLE_OF[entity.role]) problems.push(`role ${node.role} != ${ROLE_OF[entity.role]}`);
      if (problems.length) wrong.push(`${entity.id} (${source}): ${problems.join('; ')}`);
    }
  }

  r.check(
    wrong.length === 0,
    `country, city, coordinates, location_source and role of ${ctx.fleetNodes.length} nodes match the plan in the list and in the detail`,
    `${compared} comparisons`
  );
  for (const line of wrong.slice(0, 10)) r.info(line);

  // The per-country totals the console draws its map from must agree with the plan too.
  const overview = await ctx.api.overview();
  const expected = new Map();
  for (const entity of ctx.fleetNodes) expected.set(entity.country, (expected.get(entity.country) ?? 0) + 1);
  const short = [...expected].filter(([country, n]) => (overview.country_distribution?.[country] ?? 0) < n);
  r.check(
    short.length === 0,
    'the country distribution in the overview counts at least the planned nodes of every country',
    `${expected.size} countries${short.length ? `, short: ${short.map(([c, n]) => `${c}=${overview.country_distribution?.[c] ?? 0}/${n}`).join(' ')}` : ''}`
  );

  return r.finish();
}

await runStandalone(import.meta.url, run);
