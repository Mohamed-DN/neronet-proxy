#!/usr/bin/env node
// Measure the round trip between every pair of fleet entities and compare it with the plan.
//
//   node scripts/sim/measure.mjs --project wps1a [--plan file] [--count 20] [--matrix] [--json file]
//
// Each entity pings every entity after it in the plan from a sidecar in its own network
// namespace (ICMP, --count echo requests each, the median is used). A pair fails when
// the median differs from the planned round trip by more than the larger of 3 ms and
// 15% of the plan, or when fewer than half of the requests were answered. Exit status 1
// when any pair fails.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OUT_DIR,
  ensureToolsImage,
  isMain,
  loadPlan,
  mapLimit,
  pairIndex,
  resolveEntities,
  sidecar
} from './lib/sim.mjs';

export const TOLERANCE_MS = 3;
export const TOLERANCE_FRACTION = 0.15;

/** Allowed deviation for a planned round trip. */
export const allowedDeviation = (plannedMs) => Math.max(TOLERANCE_MS, TOLERANCE_FRACTION * plannedMs);

/** Shell run by the sidecar: one background ping per target, one result line each. */
export function pingScript(targets, count) {
  const lines = ['set +e'];
  for (const t of targets) {
    lines.push(
      `( ping -n -c ${count} -i 0.2 -W 4 ${t.ip} 2>/dev/null | sed -n 's/.*time=\\([0-9.]*\\) ms.*/\\1/p' | sort -n | ` +
        `awk -v id=${t.id} '{a[NR]=$1} END {if (NR==0) {print id, "nan", 0} else ` +
        `printf "%s %.3f %d\\n", id, (a[int((NR+1)/2)]+a[int(NR/2)+1])/2, NR}' ) &`
    );
  }
  lines.push('wait', '');
  return lines.join('\n');
}

/** Parse the lines the ping script prints into [{id, median_ms, received}]. */
export function parsePingOutput(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const [id, median, received] = line.trim().split(/\s+/);
    if (!id || received === undefined) continue;
    out.push({ id, median_ms: median === 'nan' ? null : Number(median), received: Number(received) });
  }
  return out;
}

/** Judge one pair. */
export function judge(plannedMs, measuredMs, received, sent) {
  if (measuredMs === null || received < sent / 2) {
    return { ok: false, reason: `only ${received} of ${sent} replies`, deviation_ms: null, deviation_pct: null };
  }
  const deviation = measuredMs - plannedMs;
  return {
    ok: Math.abs(deviation) <= allowedDeviation(plannedMs),
    reason: null,
    deviation_ms: deviation,
    deviation_pct: (deviation / plannedMs) * 100
  };
}

export async function measureFleet({ project, plan: planPath, count = 20, log = console.log }) {
  const plan = loadPlan(planPath);
  await ensureToolsImage();

  const { found, missing } = await resolveEntities(plan, project);
  if (missing.length > 0) log(`not running, not measured: ${missing.map((e) => e.id).join(', ')}`);

  const index = pairIndex(plan);
  const order = new Map(plan.entities.map((e, i) => [e.id, i]));
  const byId = new Map(found.map((f) => [f.entity.id, f]));

  const sources = await mapLimit(found, 8, async ({ entity, container }) => {
    const targets = found
      .filter((f) => order.get(f.entity.id) > order.get(entity.id))
      .map((f) => ({ id: f.entity.id, ip: f.ip }));
    if (targets.length === 0) return [];
    const r = await sidecar(container.id, pingScript(targets, count));
    return parsePingOutput(r.stdout).map((p) => ({ from: entity.id, to: p.id, ...p }));
  });

  const results = [];
  for (const row of sources.flat()) {
    const planned = index.get(`${row.from}|${row.to}`);
    const verdict = judge(planned.rtt_ms, row.median_ms, row.received, count);
    results.push({
      a: row.from,
      b: row.to,
      planned_rtt_ms: planned.rtt_ms,
      measured_rtt_ms: row.median_ms,
      received: row.received,
      sent: count,
      ...verdict
    });
  }

  const measured = results.filter((r) => r.deviation_ms !== null);
  const failed = results.filter((r) => !r.ok);
  const worstAbs = measured.reduce(
    (w, r) => (Math.abs(r.deviation_ms) > Math.abs(w?.deviation_ms ?? -1) ? r : w),
    null
  );
  const worstRel = measured.reduce(
    (w, r) => (Math.abs(r.deviation_pct) > Math.abs(w?.deviation_pct ?? -1) ? r : w),
    null
  );

  return { plan, entities: found.map((f) => f.entity), results, measured, failed, worstAbs, worstRel, byId };
}

