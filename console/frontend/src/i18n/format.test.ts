import { describe, expect, it } from 'vitest';

import {
  formatBitsPerSecond,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelativeTime
} from './format';

describe('formatters', () => {
  it('follows the locale for numbers', () => {
    expect(formatNumber('en', 1234567.5, { maximumFractionDigits: 1 })).toBe('1,234,567.5');
    expect(formatNumber('it', 1234567.5, { maximumFractionDigits: 1 })).toBe('1.234.567,5');
  });

  it('follows the locale for percentages', () => {
    expect(formatPercent('en', 0.872, 1)).toBe('87.2%');
    expect(formatPercent('it', 0.872, 1)).toBe('87,2%');
  });

  it('follows the locale for dates', () => {
    const when = new Date(Date.UTC(2026, 8, 19, 10, 30));
    const english = formatDateTime('en', when);
    const italian = formatDateTime('it', when);
    expect(english).toMatch(/Sep 19, 2026/);
    expect(italian).toMatch(/19 set 2026/);
    expect(english).not.toBe(italian);
  });

  it('formats bytes in binary multiples with a translated unit', () => {
    expect(formatBytes('en', 512)).toBe('512 byte');
    expect(formatBytes('en', 1536)).toBe('1.5 kB');
    expect(formatBytes('it', 1536)).toBe('1,5 kB');
    expect(formatBytes('en', 1024 ** 3)).toBe('1.0 GB');
  });

  it('formats relative times against a fixed clock', () => {
    const now = new Date('2026-09-19T12:00:00Z');
    expect(formatRelativeTime('en', new Date('2026-09-19T11:57:00Z'), now)).toBe('3 minutes ago');
    expect(formatRelativeTime('it', new Date('2026-09-19T11:57:00Z'), now)).toBe('3 minuti fa');
    expect(formatRelativeTime('en', new Date('2026-09-18T12:00:00Z'), now)).toBe('yesterday');
  });

  it('formats throughput in decimal multiples of bits per second', () => {
    expect(formatBitsPerSecond('en', 950)).toBe('950 bit/s');
    expect(formatBitsPerSecond('en', 1_500_000)).toBe('1.5 Mbit/s');
  });

  it('formats durations', () => {
    expect(formatDuration('en', 0)).toBe('0m');
    expect(formatDuration('en', 3 * 3600 + 25 * 60)).toBe('3h 25m');
  });

  it('returns null for a value that was never measured, never a zero', () => {
    expect(formatNumber('en', null)).toBeNull();
    expect(formatNumber('en', undefined)).toBeNull();
    expect(formatNumber('en', Number.NaN)).toBeNull();
    expect(formatPercent('en', null)).toBeNull();
    expect(formatBytes('en', null)).toBeNull();
    expect(formatBitsPerSecond('en', null)).toBeNull();
    expect(formatDuration('en', null)).toBeNull();
    expect(formatDateTime('en', null)).toBeNull();
    expect(formatRelativeTime('en', null)).toBeNull();
  });

  it('returns null for a date it cannot parse instead of Invalid Date', () => {
    expect(formatDateTime('en', 'not a date')).toBeNull();
    expect(formatRelativeTime('en', 'not a date')).toBeNull();
  });

  it('still formats a real zero', () => {
    expect(formatNumber('en', 0)).toBe('0');
    expect(formatBytes('en', 0)).toBe('0 byte');
  });
});
