// What every scenario needs: the stack's API with a logged-in admin, the fleet plan,
// the mapping from plan entities to the node ids the control plane assigned, and a
// small result collector that prints PASS or FAIL with the evidence.
import {
  OUT_DIR,
  engine,
  isMain,
  loadPlan,
  mapLimit,
  projectContainers,
  resolveEntities,
  sidecar,
  sleep,
  stackConfig
} from './sim.mjs';

/** Collects checks and prints them as they happen. */
export class Result {
  constructor(name) {
    this.name = name;
    this.failures = 0;
    this.checks = 0;
    console.log(`\nscenario ${name}`);
  }

  check(ok, message, evidence) {
    this.checks++;
    if (!ok) this.failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}${evidence ? `  [${evidence}]` : ''}`);
    return ok;
  }

  info(message) {
    console.log(`      ${message}`);
  }

  get ok() {
    return this.failures === 0 && this.checks > 0;
  }

  finish() {
    console.log(
      `RESULT ${this.ok ? 'PASS' : 'FAIL'} ${this.name} (${this.checks - this.failures} of ${this.checks} checks)`
    );
    return this.ok;
  }
}

/** The stack's API, logged in as the admin from the stack's own .env. */
export class Api {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = `http://127.0.0.1:${cfg.apiPort}`;
    this.token = null;
    this.serverTime = null;
  }

  async login() {
    if (!this.cfg.adminPass) {
      throw new Error(`no SOVEREIGN_ADMIN_PASS in ${this.cfg.envFile}; generate one with scripts/dev/gen-env.sh`);
    }
    const res = await fetch(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.cfg.adminUser, password: this.cfg.adminPass })
    });
    if (!res.ok) throw new Error(`admin login answered ${res.status}`);
    this.token = (await res.json()).token;
    if (!this.token) throw new Error('the login response carried no token');
  }

  /** GET with one re-login when the token was refused. */
  async get(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.token) await this.login();
      const res = await fetch(`${this.base}${path}`, { headers: { authorization: `Bearer ${this.token}` } });
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      const date = res.headers.get('date');
      if (date) this.serverTime = Date.parse(date);
      if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
      return res.json();
    }
    throw new Error(`GET ${path} was refused after a new login`);
  }

  async health() {
    try {
      const res = await fetch(`${this.base}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Every node the API lists, all pages. */
  async nodes() {
    const all = [];
    for (let offset = 0; ; ) {
      const page = await this.get(`/api/nodes?limit=500&offset=${offset}`);
      all.push(...page.nodes);
      offset += page.nodes.length;
      if (page.nodes.length === 0 || offset >= (page.total ?? all.length)) break;
    }
    return all;
  }

  overview() {
    return this.get('/api/stats/overview');
  }

  /** Nodes with the measured round trip, null where there is none (the node list shows a constant). */
  async topologyLatency() {
    const topo = await this.get('/api/stats/topology');
    return new Map(topo.nodes.map((n) => [n.id, n.latency_ms]));
  }
}

export async function createContext(opts) {
  const cfg = stackConfig({ project: opts.project, envFile: opts.envFile });
  const plan = loadPlan(opts.plan);
  const api = new Api(cfg);
  await api.login();
  return { cfg, plan, api, opts, fleetNodes: plan.entities.filter((e) => e.kind === 'node') };
}

/**
 * Node id of every fleet node, read from the node's own log ("Node ID: pk_...").
 * The id derives from the node's key, so it survives restarts.
 */
export async function fleetIdentities(ctx) {
  const containers = await projectContainers(ctx.cfg.project);
  const rows = await mapLimit(ctx.fleetNodes, 8, async (entity) => {
    const container = containers.get(entity.service);
    if (!container) return { entity, nodeId: null, container: null };
    const r = await engine(['logs', container.id]);
    const ids = [...`${r.stdout}\n${r.stderr}`.matchAll(/Node ID: (pk_[0-9a-f]+)/g)];
    return { entity, container, nodeId: ids.length ? ids[ids.length - 1][1] : null };
  });
  return new Map(rows.map((row) => [row.entity.id, row]));
}

/** Poll `fn` until it returns a truthy value or the time is up; returns the last value. */
export async function waitFor(fn, { timeoutS, everyS = 5 }) {
  const started = Date.now();
  let value = await fn();
  while (!value && (Date.now() - started) / 1000 < timeoutS) {
    await sleep(everyS * 1000);
    value = await fn();
  }
  return { value, seconds: Math.round((Date.now() - started) / 1000) };
}

/** True when the control plane's container carries the fleet's htb tree. */
export async function isShaped(ctx) {
  const { found } = await resolveEntities(ctx.plan, ctx.cfg.project);
  const control = found.find((f) => f.entity.kind === 'control');
  if (!control) return false;
  const r = await sidecar(
    control.container.id,
    'tc qdisc show dev "$(ip -o -4 route show default | awk \'{print $5}\' | head -n 1)"'
  );
  return r.stdout.includes('htb');
}

export const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

export function parseScenarioArgs(argv) {
  const opts = { project: process.env.COMPOSE_PROJECT_NAME, timeout: 180 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project':
        opts.project = argv[++i];
        break;
      case '--plan':
        opts.plan = argv[++i];
        break;
      case '--env-file':
        opts.envFile = argv[++i];
        break;
      case '--timeout':
        opts.timeout = Number(argv[++i]);
        break;
      case '--reshape':
        opts.reshape = true;
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!opts.project) throw new Error('give the compose project: --project <name>');
  return opts;
}

/** Entry point shared by the scenario files: run one scenario when the file is started directly. */
export async function runStandalone(metaUrl, scenario) {
  if (!isMain(metaUrl)) return;
  try {
    const ctx = await createContext(parseScenarioArgs(process.argv.slice(2)));
    const ok = await scenario(ctx);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

export { OUT_DIR, engine, sleep };
