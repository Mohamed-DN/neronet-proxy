#!/usr/bin/env node
/*
 * Contrast gate for the console design tokens.
 *
 * Reads console/frontend/src/styles/tokens.css, which is the single source of
 * truth for colour, and checks every declared foreground/background pair in
 * both themes against its WCAG 2.1 target: 4.5:1 for text, 3:1 for non-text
 * user interface boundaries and for chart series.
 *
 * Usage:
 *   node scripts/design/contrast.mjs            report and gate
 *   node scripts/design/contrast.mjs --write    also rewrite docs/design/tokens.md
 *
 * Exit status is 1 when any pair with a target is below it, so CI and the
 * pre-merge check fail on a token change that breaks accessibility.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { contrastRatio, deltaE, asSeen, hex, VISION } from './color.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const TOKENS_CSS = join(repoRoot, 'console', 'frontend', 'src', 'styles', 'tokens.css');
const TOKENS_DOC = join(repoRoot, 'docs', 'design', 'tokens.md');

const THEMES = [
  { id: 'light', label: 'Light', selector: ':root' },
  { id: 'dark', label: 'Dark', selector: "[data-theme='dark']" }
];

/*
 * Pairs are declared once and checked in both themes, because a role means the
 * same thing in both. `target` null marks a pair that carries no information on
 * its own (a separator between two areas that are already distinguishable): it
 * is printed for review but cannot fail the run.
 */
const TEXT = 4.5;
const UI = 3;

const PAIRS = [
  { fg: 'content', bg: 'surface', target: TEXT, use: 'Body text on the page' },
  { fg: 'content', bg: 'surface-raised', target: TEXT, use: 'Body text on a card' },
  { fg: 'content', bg: 'surface-sunken', target: TEXT, use: 'Text in an input or well' },
  { fg: 'content-muted', bg: 'surface', target: TEXT, use: 'Secondary text on the page' },
  { fg: 'content-muted', bg: 'surface-raised', target: TEXT, use: 'Secondary text on a card' },
  { fg: 'content-subtle', bg: 'surface', target: TEXT, use: 'Hints and placeholders on the page' },
  { fg: 'content-subtle', bg: 'surface-raised', target: TEXT, use: 'Hints and placeholders on a card' },
  { fg: 'content-subtle', bg: 'surface-sunken', target: TEXT, use: 'Placeholder inside an input' },
  { fg: 'content-inverse', bg: 'surface-inverse', target: TEXT, use: 'Text on an inverted surface' },

  { fg: 'accent', bg: 'surface', target: TEXT, use: 'Link and accent text on the page' },
  { fg: 'accent', bg: 'surface-raised', target: TEXT, use: 'Link and accent text on a card' },
  { fg: 'accent', bg: 'accent-subtle', target: TEXT, use: 'Accent text on its own tint' },
  { fg: 'accent-contrast', bg: 'accent', target: TEXT, use: 'Label on a primary button' },
  { fg: 'accent-contrast', bg: 'accent-strong', target: TEXT, use: 'Label on a hovered primary button' },

  { fg: 'success', bg: 'surface-raised', target: TEXT, use: 'Healthy status text' },
  { fg: 'success', bg: 'success-subtle', target: TEXT, use: 'Healthy status badge' },
  { fg: 'success-contrast', bg: 'success', target: TEXT, use: 'Label on a solid healthy fill' },
  { fg: 'warning', bg: 'surface-raised', target: TEXT, use: 'Degraded status text' },
  { fg: 'warning', bg: 'warning-subtle', target: TEXT, use: 'Degraded status badge' },
  { fg: 'warning-contrast', bg: 'warning', target: TEXT, use: 'Label on a solid degraded fill' },
  { fg: 'danger', bg: 'surface-raised', target: TEXT, use: 'Critical status text' },
  { fg: 'danger', bg: 'danger-subtle', target: TEXT, use: 'Critical status badge' },
  { fg: 'danger-contrast', bg: 'danger', target: TEXT, use: 'Label on a destructive button' },
  { fg: 'info', bg: 'surface-raised', target: TEXT, use: 'Informational status text' },
  { fg: 'info', bg: 'info-subtle', target: TEXT, use: 'Informational status badge' },
  { fg: 'info-contrast', bg: 'info', target: TEXT, use: 'Label on a solid informational fill' },

  { fg: 'border-strong', bg: 'surface', target: UI, use: 'Control outline on the page' },
  { fg: 'border-strong', bg: 'surface-raised', target: UI, use: 'Control outline on a card' },
  { fg: 'border-strong', bg: 'surface-sunken', target: UI, use: 'Control outline on a well' },
  { fg: 'focus', bg: 'surface', target: UI, use: 'Focus ring on the page' },
  { fg: 'focus', bg: 'surface-raised', target: UI, use: 'Focus ring on a card' },
  { fg: 'focus', bg: 'surface-sunken', target: UI, use: 'Focus ring on a well' },
  { fg: 'accent', bg: 'surface-sunken', target: UI, use: 'Selected control fill on a well' },

  { fg: 'chart-1', bg: 'surface-raised', target: UI, use: 'Chart series 1' },
  { fg: 'chart-2', bg: 'surface-raised', target: UI, use: 'Chart series 2' },
  { fg: 'chart-3', bg: 'surface-raised', target: UI, use: 'Chart series 3' },
  { fg: 'chart-4', bg: 'surface-raised', target: UI, use: 'Chart series 4' },
  { fg: 'chart-5', bg: 'surface-raised', target: UI, use: 'Chart series 5' },
  { fg: 'chart-6', bg: 'surface-raised', target: UI, use: 'Chart series 6' },
  { fg: 'chart-7', bg: 'surface-raised', target: UI, use: 'Chart series 7' },
  { fg: 'chart-8', bg: 'surface-raised', target: UI, use: 'Chart series 8' },

  { fg: 'border', bg: 'surface', target: null, use: 'Separator, carries no information' },
  { fg: 'border', bg: 'surface-raised', target: null, use: 'Card outline, carries no information' },
  { fg: 'border-subtle', bg: 'surface-raised', target: null, use: 'Row separator inside a card' },
  { fg: 'surface-hover', bg: 'surface-raised', target: null, use: 'Hover tint on a row' }
];

