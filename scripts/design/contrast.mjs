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

/*
 * A background is a token name, or a tint: `danger@10/plate` is the danger
 * colour at 10% opacity over the plate, which is what `bg-danger/10` paints
 * in the console. Tints are where a status colour used as text tends to fall
 * under 4.5:1, because the tint pulls the background toward the text.
 *
 * `only` limits a pair to one theme, for the one case where the answer
 * differs: the signal is a 1.5:1 yellow on the light sheet and 10:1 on the
 * dark one, which is why every focus ring is two-tone (an ink band, then the
 * signal) and the band is what is gated in light.
 */
const STATUSES = ['success', 'warning', 'danger', 'info'];
const LINES = ['red', 'green', 'blue', 'orange', 'violet', 'sky'];
/* Which tint of the pulse each line uses; the same table as console/frontend/src/charts/pulseTone.ts. */
const PULSE = { red: 'light', green: 'light', blue: 'light', orange: 'dark', violet: 'light', sky: 'dark' };

const PAIRS = [
  { fg: 'ink', bg: 'sheet', target: TEXT, use: 'Body text on the page' },
  { fg: 'ink', bg: 'plate', target: TEXT, use: 'Body text on a plate' },
  { fg: 'ink', bg: 'surface-sunken', target: TEXT, use: 'Text in an input or well' },
  { fg: 'ink', bg: 'surface-hover', target: TEXT, use: 'Text on a hovered row or menu item' },
  { fg: 'ink-muted', bg: 'sheet', target: TEXT, use: 'Secondary text on the page' },
  { fg: 'ink-muted', bg: 'plate', target: TEXT, use: 'Secondary text on a plate' },
  { fg: 'ink-muted', bg: 'surface-sunken', target: TEXT, use: 'Secondary text in a well' },
  { fg: 'ink-muted', bg: 'surface-hover', target: TEXT, use: 'Secondary text on a hovered row' },
  { fg: 'content-subtle', bg: 'sheet', target: TEXT, use: 'Hints and placeholders on the page' },
  { fg: 'content-subtle', bg: 'plate', target: TEXT, use: 'Hints and placeholders on a plate' },
  { fg: 'content-subtle', bg: 'surface-sunken', target: TEXT, use: 'Placeholder inside an input' },
  { fg: 'content-subtle', bg: 'surface-hover', target: TEXT, use: 'Hint on a hovered row' },
  { fg: 'content-inverse', bg: 'surface-inverse', target: TEXT, use: 'Text on an inverted surface (tooltip)' },

  { fg: 'accent', bg: 'accent-subtle', target: TEXT, use: 'Selected row and accent text on its tint' },
  { fg: 'accent', bg: 'surface-sunken', target: TEXT, use: 'Link text in a well' },
  { fg: 'accent-contrast', bg: 'accent', target: TEXT, use: 'Label on a primary button (ink plate)' },
  { fg: 'accent-contrast', bg: 'accent-strong', target: TEXT, use: 'Label on a hovered primary button' },
  { fg: 'on-signal', bg: 'signal', target: TEXT, use: 'Selected text, label on a signal fill' },

  ...STATUSES.flatMap((s) => [
    { fg: s, bg: 'sheet', target: TEXT, use: `${s} text on the page` },
    { fg: s, bg: 'plate', target: TEXT, use: `${s} text on a plate` },
    { fg: s, bg: 'surface-sunken', target: TEXT, use: `${s} text in a well` },
    { fg: s, bg: 'surface-hover', target: TEXT, use: `${s} text on a hovered row` },
    { fg: s, bg: `${s}-subtle`, target: TEXT, use: `${s} badge on its tint token` },
    { fg: s, bg: `${s}@10/sheet`, target: TEXT, use: `${s} text on bg-${s}/10 over the page` },
    { fg: s, bg: `${s}@10/plate`, target: TEXT, use: `${s} text on bg-${s}/10 over a plate` },
    { fg: s, bg: `${s}@15/sheet`, target: TEXT, use: `${s} text on bg-${s}/15 over the page` },
    { fg: s, bg: `${s}@15/plate`, target: TEXT, use: `${s} text on bg-${s}/15 over a plate` },
    { fg: `${s}-contrast`, bg: s, target: TEXT, use: `Label on a solid ${s} fill` },
    { fg: `${s}-contrast`, bg: `${s}-strong`, target: TEXT, use: `Label on a hovered solid ${s} fill` }
  ]),

  { fg: 'border-strong', bg: 'sheet', target: UI, use: 'Control outline on the page' },
  { fg: 'border-strong', bg: 'plate', target: UI, use: 'Control outline on a plate' },
  { fg: 'border-strong', bg: 'surface-sunken', target: UI, use: 'Control outline on a well' },
  { fg: 'ink', bg: 'sheet', target: UI, use: 'Focus ring, inner ink band, on the page' },
  { fg: 'ink', bg: 'plate', target: UI, use: 'Focus ring, inner ink band, on a plate' },
  { fg: 'ink', bg: 'surface-sunken', target: UI, use: 'Focus ring, inner ink band, on a well' },
  { fg: 'ink', bg: 'surface-hover', target: UI, use: 'Focus ring, inner ink band, on a hovered row' },
  { fg: 'signal', bg: 'ink', target: UI, only: 'light', use: 'Focus ring, signal against the ink band' },
  { fg: 'signal', bg: 'sheet', target: UI, only: 'dark', use: 'Focus ring, signal, on the page' },
  { fg: 'signal', bg: 'plate', target: UI, only: 'dark', use: 'Focus ring, signal, on a plate' },
  { fg: 'signal', bg: 'surface-sunken', target: UI, only: 'dark', use: 'Focus ring, signal, on a well' },
  { fg: 'signal', bg: 'sheet', target: null, only: 'light', use: 'Signal alone on the page: not enough, hence two-tone' },
  { fg: 'signal', bg: 'plate', target: null, only: 'light', use: 'Signal alone on a plate: not enough, hence two-tone' },
  { fg: 'accent', bg: 'surface-sunken', target: UI, use: 'Selected control fill on a well' },

  ...LINES.flatMap((l) => [
    { fg: `line-${l}`, bg: 'sheet', target: UI, use: `Line colour ${l} on the page` },
    { fg: `line-${l}`, bg: 'plate', target: UI, use: `Line colour ${l} on a plate` },
    { fg: `line-${l}`, bg: 'surface-sunken', target: UI, use: `Line colour ${l} on a well` }
  ]),

  /* The live-flow pulse, drawn at 0.85 opacity over its line (charts/pulseTone.ts picks the tint). */
  ...Object.entries(PULSE).map(([l, tint]) => ({
    fg: `pulse-${tint}@85/line-${l}`,
    bg: `line-${l}`,
    target: UI,
    use: `Live-flow pulse (${tint} tint) on the ${l} line`
  })),

  ...Array.from({ length: 8 }, (_, i) => ({
    fg: `chart-${i + 1}`,
    bg: 'plate',
    target: UI,
    use: `Chart series ${i + 1}`
  })),

  { fg: 'rule', bg: 'sheet', target: null, use: 'Separator, carries no information' },
  { fg: 'rule', bg: 'plate', target: null, use: 'Plate outline, carries no information' },
  { fg: 'border-subtle', bg: 'plate', target: null, use: 'Row separator inside a plate' },
  { fg: 'surface-hover', bg: 'plate', target: null, use: 'Hover tint on a row' }
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
  const aliases = new Map();
  for (const line of body.split('\n')) {
    const m = line.match(/--color-([a-z0-9-]+)\s*:\s*(\d+)\s+(\d+)\s+(\d+)\s*;/i);
    if (m) tokens.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4])]);
    const a = line.match(/--color-([a-z0-9-]+)\s*:\s*var\(--color-([a-z0-9-]+)\)\s*;/i);
    if (a) aliases.set(a[1], a[2]);
  }
  /* An alias (--color-surface: var(--color-sheet)) resolves within the same
   * block, which is how the browser resolves it on the root element. */
  for (const [name, target] of aliases) {
    let hops = 0;
    let t = target;
    while (aliases.has(t) && hops++ < 8) t = aliases.get(t);
    if (!tokens.has(t)) throw new Error(`alias --color-${name} points at --color-${target}, which is not defined`);
    tokens.set(name, tokens.get(t));
  }
  return tokens;
}

