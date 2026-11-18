import { describe, expect, it } from 'vitest';

import { currentSpan, detectTransitions, distanceAlongPath, isInService, snapshotService } from './transitEvents';

const snap = (entries: Array<[string, 'service' | 'unmeasured' | 'interrupted' | 'blocked' | 'interchange']>) =>
  snapshotService(entries.map(([id, symbol]) => ({ id, symbol })));

describe('detectTransitions', () => {
  it('plays nothing on the first render', () => {
    expect(detectTransitions(null, snap([['a', 'service']]))).toEqual({ online: [], offline: [] });
  });

  it('finds a device that came into service and one that left', () => {
    const before = snap([
      ['a', 'unmeasured'],
      ['b', 'service'],
      ['c', 'interrupted'],
      ['d', 'service']
    ]);
    const now = snap([
      ['a', 'service'],
      ['b', 'blocked'],
      ['c', 'interrupted'],
      ['d', 'service']
    ]);
    expect(detectTransitions(before, now)).toEqual({ online: ['a'], offline: ['b'] });
  });

  it('counts interchange and terminus as in service, and ignores devices seen for the first time', () => {
    expect(isInService('interchange')).toBe(true);
    expect(isInService('blocked')).toBe(false);
    const now = snap([
      ['new', 'service'],
      ['gw', 'interchange']
    ]);
    expect(detectTransitions(snap([['gw', 'interrupted']]), now)).toEqual({ online: ['gw'], offline: [] });
  });

  it('does nothing when nothing changed', () => {
    const s = snap([['a', 'service']]);
    expect(detectTransitions(s, snap([['a', 'service']]))).toEqual({ online: [], offline: [] });
  });
});

describe('distance along a line', () => {
  const path = 'M 0 10 L 10 0 H 50 V 40';
  it('measures along the path, including the diagonal', () => {
    expect(distanceAlongPath(path, 0, 10)).toBe(0);
    expect(distanceAlongPath(path, 30, 0)).toBeCloseTo(Math.SQRT2 * 10 + 20, 5);
    expect(distanceAlongPath(path, 50, 40)).toBeCloseTo(Math.SQRT2 * 10 + 40 + 40, 5);
  });

  it('runs from the previous stop, or from the line start for the first one', () => {
    const stops = [
      { x: 20, y: 0 },
      { x: 40, y: 0 }
    ];
    const first = currentSpan(path, stops, stops[0]!);
    expect(first.start).toBe(0);
    const second = currentSpan(path, stops, stops[1]!);
    expect(second.start).toBeCloseTo(Math.SQRT2 * 10 + 10, 5);
    expect(second.end).toBeGreaterThan(second.start);
  });
});
