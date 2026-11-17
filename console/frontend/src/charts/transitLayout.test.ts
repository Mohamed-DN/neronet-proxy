import { describe, expect, it } from 'vitest';

import { STEP, isOctilinear, layoutTransit, stationsPerRow } from './transitLayout';

const ids = (n: number, prefix = 's') => Array.from({ length: n }, (_, k) => `${prefix}${k}`);

describe('layoutTransit', () => {
  it('uses only horizontal, vertical and 45-degree segments, even when a line wraps', () => {
    const layout = layoutTransit(
      [
        { key: 'a', stationIds: ids(2, 'a') },
        { key: 'b', stationIds: ids(41, 'b') },
        { key: 'c', stationIds: [] }
      ],
      760
    );
    expect(layout.lines).toHaveLength(3);
    for (const line of layout.lines) expect(isOctilinear(line.path), line.key).toBe(true);
  });

  it('is the same picture for the same input, and keeps every station', () => {
    const lines = [{ key: 'a', stationIds: ids(23) }];
    expect(layoutTransit(lines, 900)).toEqual(layoutTransit(lines, 900));
    expect(layoutTransit(lines, 900).lines[0]!.stations.map((s) => s.id)).toEqual(ids(23));
  });

  it('wraps a long line into rows that run back and forth, inside the drawn width', () => {
    const width = 700;
    const perRow = stationsPerRow(width);
    const layout = layoutTransit([{ key: 'a', stationIds: ids(perRow * 2 + 1) }], width);
    const stations = layout.lines[0]!.stations;
    expect(new Set(stations.map((s) => s.y)).size).toBe(3);
    // The second row runs right to left: its first station is at the right end.
    expect(stations[perRow]!.x).toBeGreaterThan(stations[perRow + 1]!.x);
    for (const station of stations) {
      expect(station.x).toBeGreaterThan(0);
      expect(station.x).toBeLessThan(width);
    }
  });

  it('alternates labels above and below so neighbours have room, and keeps stations a step apart', () => {
    const [line] = layoutTransit([{ key: 'a', stationIds: ids(4) }], 900).lines;
    expect(line!.stations.map((s) => s.side)).toEqual(['above', 'below', 'above', 'below']);
    expect(line!.stations[1]!.x - line!.stations[0]!.x).toBe(STEP);
  });

  it('gives lanes their own vertical space and grows the drawing with them', () => {
    const one = layoutTransit([{ key: 'a', stationIds: ids(3) }], 800);
    const two = layoutTransit(
      [
        { key: 'a', stationIds: ids(3) },
        { key: 'b', stationIds: ids(3) }
      ],
      800
    );
    expect(two.lines[1]!.top).toBeGreaterThan(two.lines[0]!.stations[0]!.y);
    expect(two.height).toBeGreaterThan(one.height);
  });
});
