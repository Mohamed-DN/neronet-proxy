#!/usr/bin/env node
// Apply the latency plan to the running fleet, or remove it.
//
//   node scripts/sim/shape.mjs --project wps1a [--plan scripts/sim/out/fleet.plan.json] [--reset]
//
// Each node, DERP relay and the control plane's front end gets a qdisc on its own
// interface, installed from a throw-away sidecar that shares its network namespace.
// Nothing is added to the node image. Running it again replaces the previous
// configuration; --reset removes it.
import { ensureToolsImage, isMain, loadPlan, mapLimit, pairIndex, resolveEntities, sidecar } from './lib/sim.mjs';
import { resetScript, shapeScript } from './lib/tc.mjs';

function parseArgs(argv) {
  const opts = { project: process.env.COMPOSE_PROJECT_NAME, plan: undefined, reset: false, allowMissing: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project':
        opts.project = argv[++i];
        break;
      case '--plan':
        opts.plan = argv[++i];
        break;
      case '--reset':
        opts.reset = true;
        break;
      case '--allow-missing':
        opts.allowMissing = true;
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!opts.project) throw new Error('give the compose project: shape.sh <project>');
  return opts;
}

export async function shapeFleet({ project, plan: planPath, reset = false, allowMissing = false, log = console.log }) {
  const plan = loadPlan(planPath);
  await ensureToolsImage();

  const { found, missing } = await resolveEntities(plan, project);
  const missingNodes = missing.filter((e) => e.kind === 'node' || e.kind === 'control');
  if (missing.length > 0) {
    log(`not running: ${missing.map((e) => e.id).join(', ')}`);
  }
  if (missingNodes.length > 0 && !allowMissing) {
    throw new Error(`${missingNodes.length} node or control plane containers are not running; start the fleet first`);
  }

  const index = pairIndex(plan);
  const failures = [];

  await mapLimit(found, 6, async ({ entity, container }) => {
    const peers = found.filter((f) => f.entity.id !== entity.id).map((f) => ({ id: f.entity.id, ip: f.ip }));
    const script = reset ? resetScript() : shapeScript(peers, (peerId) => index.get(`${entity.id}|${peerId}`));
    const r = await sidecar(container.id, script);
    if (r.code !== 0) failures.push(`${entity.id}: ${r.stderr.trim() || r.stdout.trim()}`);
  });

  if (failures.length > 0) throw new Error(`shaping failed on ${failures.length} containers:\n${failures.join('\n')}`);
  log(`${reset ? 'removed shaping from' : 'shaped'} ${found.length} containers`);
  return { shaped: found.length, missing: missing.map((e) => e.id) };
}

if (isMain(import.meta.url)) {
  try {
    await shapeFleet(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
