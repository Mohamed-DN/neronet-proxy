// Shared helpers for the fleet tools: the container engine, the stack's containers and
// addresses, the sidecar that shares a container's network namespace, and the plan.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const SIM_DIR = resolve(LIB_DIR, '..');
export const REPO_ROOT = resolve(SIM_DIR, '..', '..');
export const OUT_DIR = resolve(SIM_DIR, 'out');
export const TOOLS_IMAGE = process.env.NERONET_SIMTOOLS_IMAGE || 'neronet-simtools:dev';

/** podman when installed, docker otherwise; NERONET_ENGINE overrides, as in scripts/dev/engine.sh. */
export function detectEngine() {
  if (process.env.NERONET_ENGINE) return process.env.NERONET_ENGINE;
  const probe = (name) => spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0;
  if (probe('podman')) return 'podman';
  if (probe('docker')) return 'docker';
  throw new Error('neither podman nor docker is installed');
}

let engineName;
/** Detected on first use, so importing this module needs no container engine. */
export const getEngine = () => (engineName ??= detectEngine());

/**
 * Run a command and collect its output. Resolves with {code, stdout, stderr}; rejects
 * only when the process cannot be started or, with `check`, exits non-zero.
 */
export function run(command, args, { input, check = false, cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { code, stdout, stderr };
      if (check && code !== 0) {
        reject(
          new Error(`${command} ${args.slice(0, 3).join(' ')} failed (${code}): ${stderr.trim() || stdout.trim()}`)
        );
      } else {
        resolvePromise(result);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export const engine = (args, options) => run(getEngine(), args, options);

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadPlan(path) {
  const file = resolve(path ?? resolve(OUT_DIR, 'fleet.plan.json'));
  if (!existsSync(file)) throw new Error(`no fleet plan at ${file}; run scripts/sim/fleet.mjs first`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Minimal .env reader: KEY=VALUE lines, optional quotes, # comments. Values are never printed. */
export function readEnvFile(path) {
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    values[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/**
 * The stack the scenarios talk to: project name, host ports and the credentials in
 * its own .env. Ports follow scripts/dev/stack.sh: an explicit variable wins over
 * the default plus NERONET_PORT_OFFSET.
 */
export function stackConfig({ project, envFile } = {}) {
  const name = project || process.env.COMPOSE_PROJECT_NAME;
  if (!name) throw new Error('set COMPOSE_PROJECT_NAME or pass --project');

  const offset = Number(process.env.NERONET_PORT_OFFSET || 0);
  const port = (variable, base) => Number(process.env[variable] || base + offset);

  const file = resolve(envFile || process.env.NERONET_ENV_FILE || resolve(REPO_ROOT, '.env'));
  const env = existsSync(file) ? readEnvFile(file) : {};

  return {
    project: name,
    apiPort: port('NERONET_API_PORT', 8081),
    consolePort: port('NERONET_CONSOLE_PORT', 8443),
    envFile: file,
    adminUser: process.env.SOVEREIGN_ADMIN_USER || env.SOVEREIGN_ADMIN_USER || 'admin',
    adminPass: env.SOVEREIGN_ADMIN_PASS || process.env.SOVEREIGN_ADMIN_PASS,
    registrationToken: env.SOVEREIGN_REGISTRATION_TOKEN || process.env.SOVEREIGN_REGISTRATION_TOKEN
  };
}

/**
 * Containers of a compose project keyed by compose service name.
 * Each has {id, name, service, state}.
 */
export async function projectContainers(project) {
  const r = await engine(
    ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', 'json', '--no-trunc'],
    { check: true }
  );
  const text = r.stdout.trim();
  if (!text) return new Map();

  // podman prints one JSON array, docker one object per line.
  const rows = text.startsWith('[') ? JSON.parse(text) : text.split('\n').map((l) => JSON.parse(l));

  const map = new Map();
  for (const row of rows) {
    const labels = parseLabels(row.Labels);
    const service = labels['com.docker.compose.service'];
    if (!service) continue;
    const name = Array.isArray(row.Names) ? row.Names[0] : String(row.Names).split(',')[0];
    map.set(service, { id: row.ID ?? row.Id, name, service, state: String(row.State ?? '').toLowerCase() });
  }
  return map;
}

function parseLabels(labels) {
  if (!labels) return {};
  if (typeof labels === 'object') return labels;
  const out = {};
  for (const pair of String(labels).split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/** IPv4 address of each container id on its first network. */
export async function containerIps(ids) {
  if (ids.length === 0) return new Map();
  const r = await engine(
    ['inspect', '--format', '{{.Id}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', ...ids],
    { check: true }
  );
  const ips = new Map();
  for (const line of r.stdout.split('\n')) {
    const [id, ip] = line.trim().split(/\s+/);
    if (id && ip) ips.set(id, ip);
  }
  return ips;
}

/**
 * Resolve every entity of the plan to a running container and its address.
 * Entities without a running container are returned in `missing`.
 */
export async function resolveEntities(plan, project) {
  const containers = await projectContainers(project);
  const running = plan.entities
    .map((e) => ({ entity: e, container: containers.get(e.service) }))
    .filter((x) => x.container && x.container.state === 'running');
  const ips = await containerIps(running.map((x) => x.container.id));

  const found = [];
  const missing = [];
  for (const e of plan.entities) {
    const hit = running.find((x) => x.entity.id === e.id);
    const ip = hit && ips.get(hit.container.id);
    if (hit && ip) found.push({ entity: e, container: hit.container, ip });
    else missing.push(e);
  }
  return { found, missing };
}

/** Build the tools image on demand. */
export async function ensureToolsImage() {
  const have = await engine(['image', 'inspect', TOOLS_IMAGE]);
  if (have.code === 0) return;
  await engine(['build', '-t', TOOLS_IMAGE, '-f', resolve(SIM_DIR, 'Containerfile.simtools'), SIM_DIR], {
    check: true
  });
}

/**
 * Run a shell script in a throw-away container that shares the network namespace of
 * `target` (a container id or name). The target keeps running untouched: it is the
 * sidecar that holds NET_ADMIN and the tools, which the node image does not have.
 */
export function sidecar(target, script, { extraArgs = [] } = {}) {
  return engine(
    [
      'run',
      '--rm',
      '-i',
      '--cap-add',
      'NET_ADMIN',
      '--network',
      `container:${target}`,
      ...extraArgs,
      TOOLS_IMAGE,
      'sh',
      '-s'
    ],
    { input: script }
  );
}

/** Planned pair values keyed by both orders of the entity ids. */
export function pairIndex(plan) {
  const index = new Map();
  for (const p of plan.pairs) {
    index.set(`${p.a}|${p.b}`, p);
    index.set(`${p.b}|${p.a}`, p);
  }
  return index;
}

/** True when the module at `metaUrl` is the script node was started with. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}