function resolve(tokens, expr) {
  const tint = expr.match(/^([a-z0-9-]+)@(\d+)\/([a-z0-9-]+)$/);
  if (tint) {
    const over = tokens.get(tint[3]);
    const colour = tokens.get(tint[1]);
    if (!over || !colour) throw new Error(`token in ${expr} is not defined`);
    const alpha = Number(tint[2]) / 100;
    return colour.map((c, i) => Math.round(c * alpha + over[i] * (1 - alpha)));
  }
  const value = tokens.get(expr);
  if (!value) throw new Error(`token --color-${expr} is not defined`);
  return value;
}

function evaluate(tokens, themeId) {
  const rows = [];
  for (const pair of PAIRS) {
    if (pair.only && pair.only !== themeId) continue;
    const fg = resolve(tokens, pair.fg);
    const bg = resolve(tokens, pair.bg);
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
    'The values live in `console/frontend/src/styles/tokens.css` and are the single source of truth. Tailwind maps every colour utility onto them, so a token change reaches the whole console. The palette is the transit-map direction in [`DIRECTION-2026-11.md`](DIRECTION-2026-11.md): the new roles are `sheet`, `plate`, `ink`, `ink-muted`, `rule` and `signal`, plus six line colours; the older names (`surface`, `content`, `accent`, `border`, `focus`) are aliases that resolve onto them, and a pair listed under an alias is measured on the value it resolves to. Re-generate this file with `node scripts/design/contrast.mjs --write`.'
  );
  lines.push('');
  lines.push(
    'Targets follow WCAG 2.1 AA: 4.5:1 for text, 3:1 for the boundary of a user interface component, for a focus indicator, for a line colour and for a chart series against its plot background. A background written `danger@10/plate` is the danger colour at 10% opacity over the plate, which is what `bg-danger/10` paints. Pairs marked `-` separate two areas that are already distinguishable without them, or (the signal alone on the light sheet) are shown to explain a design decision; they cannot fail the run. Any other pair below its target exits 1.'
  );
  lines.push('');
  lines.push(
    'The signal (`#F5C211`) is 1.5:1 on the light sheet, so it cannot be a focus ring by itself. Every focus ring and every highlighted option is two-tone: a 2px ink band against the control, then a 2px signal ring outside it. The ink band is what holds 3:1 in both themes; in the dark theme the signal holds it too.'
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
    ['`sheet` (`surface`)', 'The page behind everything else. Cool, never cream.'],
    ['`plate` (`surface-raised`)', 'Raised surfaces: panels, table bodies, menus, dialogs.'],
    ['`surface-sunken`', 'Inputs, wells, code blocks, table headers.'],
    ['`surface-hover`', 'Hover tint for rows and menu items.'],
    ['`ink` (`content`, `accent`)', 'Text, and the primary button: an ink plate with sheet text.'],
    ['`ink-muted` (`content-muted`)', 'Secondary text: units, captions, column headers.'],
    ['`content-subtle`', 'Hints and placeholders.'],
    ['`rule` (`border`)', 'Plate outlines, dividers, the map grid. Carries no information.'],
    ['`border-subtle`', 'Separators inside a plate.'],
    ['`border-strong`', 'The boundary of an interactive control. Holds 3:1.'],
    ['`signal` (`focus`)', 'The one accent: the focus ring, "you are here", the selected station. Never text.'],
    ['`on-signal`', 'Text on a signal fill, such as selected text.'],
    ['`line-red` … `line-sky`', 'Six line colours for sub-networks and groups. Never status. Labels stay ink.'],
    ['`paper`', 'A printed surface: the ground of a QR code, white in both themes.'],
    ['`success`', 'Status only: in service.'],
    ['`warning`', 'Status only: degraded or needs attention.'],
    ['`danger`', 'Status only: broken, blocked, or the action destroys data.'],
    ['`info`', 'Status only: neutral information, or a value that is not measured.'],
    ['`chart-1` … `chart-8`', 'Categorical chart series, in order of first use.'],
    ['`ramp-1` … `ramp-6`', 'Sequential ramp for density and heat maps.']
  ];
  for (const [role, meaning] of roles) lines.push(`| ${role} | ${meaning} |`);
  lines.push('');
  lines.push(
    'Status is never carried by colour alone. Every status in the console is a colour, a shape and a word together; see `StatusBadge` in `console/frontend/src/ui/`.'
  );
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const write = process.argv.includes('--write');
  const css = await readFile(TOKENS_CSS, 'utf8');

  const themes = THEMES.map((theme) => {
    const tokens = parseThemeBlock(css, theme.selector);
    return { ...theme, rows: evaluate(tokens, theme.id), series: evaluateSeries(tokens) };
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
