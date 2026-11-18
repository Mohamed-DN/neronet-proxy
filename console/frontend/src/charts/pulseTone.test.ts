import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { LineColour } from '../services/types';
import { PULSE_OPACITY, pulseTone } from './pulseTone';

// vitest runs from console/frontend, and a CSS import comes back empty there: read the file as text.
const tokensCss = readFileSync('src/styles/tokens.css', 'utf8');

const LINES: LineColour[] = ['red', 'green', 'blue', 'orange', 'violet', 'sky'];

type Rgb = [number, number, number];

/** The tokens of one theme block of tokens.css. */
function theme(selector: string): Map<string, Rgb> {
  const escaped = selector.replace(/[[\]'.]/g, (c) => `\\${c}`);
  const start = tokensCss.search(new RegExp(`^${escaped}\\s*\\{`, 'm'));
  const body = tokensCss.slice(start, tokensCss.indexOf('\n}', start));
  const tokens = new Map<string, Rgb>();
  for (const m of body.matchAll(/--color-([a-z0-9-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    tokens.set(m[1]!, [Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  return tokens;
}

const luminance = ([r, g, b]: Rgb) => {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  fg.map((c, i) => Math.round(c * alpha + bg[i]! * (1 - alpha))) as Rgb;

describe('live-flow pulse colour per line', () => {
  for (const [name, selector] of [
    ['light', ':root'],
    ['dark', "[data-theme='dark']"]
  ] as const) {
    const tokens = theme(selector);
    for (const line of LINES) {
      it(`${line} line, ${name} theme: the chosen tint holds 3:1`, () => {
        const background = tokens.get(`line-${line}`)!;
        const pulse = tokens.get(`pulse-${pulseTone(line)}`)!;
        expect(contrast(over(pulse, background, PULSE_OPACITY), background)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('uses a light tint on the dark lines and a dark tint on the light ones', () => {
    expect(pulseTone('blue')).toBe('light');
    expect(pulseTone('violet')).toBe('light');
    expect(pulseTone('green')).toBe('light');
    expect(pulseTone('orange')).toBe('dark');
    expect(pulseTone('sky')).toBe('dark');
  });
});