/*
 * Chart series must also be distinguishable from one another, not only from the
 * plot background, and must stay distinguishable for a dichromat. Every
 * unordered pair of the eight series is compared in CIE L*a*b* under normal
 * vision and under simulated protanopia, deuteranopia and tritanopia.
 *
 * A CIE76 distance of 12 is a design threshold, not a standard: below it two
 * swatches the size of a chart legend key read as two shades of one colour.
 *
 * Tritanopia is measured and printed but does not gate. It collapses the
 * blue-yellow axis, and no eight-colour categorical palette that also holds
 * 3:1 against the plot surface survives it - the reference Okabe-Ito palette
 * scores 1.0 there. The product answer is not a better palette: charts label
 * their series directly and never carry meaning in colour alone.
 */
const SERIES_MIN_DELTA_E = 12;
const SERIES_GATED_VISION = new Set(['normal', 'protanopia', 'deuteranopia']);

function parseThemeBlock(css, selector) {
  /* Anchored at the start of a line and followed by the opening brace, so that
   * a mention of the selector in a comment cannot be taken for the rule. */
  const rule = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm');
  const match = rule.exec(css);
  if (!match) throw new Error(`no block for ${selector} in tokens.css`);
  const open = match.index + match[0].length - 1;
  const close = css.indexOf('}', open);
  if (close === -1) throw new Error(`malformed block for ${selector}`);
  const body = css.slice(open + 1, close);
  const tokens = new Map();
  for (const line of body.split('\n')) {
    const m = line.match(/--color-([a-z0-9-]+)\s*:\s*(\d+)\s+(\d+)\s+(\d+)\s*;/i);
    if (m) tokens.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  return tokens;
}

function evaluate(tokens) {
  const rows = [];
  for (const pair of PAIRS) {
    const fg = tokens.get(pair.fg);
    const bg = tokens.get(pair.bg);
    if (!fg) throw new Error(`token --color-${pair.fg} is not defined`);
    if (!bg) throw new Error(`token --color-${pair.bg} is not defined`);
    const ratio = contrastRatio(fg, bg);
    rows.push({
      ...pair,
      fgHex: hex(fg),
      bgHex: hex(bg),
      ratio,
      pass: pair.target === null ? null : ratio >= pair.target
    });
  }
  return rows;
}

function evaluateSeries(tokens) {
  const rows = [];
  for (const vision of VISION) {
    let worst = null;
    for (let i = 1; i <= 8; i += 1) {
      for (let j = i + 1; j <= 8; j += 1) {
        const a = asSeen(tokens.get(`chart-${i}`), vision);
        const b = asSeen(tokens.get(`chart-${j}`), vision);
        const distance = deltaE(a, b);
        if (worst === null || distance < worst.distance) {
          worst = { distance, a: `chart-${i}`, b: `chart-${j}` };
        }
      }
    }
    const gated = SERIES_GATED_VISION.has(vision);
    rows.push({
      vision,
      ...worst,
      target: gated ? SERIES_MIN_DELTA_E : null,
      pass: gated ? worst.distance >= SERIES_MIN_DELTA_E : null
    });
  }
  return rows;
}

function formatRatio(ratio) {
  return `${ratio.toFixed(2)}:1`;
}

function verdict(row) {
  if (row.pass === null) return 'n/a';
  return row.pass ? 'pass' : 'FAIL';
}

function printSeries(label, rows) {
  console.log(`\n${label}`);
  console.log(`  ${'vision'.padEnd(14)}  ${'closest pair'.padEnd(18)}  ${'deltaE'.padStart(7)}  ${'target'.padStart(6)}  result`);
  for (const row of rows) {
    const target = row.target === null ? '-' : String(row.target);
    console.log(
      `  ${row.vision.padEnd(14)}  ${`${row.a}/${row.b}`.padEnd(18)}  ${row.distance.toFixed(1).padStart(7)}  ${target.padStart(6)}  ${verdict(row)}`
    );
  }
}

function printTable(label, rows) {
  const widths = {
    fg: Math.max(10, ...rows.map((r) => r.fg.length)),
    bg: Math.max(10, ...rows.map((r) => r.bg.length))
  };
  console.log(`\n${label}`);
  console.log(
    `  ${'foreground'.padEnd(widths.fg)}  ${'background'.padEnd(widths.bg)}  ${'ratio'.padStart(8)}  ${'target'.padStart(6)}  result`
  );
  for (const row of rows) {
    const target = row.target === null ? '-' : `${row.target}:1`;
    console.log(
      `  ${row.fg.padEnd(widths.fg)}  ${row.bg.padEnd(widths.bg)}  ${formatRatio(row.ratio).padStart(8)}  ${target.padStart(6)}  ${verdict(row)}`
    );
  }
}

function markdown(themes) {
  const lines = [];
  lines.push('<!-- Generated by scripts/design/contrast.mjs. Do not edit by hand. -->');
  lines.push('');
  lines.push('# Console colour tokens');
  lines.push('');
  lines.push(
    'The values live in `console/frontend/src/styles/tokens.css` and are the single source of truth. Tailwind maps every colour utility onto them, so a token change reaches the whole console. Re-generate this file with `node scripts/design/contrast.mjs --write`.'
  );
  lines.push('');
  lines.push(
    'Targets follow WCAG 2.1 AA: 4.5:1 for text, 3:1 for the boundary of a user interface component and for a chart series against its plot background. Pairs marked `-` separate two areas that are already distinguishable without them; they carry no information and are listed for review only.'
  );
  lines.push('');

  for (const theme of themes) {
    lines.push(`## ${theme.label} theme`);
    lines.push('');
    lines.push('| Foreground | Background | Value | On | Ratio | Target | Result | Used for |');
    lines.push('|---|---|---|---|---:|---:|---|---|');
    for (const row of theme.rows) {
      const target = row.target === null ? '-' : `${row.target}:1`;
      lines.push(
        `| \`${row.fg}\` | \`${row.bg}\` | \`${row.fgHex}\` | \`${row.bgHex}\` | ${formatRatio(row.ratio)} | ${target} | ${verdict(row)} | ${row.use} |`
      );
    }
    lines.push('');
    lines.push(`### ${theme.label}: chart series separation`);
    lines.push('');
    lines.push(
      'The closest pair of the eight categorical series, in CIE L\\*a\\*b\\* distance, under normal vision and under simulated dichromacy (Vienot, Brettel and Mollon 1999).'
    );
    lines.push('');
    lines.push('| Vision | Closest pair | Distance | Target | Result |');
    lines.push('|---|---|---:|---:|---|');
    for (const row of theme.series) {
      lines.push(
        `| ${row.vision} | \`${row.a}\` / \`${row.b}\` | ${row.distance.toFixed(1)} | ${row.target} | ${verdict(row)} |`
      );
    }
    lines.push('');
  }

  lines.push('## Roles');
  lines.push('');
  lines.push('| Role | Meaning |');
  lines.push('|---|---|');
  const roles = [
    ['`surface`', 'The page behind everything else.'],
    ['`surface-raised`', 'Cards, panels, table bodies, menus.'],
    ['`surface-sunken`', 'Inputs, wells, code blocks, table headers.'],
    ['`surface-hover`', 'Hover tint for rows and menu items.'],
    ['`surface-inverse`', 'Tooltips and other deliberately inverted areas.'],
    ['`border`', 'Card outlines and separators.'],
    ['`border-subtle`', 'Separators inside a card.'],
    ['`border-strong`', 'The boundary of an interactive control. Holds 3:1.'],
    ['`content`', 'Primary text.'],
    ['`content-muted`', 'Secondary text: units, captions, column headers.'],
    ['`content-subtle`', 'Hints and placeholders.'],
    ['`accent`', 'The one non-status colour: primary actions, links, selection.'],
    ['`success`', 'Status only: the thing is working.'],
    ['`warning`', 'Status only: the thing is degraded or needs attention.'],
    ['`danger`', 'Status only: the thing is broken, or the action destroys data.'],
    ['`info`', 'Status only: neutral information, or a value that is not measured.'],
    ['`focus`', 'The keyboard focus ring. One colour everywhere.'],
    ['`chart-1` … `chart-8`', 'Categorical chart series, in order of first use.'],
    ['`ramp-1` … `ramp-6`', 'Sequential ramp for density and heat maps.']
  ];
  for (const [role, meaning] of roles) lines.push(`| ${role} | ${meaning} |`);
  lines.push('');
  lines.push(
    'Status is never carried by colour alone. Every status in the console is a colour, an icon and a word together; see `StatusBadge` in `console/frontend/src/ui/`.'
  );
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const write = process.argv.includes('--write');
  const css = await readFile(TOKENS_CSS, 'utf8');

  const themes = THEMES.map((theme) => {
    const tokens = parseThemeBlock(css, theme.selector);
    return { ...theme, rows: evaluate(tokens), series: evaluateSeries(tokens) };
  });

  let failures = 0;
  for (const theme of themes) {
    printTable(`${theme.label} theme (${theme.selector})`, theme.rows);
    printSeries(`${theme.label} theme: chart series separation`, theme.series);
    failures += [...theme.rows, ...theme.series].filter((r) => r.pass === false).length;
  }

  if (write) {
    await writeFile(TOKENS_DOC, markdown(themes), 'utf8');
    console.log(`\nwrote ${TOKENS_DOC}`);
  }

  const checked = themes.reduce(
    (n, t) => n + t.rows.filter((r) => r.target !== null).length + t.series.length,
    0
  );
  console.log(`\n${checked} pairs checked against a target, ${failures} below target`);

  if (failures > 0) {
    console.error(`contrast gate failed: ${failures} pair(s) below target`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
