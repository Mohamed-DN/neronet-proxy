import { describe, expect, it } from 'vitest';

import { MAX_STEP, STEP, isOctilinear, layoutTransit, stationsPerRow } from './transitLayout';

/** The corner points of a path made of M, L, H and V commands. */
function points(path: string): Array<[number, number]> {
  const tokens = path.trim().split(/\s+/);
  const out: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++]!;
    if (command === 'M' || command === 'L') {
      x = Number(tokens[i++]);
      y = Number(tokens[i++]);
    } else if (command === 'H') x = Number(tokens[i++]);
    else y = Number(tokens[i++]);
    out.push([x, y]);
  }
  return out;
}

/** Whether the path runs through (x, y), on a corner or along a segment. */
function passesThrough(path: string, x: number, y: number): boolean {
  const pts = points(path);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const cross = (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0);
    const within =
      x >= Math.min(x0, x1) - 0.5 &&
      x <= Math.max(x0, x1) + 0.5 &&
      y >= Math.min(y0, y1) - 0.5 &&
      y <= Math.max(y0, y1) + 0.5;
    if (Math.abs(cross) < 1 && within) return true;
  }
  return false;
}

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
    const layout = layoutTransit([{ key: 'a', stationIds: ids(4) }], 900);
    const [line] = layout.lines;
    expect(line!.stations.map((s) => s.side)).toEqual(['above', 'below', 'above', 'below']);
    expect(line!.stations[1]!.x - line!.stations[0]!.x).toBe(layout.step);
  });

  it('spreads a sparse map to use the width, never closer than STEP nor wider than MAX_STEP', () => {
    expect(layoutTransit([{ key: 'a', stationIds: ids(3) }], 1300).step).toBe(MAX_STEP);
    expect(layoutTransit([{ key: 'a', stationIds: ids(12) }], 1000).step).toBeGreaterThanOrEqual(STEP);
    expect(layoutTransit([{ key: 'a', stationIds: ids(40) }], 1000).step).toBe(STEP);
    expect(layoutTransit([{ key: 'a', stationIds: ids(1) }], 1000).step).toBe(STEP);
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

  it('draws an interchange once, with every line it serves routed through it at 0, 45 or 90 degrees', () => {
    const layout = layoutTransit(
      [
        { key: 'a', stationIds: ids(5, 'a') },
        { key: 'b', stationIds: ids(5, 'b') },
        { key: 'c', stationIds: ids(3, 'c') }
      ],
      1100,
      [{ id: 'gw', kind: 'interchange', lineKeys: ['a', 'b'] }]
    );
    expect(layout.hubs).toHaveLength(1);
    const hub = layout.hubs[0]!;
    for (const key of ['a', 'b']) {
      const line = layout.lines.find((l) => l.key === key)!;
      expect(isOctilinear(line.path), key).toBe(true);
      expect(passesThrough(line.path, hub.x, hub.y), key).toBe(true);
      // The interchange is a place of its own, not also a stop on the line.
      expect(line.stations.map((s) => s.id)).not.toContain('gw');
    }
    // A line it does not serve does not pass through it.
    expect(passesThrough(layout.lines[2]!.path, hub.x, hub.y)).toBe(false);
    // Every stop of a served line sits to the right of the interchange.
    for (const key of ['a', 'b']) {
      for (const station of layout.lines.find((l) => l.key === key)!.stations) expect(station.x).toBeGreaterThan(hub.x);
    }
  });

  it('puts an exit at the end of the lines it serves, where they all finish', () => {
    const layout = layoutTransit(
      [
        { key: 'a', stationIds: ids(3, 'a') },
        { key: 'b', stationIds: ids(6, 'b') }
      ],
      1100,
      [{ id: 'out', kind: 'terminus', lineKeys: ['a', 'b'] }]
    );
    const exit = layout.hubs[0]!;
    for (const line of layout.lines) {
      expect(isOctilinear(line.path), line.key).toBe(true);
      const end = points(line.path).at(-1)!;
      expect(end).toEqual([exit.x, exit.y]);
      for (const station of line.stations) expect(station.x).toBeLessThan(exit.x);
    }
  });

  it('ends a line on its own exit when it serves only that line', () => {
    const layout = layoutTransit([{ key: 'a', stationIds: ids(4, 'a'), terminusId: 'a3' }], 900);
    const line = layout.lines[0]!;
    const last = line.stations.at(-1)!;
    expect(last.id).toBe('a3');
    expect(points(line.path).at(-1)).toEqual([last.x, last.y]);
  });

  it('keeps an interchange that serves one line as a stop on it', () => {
    const layout = layoutTransit([{ key: 'a', stationIds: ['gw', ...ids(3, 'a')] }], 900);
    expect(layout.hubs).toHaveLength(0);
    expect(layout.lines[0]!.stations[0]!.id).toBe('gw');
  });

  it('spreads a few stations along the width with a step between STEP and MAX_STEP, and centres the drawing', () => {
    expect(MAX_STEP).toBeLessThanOrEqual(160);
    for (const [count, width] of [
      [2, 1300],
      [3, 1300],
      [5, 900],
      [9, 1300]
    ] as const) {
      const layout = layoutTransit([{ key: 'a', stationIds: ids(count) }], width);
      const stations = layout.lines[0]!.stations;
      expect(layout.step, `${count} at ${width}`).toBeGreaterThanOrEqual(STEP);
      expect(layout.step, `${count} at ${width}`).toBeLessThanOrEqual(MAX_STEP);
      const left = points(layout.lines[0]!.path)[0]![0];
      const right = Math.max(...points(layout.lines[0]!.path).map(([x]) => x));
      expect(stations[0]!.x).toBeGreaterThan(left);
      // Equal margins left and right of the drawing, within a few pixels.
      expect(Math.abs(left - (width - right))).toBeLessThanOrEqual(30);
    }
    // Two stations are not pushed to opposite edges.
    const two = layoutTransit([{ key: 'a', stationIds: ids(2) }], 1300).lines[0]!.stations;
    expect(two[1]!.x - two[0]!.x).toBeLessThanOrEqual(MAX_STEP);
  });

  it('draws one device as a short line with a cap at each end and the station in the middle', () => {
    const layout = layoutTransit([{ key: 'a', stationIds: ['only'] }], 1200);
    const line = layout.lines[0]!;
    expect(isOctilinear(line.path)).toBe(true);
    expect(line.caps).toHaveLength(2);
    const station = line.stations[0]!;
    expect(station.x).toBe(600);
    expect(line.caps[0]!.x).toBeLessThan(station.x);
    expect(line.caps[1]!.x).toBeGreaterThan(station.x);
    expect(station.x - line.caps[0]!.x).toBe(line.caps[1]!.x - station.x);
    expect(line.caps[0]!.y).toBe(station.y);
    expect(layout.height).toBeLessThan(150);
  });

  it('fits the plate to its content: a one-line map is short, and more lines grow it', () => {
    const one = layoutTransit([{ key: 'a', stationIds: ids(6) }], 1200);
    expect(one.height).toBeLessThan(170);
    expect(one.lines[0]!.caps).toHaveLength(0);
  });
});