function matrixText(entities, valueOf) {
  const width = 6;
  const short = (id) => id.replace(/^(client|exit)-/, '').slice(0, width);
  const head = ''.padEnd(9) + entities.map((e) => short(e.id).padStart(width + 1)).join('');
  const rows = entities.map((a) => {
    const cells = entities.map((b) => {
      if (a.id === b.id) return '.'.padStart(width + 1);
      const v = valueOf(a.id, b.id);
      return (v === null || v === undefined ? '-' : String(Math.round(v))).padStart(width + 1);
    });
    return short(a.id).padEnd(9) + cells.join('');
  });
  return [head, ...rows].join('\n');
}

function parseArgs(argv) {
  const opts = {
    project: process.env.COMPOSE_PROJECT_NAME,
    count: 20,
    matrix: false,
    json: resolve(OUT_DIR, 'measure.json')
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project':
        opts.project = argv[++i];
        break;
      case '--plan':
        opts.plan = argv[++i];
        break;
      case '--count':
        opts.count = Number(argv[++i]);
        break;
      case '--matrix':
        opts.matrix = true;
        break;
      case '--json':
        opts.json = argv[++i];
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!opts.project) throw new Error('give the compose project: measure.sh <project>');
  if (!(opts.count >= 4)) throw new Error('--count must be at least 4');
  return opts;
}

if (isMain(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const r = await measureFleet(opts);

    const lookup = new Map(r.results.map((x) => [`${x.a}|${x.b}`, x]));
    const pick = (field) => (a, b) => (lookup.get(`${a}|${b}`) ?? lookup.get(`${b}|${a}`))?.[field];

    if (opts.matrix) {
      console.log('\nMeasured round trip, ms (median):');
      console.log(matrixText(r.entities, pick('measured_rtt_ms')));
      console.log('\nPlanned round trip, ms:');
      console.log(matrixText(r.entities, pick('planned_rtt_ms')));
      console.log('');
    }

    const fmt = (x) =>
      x
        ? `${x.a} - ${x.b}: planned ${x.planned_rtt_ms} ms, measured ${x.measured_rtt_ms} ms (${x.deviation_ms >= 0 ? '+' : ''}${x.deviation_ms.toFixed(1)} ms, ${x.deviation_pct.toFixed(1)}%)`
        : 'none';
    console.log(
      `pairs measured: ${r.results.length}, within tolerance: ${r.results.length - r.failed.length}, outside: ${r.failed.length}`
    );
    console.log(`tolerance: max(${TOLERANCE_MS} ms, ${TOLERANCE_FRACTION * 100}% of the plan)`);
    console.log(`worst absolute deviation: ${fmt(r.worstAbs)}`);
    console.log(`worst relative deviation: ${fmt(r.worstRel)}`);

    for (const f of r.failed.slice(0, 20)) {
      console.log(
        `FAIL ${f.a} - ${f.b}: planned ${f.planned_rtt_ms} ms, measured ${f.measured_rtt_ms ?? 'none'} ms${f.reason ? ` (${f.reason})` : ''}`
      );
    }
    if (r.failed.length > 20) console.log(`... and ${r.failed.length - 20} more`);

    writeFileSync(
      opts.json,
      `${JSON.stringify({ tolerance_ms: TOLERANCE_MS, tolerance_fraction: TOLERANCE_FRACTION, count: opts.count, results: r.results }, null, 2)}\n`
    );
    console.log(`details: ${opts.json}`);

    if (r.results.length === 0) {
      console.log('FAIL nothing was measured');
      process.exit(1);
    }
    console.log(
      r.failed.length === 0
        ? 'PASS every measured pair is within tolerance of the plan'
        : 'FAIL some pairs deviate from the plan'
    );
    process.exit(r.failed.length === 0 ? 0 : 1);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
