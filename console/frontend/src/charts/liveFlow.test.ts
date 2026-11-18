import { describe, expect, it } from 'vitest';

import { MAX_GAP_MS, MAX_PULSES, flowForLines, flowParams, lineRates, sampleCounters } from './liveFlow';

describe('flowParams (throughput to motion)', () => {
  it('does not move for zero, unknown or nonsense', () => {
    expect(flowParams(0)).toBeNull();
    expect(flowParams(null)).toBeNull();
    expect(flowParams(undefined)).toBeNull();
    expect(flowParams(Number.NaN)).toBeNull();
    expect(flowParams(-5)).toBeNull();
  });

  it('clamps: tiny traffic is the gentlest motion, huge traffic is never frantic', () => {
    const low = flowParams(1)!;
    const high = flowParams(1e12)!;
    expect(low).toEqual({ pulses: 1, durationMs: 4200 });
    expect(high.pulses).toBe(MAX_PULSES);
    expect(high.durationMs).toBe(1600);
    expect(flowParams(1000)).toEqual(low);
  });

  it('is logarithmic: each decade moves it by the same step', () => {
    const d = (rate: number) => flowParams(rate)!.durationMs;
    expect(d(1e3) - d(1e4)).toBe(d(1e4) - d(1e5));
    expect(d(1e5) - d(1e6)).toBe(d(1e6) - d(1e7));
    expect(d(1e4)).toBeGreaterThan(d(1e5));
    expect(flowParams(1e5)!.pulses).toBeGreaterThan(flowParams(1e3)!.pulses);
  });
});

describe('lineRates', () => {
  const lineOf = new Map([
    ['a', 'L1'],
    ['b', 'L1'],
    ['c', 'L2'],
    ['d', 'L3']
  ]);
  const at = (t: number, nodes: Array<{ id: string; rx_bytes?: string | null; tx_bytes?: string | null }>) =>
    sampleCounters(nodes, t);

  it('knows nothing on the first sample', () => {
    const rates = lineRates(null, at(0, [{ id: 'a', rx_bytes: '10' }]), lineOf);
    expect([...rates.values()]).toEqual([null, null, null]);
  });

  it('sums the growth of the counters over the interval, per second', () => {
    const before = at(0, [
      { id: 'a', rx_bytes: '1000', tx_bytes: '1000' },
      { id: 'b', rx_bytes: '0', tx_bytes: '0' },
      { id: 'c', rx_bytes: '5', tx_bytes: '5' }
    ]);
    const now = at(30_000, [
      { id: 'a', rx_bytes: '7000', tx_bytes: '1000' },
      { id: 'b', rx_bytes: '0', tx_bytes: '3000' },
      { id: 'c', rx_bytes: '5', tx_bytes: '5' }
    ]);
    const rates = lineRates(before, now, lineOf);
    expect(rates.get('L1')).toBe(300);
    expect(rates.get('L2')).toBe(0);
    expect(rates.get('L3')).toBeNull();
  });

  it('treats a missing or reset counter and a stale gap as unknown, never as traffic', () => {
    const before = at(0, [{ id: 'a', rx_bytes: '5000' }, { id: 'c' }]);
    expect(lineRates(before, at(10_000, [{ id: 'a', rx_bytes: '10' }, { id: 'c' }]), lineOf).get('L1')).toBeNull();
    expect(lineRates(before, at(10_000, [{ id: 'a' }, { id: 'c', rx_bytes: '9' }]), lineOf).get('L2')).toBeNull();
    expect(lineRates(before, at(MAX_GAP_MS + 1, [{ id: 'a', rx_bytes: '9000' }]), lineOf).get('L1')).toBeNull();
  });

  it('makes nothing move when no line is measured', () => {
    const before = at(0, [{ id: 'a' }]);
    const rates = lineRates(before, at(30_000, [{ id: 'a' }]), lineOf);
    expect(flowForLines(rates).size).toBe(0);
  });
});

describe('flowForLines', () => {
  it('caps the pulses of the whole map', () => {
    const rates = new Map<string, number | null>(Array.from({ length: 20 }, (_, i) => [`L${i}`, 1e9]));
    const total = [...flowForLines(rates, 10).values()].reduce((sum, p) => sum + p.pulses, 0);
    expect(total).toBeLessThanOrEqual(10);
  });
});
