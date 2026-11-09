#!/usr/bin/env node
// Usage: npm run budget            exit 1 when a limit is exceeded
//        npm run budget -- --print prints the measures and never fails
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, firstLoadGzip, check } from './bundle-budget-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const budget = JSON.parse(fs.readFileSync(path.join(root, 'bundle-budget.json'), 'utf8'));
const printOnly = process.argv.includes('--print');

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('dist/ is missing: run npm run build first');
  process.exit(2);
}

const m = measure(distDir);
const portal = firstLoadGzip(distDir, budget.portalManifestKey);
const fmt = (n) => (n == null ? 'not measured' : `${n.toLocaleString('en-US')} B`);

const rows = [
  ['entry gzip', m.entry.gzip, budget.limits.entryGzip],
  ['total JS gzip', m.totalGzip, budget.limits.totalJsGzip],
  [`largest chunk gzip (${m.largest.file})`, m.largest.gzip, budget.limits.maxChunkGzip],
  [`/me first load gzip (${budget.portalManifestKey})`, portal, budget.limits.portalFirstLoadGzip]
];
console.log('Measure'.padEnd(58), 'Actual'.padStart(14), 'Limit'.padStart(14));
for (const [label, actual, limit] of rows) {
  console.log(label.padEnd(58), fmt(actual).padStart(14), fmt(limit).padStart(14));
}
console.log(`entry raw ${m.entry.raw} B, total JS raw ${m.totalRaw} B`);

if (printOnly) process.exit(0);

const result = check(m, budget.limits, portal);
if (!result.ok) {
  for (const f of result.failures) console.error(`over budget: ${f}`);
  process.exit(1);
}
console.log('bundle budget ok');
