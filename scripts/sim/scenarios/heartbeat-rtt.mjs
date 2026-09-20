// heartbeat-rtt: the round trip the control plane stores for each node is the shaped round
// trip between that node and the control plane's home region.
//
// A node times one heartbeat request from before the connection is opened to the end of the
// response and sends the result with the next heartbeat. The backend closes idle connections
// after 5 s (Node's default keep-alive timeout) and heartbeats are 15 s apart, so every
// heartbeat opens a new connection and the timed span is the TCP handshake plus the request:
// two shaped round trips, not one, plus the backend's handling. The scenario therefore
// expects a multiple k of the shaped round trip, decides from the fleet whether k is 1 or 2,
// and prints it. k = 2 is a finding about the node's measurement, not about the shaping,
// which measure.sh checks separately with ICMP.
//
// The value is read from /api/stats/topology, which reports null for a node that has not
// measured one; the node list substitutes a constant for null.
import { Result, fleetIdentities, isShaped, median, runStandalone, sleep } from '../lib/scenario.mjs';

export const name = 'heartbeat-rtt';

// The stored value adds the request handling (Express, the heartbeat buffer) and is a whole
// number of milliseconds rounded up, so it sits slightly above the shaped round trip.
const TOLERANCE_MS = 8;
const TOLERANCE_FRACTION = 0.15;
const ROUNDS = 5;
const ROUND_SECONDS = 16;

export async function run(ctx) {
  const r = new Result(name);

  const shaped = await isShaped(ctx);
  if (
    !r.check(
      shaped,
      'the fleet is shaped (an htb tree is installed on the control plane)',
      shaped ? '' : 'run scripts/sim/shape.sh first'
    )
  ) {
    return r.finish();
  }

  const identities = await fleetIdentities(ctx);
  const planned = new Map(
    ctx.plan.pairs
      .filter((p) => p.a === 'control' || p.b === 'control')
      .map((p) => [p.a === 'control' ? p.b : p.a, p.rtt_ms])
  );

  // One reading per heartbeat interval: the stored value changes once per beat.
  const samples = new Map(ctx.fleetNodes.map((e) => [e.id, []]));
  for (let round = 0; round < ROUNDS; round++) {
    if (round > 0) await sleep(ROUND_SECONDS * 1000);
    const latency = await ctx.api.topologyLatency();
    for (const e of ctx.fleetNodes) {
      const value = latency.get(identities.get(e.id)?.nodeId);
      if (typeof value === 'number') samples.get(e.id).push(value);
    }
  }

  const readings = ctx.fleetNodes.map((e) => ({
    entity: e,
    stored: median(samples.get(e.id)),
    path: planned.get(e.id)
  }));

  // Round trips per timed heartbeat: the one that fits the fleet, 1 (connection reused) or 2.
  const ratios = readings.filter((x) => x.stored !== null && x.path >= 50).map((x) => x.stored / x.path);
  const k = median(ratios) !== null && median(ratios) > 1.5 ? 2 : 1;
  r.info(
    `the stored values are about ${k} x the shaped round trip (median ratio ${median(ratios)?.toFixed(2)} over nodes 50 ms or more away)`
  );

  const rows = readings.map((x) => {
    const plan = x.path * k;
    return { entity: x.entity, stored: x.stored, plan, deviation: x.stored === null ? null : x.stored - plan };
  });

  const unmeasured = rows.filter((x) => x.stored === null);
  r.check(unmeasured.length === 0, 'every node has a stored round trip', unmeasured.map((x) => x.entity.id).join(', '));

  const measured = rows.filter((x) => x.stored !== null);
  const outside = measured.filter((x) => Math.abs(x.deviation) > Math.max(TOLERANCE_MS, TOLERANCE_FRACTION * x.plan));
  r.check(
    outside.length === 0,
    `${measured.length - outside.length} of ${measured.length} stored round trips are within max(${TOLERANCE_MS} ms, ${TOLERANCE_FRACTION * 100}%) of ${k} x the shaped round trip to ${ctx.plan.home}`,
    `median of ${ROUNDS} readings each`
  );

  const worst = measured.reduce((w, x) => (Math.abs(x.deviation) > Math.abs(w?.deviation ?? -1) ? x : w), null);
  if (worst)
    r.info(`worst: ${worst.entity.id} (${worst.entity.city}) expected ${worst.plan} ms, stored ${worst.stored} ms`);
  for (const x of outside.slice(0, 10)) {
    r.info(
      `outside: ${x.entity.id} (${x.entity.city}) expected ${x.plan} ms, stored ${x.stored} ms (${x.deviation >= 0 ? '+' : ''}${x.deviation.toFixed(1)})`
    );
  }

  // The point of the exercise: the console can tell a near node from a far one.
  const sorted = [...measured].sort((a, b) => a.plan - b.plan);
  if (sorted.length >= 4) {
    const quarter = Math.floor(sorted.length / 4);
    const nearMax = Math.max(...sorted.slice(0, quarter).map((x) => x.stored));
    const farMin = Math.min(...sorted.slice(-quarter).map((x) => x.stored));
    r.check(
      nearMax < farMin,
      'the stored values put the nearest quarter of the fleet below the farthest quarter',
      `nearest quarter up to ${nearMax} ms, farthest from ${farMin} ms`
    );
  }

  return r.finish();
}

await runStandalone(import.meta.url, run);
