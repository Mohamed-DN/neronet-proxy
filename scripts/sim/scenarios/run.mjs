#!/usr/bin/env node
// Run the control plane scenarios against a running fleet, read-only ones first and the
// disruptive ones last.
//
//   node scripts/sim/scenarios/run.mjs --project wps1a [--only enrol-all,geo-consistency] [--timeout 180]
//
// Exit status 1 when any scenario fails.
import { createContext, parseScenarioArgs } from '../lib/scenario.mjs';
import * as churn from './churn.mjs';
import * as restart from './control-plane-restart.mjs';
import * as enrolAll from './enrol-all.mjs';
import * as geo from './geo-consistency.mjs';
import * as rtt from './heartbeat-rtt.mjs';

const ALL = [enrolAll, geo, rtt, churn, restart];

const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? argv.splice(onlyAt, 2)[1].split(',') : null;

try {
  const ctx = await createContext(parseScenarioArgs(argv));
  const results = [];
  for (const scenario of ALL) {
    if (only && !only.includes(scenario.name)) continue;
    results.push([scenario.name, await scenario.run(ctx)]);
  }
  console.log('\nsummary');
  for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
