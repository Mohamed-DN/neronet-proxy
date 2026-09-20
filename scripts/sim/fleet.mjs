#!/usr/bin/env node
// Fleet generator.
//
//   node scripts/sim/fleet.mjs --nodes 24 --seed 1 [--exit-ratio 0.25] [--home fra]
//                              [--derp fra,iad,sin,gru,syd,jnb] [--out scripts/sim/out]
//
// Writes, into the output directory:
//   docker-compose.fleet.yml   an override adding the node and DERP services under the "fleet" profile
//   fleet.plan.json            every entity, and the delay, jitter, loss and round trip of every pair
//
// Same arguments, same files: the plan holds no timestamp and no random value.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { link, modelFromCatalogue } from './latency.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// The fleet enrols against the backend directly, not through the console's nginx. The
// /v4 location in console/frontend/nginx.conf forwards no X-Forwarded-For, so behind it
// every node shares one source address and one budget of the 60-requests-a-minute
// limiter on /v4/control: about 15 nodes heartbeating every 15 s saturate it. Direct,
// each node is metered under its own container address, as separate devices would be.
export const CONTROL_URL = 'http://backend:8081';

export const DEFAULT_DERP_REGIONS = ['fra', 'iad', 'sin', 'gru', 'syd', 'jnb'];

/** Small deterministic generator (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pick `count` locations from the candidates, always taking one of the least used
 * so far, so a small fleet is spread over as many places as possible and a large one
 * over all of them evenly. Ties are broken by a seeded shuffle.
 */
function pickSpread(candidates, count, used, random) {
  const order = shuffled(candidates, random);
  const picked = [];
  for (let i = 0; i < count; i++) {
    let best = order[0];
    for (const c of order) {
      if ((used.get(c.id) ?? 0) < (used.get(best.id) ?? 0)) best = c;
    }
    used.set(best.id, (used.get(best.id) ?? 0) + 1);
    picked.push(best);
  }
  return picked;
}

const round = (value, places) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

/**
 * Build the plan: the entities and the modelled path between every pair.
 * Pure function of its arguments.
 */
