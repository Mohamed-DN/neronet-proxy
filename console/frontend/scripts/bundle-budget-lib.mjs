// Measures the production build in dist/ and checks it against bundle-budget.json.
// Gzip uses zlib's default level, per file, so the numbers match what a server sends.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const gzip = (buf) => zlib.gzipSync(buf).length;

function readGzip(distDir, rel) {
  const buf = fs.readFileSync(path.join(distDir, rel));
  return { raw: buf.length, gzip: gzip(buf) };
}

// The entry is the module script index.html loads from /assets/index-*.js.
function findEntry(distDir) {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const match = html.match(/<script[^>]*type="module"[^>]*src="\/assets\/(index-[^"]+\.js)"/);
  if (!match) throw new Error('index.html has no module script for /assets/index-*.js');
  return match[1];
}

export function measure(distDir) {
  const assetsDir = path.join(distDir, 'assets');
  const jsFiles = fs
    .readdirSync(assetsDir)
    .filter((f) => f.endsWith('.js'))
    .sort();
  const chunks = jsFiles.map((file) => ({ file, ...readGzip(distDir, path.join('assets', file)) }));
  const entryFile = findEntry(distDir);
  const entryChunk = chunks.find((c) => c.file === entryFile);
  if (!entryChunk) throw new Error(`entry ${entryFile} is not in dist/assets`);
  // The entry has its own limit, so "largest chunk" means the largest lazy chunk.
  const lazy = chunks.filter((c) => c.file !== entryFile);
  const largest = (lazy.length ? lazy : chunks).reduce((a, c) => (c.gzip > a.gzip ? c : a));
  return {
    entry: { file: entryFile, raw: entryChunk.raw, gzip: entryChunk.gzip },
    totalRaw: chunks.reduce((s, c) => s + c.raw, 0),
    totalGzip: chunks.reduce((s, c) => s + c.gzip, 0),
    largest: { file: largest.file, gzip: largest.gzip },
    chunks
  };
}

// Entry plus the chunk for manifestKey and its static (not dynamic) imports, transitively.
export function firstLoadGzip(distDir, manifestKey) {
  const manifestPath = path.join(distDir, '.vite', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest[manifestKey]) return null;
  const entryFile = findEntry(distDir);
  const files = new Set([`assets/${entryFile}`]);
  const visit = (key) => {
    const item = manifest[key];
    if (!item || files.has(item.file)) return;
    files.add(item.file);
    for (const dep of item.imports ?? []) visit(dep);
  };
  visit(manifestKey);
  let total = 0;
  for (const rel of files) total += readGzip(distDir, rel).gzip;
  return total;
}

// `limits` is the "limits" object of bundle-budget.json. `portal` is the first-load gzip of
// /me or null when it was not measured.
export function check(m, limits, portal) {
  const failures = [];
  if (m.entry.gzip > limits.entryGzip) {
    failures.push(`entry ${m.entry.file} ${m.entry.gzip} B gzip exceeds ${limits.entryGzip} B`);
  }
  if (m.totalGzip > limits.totalJsGzip) {
    failures.push(`total JS ${m.totalGzip} B gzip exceeds ${limits.totalJsGzip} B`);
  }
  if (m.largest.gzip > limits.maxChunkGzip) {
    failures.push(`largest chunk ${m.largest.file} ${m.largest.gzip} B gzip exceeds ${limits.maxChunkGzip} B`);
  }
  if (portal != null && portal > limits.portalFirstLoadGzip) {
    failures.push(`/me first load ${portal} B gzip exceeds ${limits.portalFirstLoadGzip} B`);
  }
  return { ok: failures.length === 0, failures };
}
