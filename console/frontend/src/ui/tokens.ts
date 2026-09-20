/**
 * Reads design tokens at run time.
 *
 * Almost everything in the console gets its colour from a Tailwind class. Two
 * things cannot: Recharts, which wants a colour string per series, and the
 * three.js topology, which wants a number. Both read from here instead of
 * carrying their own hex literals, so they follow the theme and the palette
 * stays in one file.
 */

export type ThemeName = 'light' | 'dark';
export type ThemePreference = ThemeName | 'system';
export type Density = 'comfortable' | 'compact';

export const THEME_STORAGE_KEY = 'neronet.theme';
export const DENSITY_STORAGE_KEY = 'neronet.density';
export const LANGUAGE_STORAGE_KEY = 'neronet.language';

/** Number of categorical series the palette defines. */
export const CHART_SERIES_COUNT = 8;
/** Number of steps in the sequential ramp. */
export const RAMP_STEPS = 6;

const FALLBACK = '0 0 0';

function channels(name: string, element?: Element): string {
  if (typeof window === 'undefined') return FALLBACK;
  const target = element ?? document.documentElement;
  const value = window.getComputedStyle(target).getPropertyValue(`--color-${name}`).trim();
  return value || FALLBACK;
}

/**
 * A token as a CSS colour string, optionally with an alpha.
 *
 * @param name token name without the `--color-` prefix, for example `accent`
 * @param alpha 0 to 1; omitted means fully opaque
 */
export function colorToken(name: string, alpha?: number): string {
  const value = channels(name);
  return alpha === undefined ? `rgb(${value})` : `rgb(${value} / ${alpha})`;
}

/** A token as a 24-bit number, for three.js materials. */
export function colorTokenHex(name: string): number {
  const [r = 0, g = 0, b = 0] = channels(name).split(/\s+/).map(Number);
  return (r << 16) + (g << 8) + b;
}

/** The categorical chart series, in the order a chart should consume them. */
export function chartSeries(): string[] {
  return Array.from({ length: CHART_SERIES_COUNT }, (_, i) => colorToken(`chart-${i + 1}`));
}

/** The sequential ramp, lightest first in the light theme. */
export function chartRamp(): string[] {
  return Array.from({ length: RAMP_STEPS }, (_, i) => colorToken(`ramp-${i + 1}`));
}

/** The series colour for an index, wrapping when a chart has more than eight. */
export function seriesColor(index: number): string {
  return colorToken(`chart-${(index % CHART_SERIES_COUNT) + 1}`);
}