export function buildPlan({
  catalogue,
  nodes,
  seed,
  exitRatio = 0.25,
  home = 'fra',
  derpRegions = DEFAULT_DERP_REGIONS
}) {
  if (!Number.isInteger(nodes) || nodes < 1) throw new Error('--nodes must be a positive integer');
  if (!Number.isInteger(seed)) throw new Error('--seed must be an integer');
  if (!(exitRatio >= 0 && exitRatio <= 1)) throw new Error('--exit-ratio must be between 0 and 1');

  const byId = new Map(catalogue.locations.map((l) => [l.id, l]));
  for (const id of [home, ...derpRegions]) {
    if (!byId.has(id)) throw new Error(`unknown location ${id}`);
  }

  const model = modelFromCatalogue(catalogue);
  const random = prng(seed);

  const exitCount = nodes === 1 ? 0 : Math.max(1, Math.round(nodes * exitRatio));
  const datacentres = catalogue.locations.filter((l) => l.ip_class === 'DATACENTER');
  const used = new Map();
  const exitLocations = pickSpread(datacentres, exitCount, used, random);
  const clientLocations = pickSpread(catalogue.locations, nodes - exitCount, used, random);

  const counters = new Map();
  const nextName = (prefix, loc) => {
    const key = `${prefix}-${loc.id}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return `${key}-${n}`;
  };

  const entity = (id, kind, role, loc, service) => ({
    id,
    kind,
    role,
    service,
    location: loc.id,
    city: loc.city,
    country: loc.country,
    lat: loc.lat,
    lon: loc.lon,
    ip_class: loc.ip_class,
    profile: loc.profile,
    access: { ...catalogue.profiles[loc.profile] }
  });

  const entities = [];
  entities.push(entity('control', 'control', 'control', byId.get(home), 'backend'));

  for (const loc of derpRegions.map((id) => byId.get(id))) {
    const name = `derp-${loc.id}`;
    entities.push(entity(name, 'derp', 'derp', loc, `fleet-${name}`));
  }

  const fleetNodes = [
    ...exitLocations.map((loc) => ({ loc, role: 'exit' })),
    ...clientLocations.map((loc) => ({ loc, role: 'client' }))
  ];
  for (const { loc, role } of fleetNodes) {
    const name = nextName(role, loc);
    entities.push(entity(name, 'node', role, loc, `fleet-${name}`));
  }

  const pairs = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      const l = link(a, b, model);
      const oneWay = round(l.one_way_ms, 1);
      pairs.push({
        a: a.id,
        b: b.id,
        distance_km: Math.round(l.distance_km),
        one_way_ms: oneWay,
        jitter_ms: round(l.jitter_ms, 1),
        loss_pct: round(l.loss_pct, 3),
        rtt_ms: round(2 * oneWay, 1)
      });
    }
  }

  return {
    schema: 1,
    seed,
    nodes,
    exit_ratio: exitRatio,
    home,
    derp_regions: derpRegions,
    model: {
      fibre_speed_km_s: model.fibre_speed_km_s,
      route_factor: model.route_factor,
      path_jitter_fraction: model.path_jitter_fraction
    },
    entities,
    pairs
  };
}

const q = (value) => JSON.stringify(value);

/** The compose override for a plan. Entities of kind control are not part of it. */
export function renderCompose(plan, argv = '') {
  const lines = [
    `# Generated by scripts/sim/fleet.mjs ${argv}`.trimEnd(),
    '# Adds the simulated fleet under the "fleet" profile. Do not edit; run the generator again.',
    'services:'
  ];
  const volumes = [];

  for (const e of plan.entities) {
    if (e.kind === 'control') continue;

    const command =
      e.kind === 'derp'
        ? ['-listen-addr', '0.0.0.0:8444', '-stun-addr', '0.0.0.0:3478', '-region', e.location]
        : [
            '-control-url',
            CONTROL_URL,
            '-country',
            e.country,
            '-city',
            e.city,
            '-lat',
            String(e.lat),
            '-lon',
            String(e.lon),
            ...(e.role === 'exit' ? ['-enable-exit=true'] : [])
          ];

    lines.push(`  ${e.service}:`);
    lines.push('    image: ${NERONET_NODE_IMAGE:-neronet-node:dev}');
    lines.push('    build:');
    lines.push('      context: .');
    lines.push('      dockerfile: docker/Dockerfile.node');
    lines.push('    restart: unless-stopped');
    lines.push('    profiles: ["fleet"]');
    lines.push('    networks:');
    lines.push('      - neronet-isolated-mesh');
    if (e.kind === 'derp') {
      lines.push('    entrypoint: ["/bin/sovereign-derp-relay"]');
    } else {
      lines.push('    environment:');
      lines.push(
        '      - SOVEREIGN_REGISTRATION_TOKEN=${SOVEREIGN_REGISTRATION_TOKEN:?set SOVEREIGN_REGISTRATION_TOKEN in .env}'
      );
      lines.push('    depends_on:');
      lines.push('      backend:');
      lines.push('        condition: service_healthy');
      lines.push('    volumes:');
      lines.push(`      - identity-${e.service}:/var/lib/neronet`);
      volumes.push(`identity-${e.service}`);
    }
    lines.push(`    command: [${command.map(q).join(', ')}]`);
    lines.push('    labels:');
    lines.push('      neronet.sim: "fleet"');
    lines.push(`      neronet.sim.entity: ${q(e.id)}`);
    lines.push(`      neronet.sim.location: ${q(e.location)}`);
  }

  lines.push('', 'volumes:');
  for (const v of volumes) lines.push(`  ${v}:`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const opts = { nodes: 24, seed: 1, exitRatio: 0.25, home: 'fra', derp: DEFAULT_DERP_REGIONS.join(','), out: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    switch (flag) {
      case '--nodes':
        opts.nodes = Number(value());
        break;
      case '--seed':
        opts.seed = Number(value());
        break;
      case '--exit-ratio':
        opts.exitRatio = Number(value());
        break;
      case '--home':
        opts.home = value();
        break;
      case '--derp':
        opts.derp = value();
        break;
      case '--out':
        opts.out = value();
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  return opts;
}

const USAGE = `Usage: node scripts/sim/fleet.mjs --nodes N --seed S [--exit-ratio 0.25] [--home fra]
                                   [--derp fra,iad,sin,gru,syd,jnb] [--out scripts/sim/out]`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const catalogue = JSON.parse(readFileSync(resolve(HERE, 'regions.json'), 'utf8'));
  const plan = buildPlan({
    catalogue,
    nodes: opts.nodes,
    seed: opts.seed,
    exitRatio: opts.exitRatio,
    home: opts.home,
    derpRegions: opts.derp ? opts.derp.split(',').filter(Boolean) : []
  });

  const outDir = resolve(opts.out ?? resolve(HERE, 'out'));
  mkdirSync(outDir, { recursive: true });

  const argv = `--nodes ${opts.nodes} --seed ${opts.seed} --exit-ratio ${opts.exitRatio} --home ${opts.home}`;
  writeFileSync(resolve(outDir, 'docker-compose.fleet.yml'), renderCompose(plan, argv));
  writeFileSync(resolve(outDir, 'fleet.plan.json'), `${JSON.stringify(plan, null, 2)}\n`);

  const nodes = plan.entities.filter((e) => e.kind === 'node');
  const cities = new Set(nodes.map((e) => e.location));
  const exits = nodes.filter((e) => e.role === 'exit').length;
  console.log(`${nodes.length} nodes (${exits} exit, ${nodes.length - exits} client) in ${cities.size} locations,`);
  console.log(
    `${plan.derp_regions.length} DERP relays, control plane at ${plan.home}, ${plan.pairs.length} modelled pairs`
  );
  console.log(`wrote ${resolve(outDir, 'docker-compose.fleet.yml')}`);
  console.log(`wrote ${resolve(outDir, 'fleet.plan.json')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error(USAGE);
    process.exit(2);
  }
}
