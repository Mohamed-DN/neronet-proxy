import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { measure, firstLoadGzip, check } from './bundle-budget-lib.mjs';

const gz = (buf) => zlib.gzipSync(buf).length;

function makeDist(files, indexHtml, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (indexHtml !== undefined) fs.writeFileSync(path.join(dir, 'index.html'), indexHtml);
  if (manifest !== undefined) {
    fs.mkdirSync(path.join(dir, '.vite'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vite', 'manifest.json'), JSON.stringify(manifest));
  }
  return dir;
}

const INDEX_HTML =
  '<!doctype html><html><head><script type="module" src="/assets/index-abc.js"></script></head><body></body></html>';

test('measure finds the entry from index.html and sums every .js gzip', () => {
  const a = 'console.log("entry code".repeat(40));'.repeat(3);
  const b = 'export const chunk = "lazy route";'.repeat(50);
  const dir = makeDist(
    { 'assets/index-abc.js': a, 'assets/OverviewRoute-x.js': b, 'assets/style.css': 'body{}' },
    INDEX_HTML
  );
  const m = measure(dir);
  assert.equal(m.entry.file, 'index-abc.js');
  assert.equal(m.entry.raw, Buffer.byteLength(a));
  assert.equal(m.entry.gzip, gz(Buffer.from(a)));
  assert.equal(m.totalGzip, gz(Buffer.from(a)) + gz(Buffer.from(b)));
  assert.equal(m.totalRaw, Buffer.byteLength(a) + Buffer.byteLength(b));
  assert.equal(m.chunks.length, 2);
});

test('largest chunk excludes the entry, which has its own limit', () => {
  const big = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${(i * 7919) % 1000};`).join('\n');
  const small = 'export const s = 1;';
  const dir = makeDist({ 'assets/index-abc.js': big, 'assets/Lazy-x.js': small }, INDEX_HTML);
  const m = measure(dir);
  assert.equal(m.entry.file, 'index-abc.js');
  assert.equal(m.largest.file, 'Lazy-x.js');
  assert.equal(m.largest.gzip, gz(Buffer.from(small)));
});

test('check fails when entry gzip exceeds its limit', () => {
  const m = {
    entry: { file: 'index-abc.js', raw: 100, gzip: 60 },
    totalGzip: 60,
    totalRaw: 100,
    largest: { file: 'index-abc.js', gzip: 60 },
    chunks: [{ file: 'index-abc.js', raw: 100, gzip: 60 }]
  };
  const r = check(m, { entryGzip: 59, totalJsGzip: 1000, maxChunkGzip: 1000, portalFirstLoadGzip: 1000 }, null);
  assert.equal(r.ok, false);
  assert.ok(
    r.failures.some((f) => f.startsWith('entry')),
    r.failures.join(' | ')
  );
});

test('check passes at exactly the limit', () => {
  const m = {
    entry: { file: 'index-abc.js', raw: 100, gzip: 60 },
    totalGzip: 100,
    totalRaw: 150,
    largest: { file: 'x.js', gzip: 40 },
    chunks: []
  };
  const r = check(m, { entryGzip: 60, totalJsGzip: 100, maxChunkGzip: 40, portalFirstLoadGzip: 70 }, 70);
  assert.equal(r.ok, true, r.failures.join(' | '));
  assert.deepEqual(r.failures, []);
});

test('firstLoadGzip follows static imports transitively and returns null when the key is absent', () => {
  const entry = 'console.log("entry");'.repeat(20);
  const route = 'export const me = "portal route";'.repeat(30);
  const dep = 'export const dep = "shared store";'.repeat(30);
  const deep = 'export const deep = "shared util";'.repeat(30);
  const dynamic = 'export const other = "dynamic only";'.repeat(60);
  const manifest = {
    'index.html': { file: 'assets/index-abc.js', src: 'index.html', isEntry: true, imports: ['_dep-1.js'] },
    'src/portal/MeRoute.tsx': {
      file: 'assets/MeRoute-1.js',
      src: 'src/portal/MeRoute.tsx',
      isDynamicEntry: true,
      imports: ['_dep-1.js'],
      dynamicImports: ['src/other.tsx']
    },
    '_dep-1.js': { file: 'assets/dep-1.js', imports: ['_deep-1.js'] },
    '_deep-1.js': { file: 'assets/deep-1.js' },
    'src/other.tsx': { file: 'assets/other-1.js' }
  };
  const dir = makeDist(
    {
      'assets/index-abc.js': entry,
      'assets/MeRoute-1.js': route,
      'assets/dep-1.js': dep,
      'assets/deep-1.js': deep,
      'assets/other-1.js': dynamic
    },
    INDEX_HTML,
    manifest
  );
  const expected = gz(Buffer.from(entry)) + gz(Buffer.from(route)) + gz(Buffer.from(dep)) + gz(Buffer.from(deep));
  assert.equal(firstLoadGzip(dir, 'src/portal/MeRoute.tsx'), expected);
  assert.equal(firstLoadGzip(dir, 'src/does/not/exist.tsx'), null);
});
