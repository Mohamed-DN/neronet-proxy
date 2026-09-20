/**
 * Locale-aware formatting for the values the console shows.
 *
 * Every function takes the value that may be missing and returns `null` when it
 * is. The caller decides how to render "not measured"; nothing here invents a
 * zero, a dash or a plausible default.
 */

const NUMBER_CACHE = new Map<string, Intl.NumberFormat>();
const DATE_CACHE = new Map<string, Intl.DateTimeFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let formatter = NUMBER_CACHE.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    NUMBER_CACHE.set(key, formatter);
  }
  return formatter;
}

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let formatter = DATE_CACHE.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    DATE_CACHE.set(key, formatter);
  }
  return formatter;
}

function missing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || Number.isNaN(value);
}

export function formatNumber(
  locale: string,
  value: number | null | undefined,
  options: Intl.NumberFormatOptions = {}
): string | null {
  if (missing(value)) return null;
  return numberFormat(locale, options).format(value);
}

export function formatPercent(locale: string, value: number | null | undefined, fractionDigits = 0): string | null {
  if (missing(value)) return null;
  return numberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(value);
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte', 'petabyte'] as const;

/**
 * Binary multiples, which is what an operator reading a disk or a transfer
 * figure expects, with the unit named by Intl so it is translated.
 */
export function formatBytes(locale: string, value: number | null | undefined, fractionDigits = 1): string | null {
  if (missing(value)) return null;
  const sign = value < 0 ? -1 : 1;
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1024 && unit < BYTE_UNITS.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : fractionDigits;
  return numberFormat(locale, {
    style: 'unit',
    unit: BYTE_UNITS[unit],
    unitDisplay: 'short',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(sign * amount);
}

export function formatDateTime(locale: string, value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatDate(locale: string, value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateFormat(locale, { dateStyle: 'medium' }).format(date);
}

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.348],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY]
];

/**
 * "3 minutes ago", in the reader's language. `now` is a parameter so that a
 * test does not depend on the wall clock.
 */
export function formatRelativeTime(
  locale: string,
  value: Date | string | number | null | undefined,
  now: Date = new Date()
): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  let delta = (date.getTime() - now.getTime()) / 1000;
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  for (const [candidate, limit] of RELATIVE_STEPS) {
    unit = candidate;
    if (Math.abs(delta) < limit) break;
    delta /= limit;
  }
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(delta), unit);
}

/** Throughput in bits per second, the unit a network operator reads. */
export function formatBitsPerSecond(locale: string, value: number | null | undefined): string | null {
  if (missing(value)) return null;
  const units = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s', 'Tbit/s'];
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  const formatted = numberFormat(locale, {
    minimumFractionDigits: unit === 0 ? 0 : 1,
    maximumFractionDigits: unit === 0 ? 0 : 1
  }).format(value < 0 ? -amount : amount);
  return `${formatted} ${units[unit]}`;
}

/** Seconds as a duration an operator can read at a glance. */
export function formatDuration(locale: string, seconds: number | null | undefined): string | null {
  if (missing(seconds)) return null;
  const total = Math.floor(Math.abs(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts: string[] = [];
  const unit = (value: number, name: Intl.NumberFormatOptions['unit']) =>
    numberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);
  if (days) parts.push(unit(days, 'day'));
  if (hours) parts.push(unit(hours, 'hour'));
  if (minutes || parts.length === 0) parts.push(unit(minutes, 'minute'));
  return parts.join(' ');
}
