import type { StationKind } from '../ui/StationSymbol';

/*
 * Which stations changed state between two refreshes of the map, and where along
 * its line a station sits. Pure, so it is tested without a browser. The map plays
 * a short current and a lamp only for a station that came into service after the
 * first render; it never invents motion.
 */

/** Symbols that mean "not in service". Everything else (service, interchange, terminus) is in service. */
const NOT_IN_SERVICE: ReadonlySet<StationKind> = new Set(['interrupted', 'unmeasured', 'blocked']);

export const isInService = (symbol: StationKind): boolean => !NOT_IN_SERVICE.has(symbol);

export interface StateSource {
  id: string;
  symbol: StationKind;
}

/** The in-service flag of every station, by device id. */
export function snapshotService(stations: StateSource[]): Map<string, boolean> {
  return new Map(stations.map((station) => [station.id, isInService(station.symbol)]));
}

export interface StateChanges {
  /** Stations that were out of service and are now in service. */
  online: string[];
  /** Stations that were in service and are not now. */
  offline: string[];
}

/**
 * Compares the previous snapshot with the current one. With no previous snapshot
 * (the first render) nothing changed. A station not seen before is new, not a
 * transition, so it does not play either.
 */
export function detectTransitions(previous: Map<string, boolean> | null, current: Map<string, boolean>): StateChanges {
  const changes: StateChanges = { online: [], offline: [] };
  if (previous === null) return changes;
  for (const [id, now] of current) {
    const before = previous.get(id);
    if (before === undefined || before === now) continue;
    (now ? changes.online : changes.offline).push(id);
  }
  return changes;
}

/** The commands of a path written by the layout: M, L, H and V only. */
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
    else if (command === 'V') y = Number(tokens[i++]);
    else break;
    out.push([x, y]);
  }
  return out;
}

/** The distance along the path, from its start, of the point on it nearest to (x, y). */
export function distanceAlongPath(path: string, x: number, y: number): number {
  const pts = points(path);
  let travelled = 0;
  let best = { gap: Number.POSITIVE_INFINITY, at: 0 };
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (len * len)));
    const gap = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (gap < best.gap - 1e-6) best = { gap, at: travelled + t * len };
    travelled += len;
  }
  return best.at;
}

/** Where the current runs: from the previous stop on the line (or its start) to the station. */
export function currentSpan(path: string, others: Array<{ x: number; y: number }>, to: { x: number; y: number }) {
  const end = distanceAlongPath(path, to.x, to.y);
  let start = 0;
  for (const other of others) {
    const at = distanceAlongPath(path, other.x, other.y);
    if (at < end - 0.5 && at > start) start = at;
  }
  return { start, end };
}

/** At most this many events play at once; the rest wait their turn. */
export const MAX_PLAYING = 6;
