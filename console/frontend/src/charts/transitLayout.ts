/*
 * The geometry of the network as a transit diagram, and nothing else: it takes
 * lines with their stations, and the interchanges and termini that several lines
 * share, and returns where everything goes. It is a pure function of its input
 * and the drawn width, so the picture is the same on every refresh and can be
 * tested without a browser.
 *
 * Every segment is horizontal, vertical or at exactly 45 degrees. A line starts
 * with a 45-degree ramp, runs along a row of stations, and wraps at the end of
 * the row with two 45-degree chamfers and a vertical, then runs back on the next
 * row (a boustrophedon), so a long line never needs a diagonal that is not 45.
 * Labels sit above and below the line in turn, and are always horizontal.
 *
 * Lines are lanes stacked one above the other. An interchange is one place that
 * several lanes pass through: each of them leaves its lane at 45 degrees, runs
 * through the interchange and returns to its lane at 45 degrees. An exit that
 * serves several lanes is their common terminus: they converge on it at the
 * right-hand end. The drawing is spread over the width, never wider than
 * MAX_STEP between stops, and centred.
 */

export interface LayoutLine {
  key: string;
  stationIds: string[];
  /** The id, last in `stationIds`, of an exit the line ends on: the line stops at it, with no tail. */
  terminusId?: string;
}

export interface LayoutHub {
  id: string;
  /** `interchange` is passed through; `terminus` is where the lines end. */
  kind: 'interchange' | 'terminus';
  /** The lines that go through it, or end on it. */
  lineKeys: string[];
}

export interface PlacedStation {
  id: string;
  x: number;
  y: number;
  /** Whether the label sits above or below the line. Alternates, so neighbours get twice the room. */
  side: 'above' | 'below';
}

export interface PlacedHub {
  id: string;
  kind: 'interchange' | 'terminus';
  x: number;
  y: number;
  side: 'above' | 'below';
  /** The lines routed through it, in lane order. */
  lineKeys: string[];
}

export interface PlacedLine {
  key: string;
  /** The SVG path of the line: M, L, H and V commands only. */
  path: string;
  stations: PlacedStation[];
  /** The end caps of a line that has a single stop; empty otherwise. */
  caps: Array<{ x: number; y: number }>;
  /** Where the lane's heading (the line's name) goes: left edge, text baseline. */
  heading: { x: number; y: number };
  /** Top of the lane. */
  top: number;
}

export interface TransitLayout {
  /** Distance between two stations along a row, after spreading a sparse map. */
  step: number;
  width: number;
  height: number;
  lines: PlacedLine[];
  /** The interchanges and termini that were drawn as shared places. The rest became stops on a line. */
  hubs: PlacedHub[];
}

export const PAD = 20;
/** Horizontal run of the starting 45-degree ramp, which is also its rise. */
export const RAMP = 14;
/** The least distance between two stations along a row. */
export const STEP = 76;
/** The most a sparse map spreads its stations, so two stops are never at opposite edges. */
export const MAX_STEP = 160;
/** Distance between two rows of one line. */
export const ROW_GAP = 92;
/** Chamfer size at a wrap. */
export const CHAMFER = 12;
/** Line run past the last station of a row before it turns or ends. */
export const TAIL = 28;
/** Half the length of the short line that draws a single device. */
export const SOLO_HALF = 110;

const HEADING_HEIGHT = 34;
// Room for a label above the first row of a lane, and below the last.
const LABEL_ABOVE = 26;
const LABEL_BELOW = 30;
const LANE_GAP = 14;
/** Width reserved under a lane's heading before the first interchange. */
const HEADING_ROOM = 190;
/** Clear distance between an interchange and the next thing along the lane. */
const HUB_GAP = 84;
/** Half of a label's box: the room a terminus keeps to its right. */
const LABEL_HALF = 70;

/** The x of the first station of a row on a map without interchanges, leaving room for the ramp. */
export const FIRST_X = PAD + RAMP + 36;

const rightEdge = (width: number) => width - (TAIL + CHAMFER + PAD);

/** How many stations fit on one row of a drawing `width` pixels wide, without interchanges. */
export function stationsPerRow(width: number): number {
  return perRowFor(FIRST_X, rightEdge(width));
}

function perRowFor(firstX: number, rightMost: number): number {
  return Math.max(2, Math.floor((rightMost - firstX) / STEP) + 1);
}

// --- Path ----------------------------------------------------------------------

type Segment = { c: 'M' | 'L'; x: number; y: number } | { c: 'H'; x: number } | { c: 'V'; y: number };

/** Writes segments as SVG, moving every x by `ox` so the drawing can be centred afterwards. */
function writePath(segments: Segment[], ox: number): string {
  return segments
    .map((s) => (s.c === 'V' ? `V ${s.y}` : s.c === 'H' ? `H ${s.x + ox}` : `${s.c} ${s.x + ox} ${s.y}`))
    .join(' ');
}

// --- Solving ---------------------------------------------------------------------

interface Lane {
  key: string;
  ids: string[];
  terminusId?: string;
}

interface Raw {
  step: number;
  height: number;
  maxX: number;
  lines: Array<{
    key: string;
    segments: Segment[];
    stations: PlacedStation[];
    caps: Array<{ x: number; y: number }>;
    headingX: number;
    top: number;
  }>;
  hubs: PlacedHub[];
  solo: boolean;
}

type Demand = { demote: string };

const median = <T>(items: T[]): T => items[Math.floor((items.length - 1) / 2)]!;

function solve(lanes: Lane[], inter: LayoutHub[], term: LayoutHub | null, width: number): Raw | Demand {
  const index = new Map(lanes.map((lane, i) => [lane.key, i]));
  const hasHubs = inter.length > 0 || term !== null;

  // One device and nothing shared: a short line with a cap at each end, the stop in the middle.
  if (!hasHubs && lanes.length === 1 && lanes[0]!.ids.length <= 1) {
    const lane = lanes[0]!;
    const top = PAD / 2;
    const y = top + HEADING_HEIGHT + LABEL_ABOVE;
    const cx = Math.floor(width / 2);
    const left = cx - SOLO_HALF;
    const right = cx + SOLO_HALF;
    return {
      step: STEP,
      height: Math.ceil(y + LABEL_BELOW + PAD / 2),
      maxX: right,
      solo: true,
      hubs: [],
      lines: [
        {
          key: lane.key,
          segments: [
            { c: 'M', x: left, y },
            { c: 'H', x: right }
          ],
          stations: lane.ids.map((id) => ({ id, x: cx, y, side: 'below' as const })),
          caps: [
            { x: left, y },
            { x: right, y }
          ],
          headingX: left,
          top
        }
      ]
    };
  }

  // The number of stations per row, the lane positions and the room the interchanges take
  // depend on one another. Fewer stations per row means more rows, which spreads the lanes
  // and widens the zones, so the count only ever goes down; it settles in a few rounds.
  let perRow = Number.MAX_SAFE_INTEGER;
  for (let round = 0; round < 16; round++) {
    const rowsOf = lanes.map((lane) => Math.max(1, Math.ceil(lane.ids.length / perRow)));
    const firstY: number[] = [];
    const tops: number[] = [];
    let cursor = PAD / 2;
    lanes.forEach((_, i) => {
      tops.push(cursor);
      const y = cursor + HEADING_HEIGHT + LABEL_ABOVE;
      firstY.push(y);
      cursor = y + (rowsOf[i]! - 1) * ROW_GAP + LABEL_BELOW + LANE_GAP;
    });
    const lastY = lanes.map((_, i) => firstY[i]! + (rowsOf[i]! - 1) * ROW_GAP);

    // Interchange zones, left to right.
    const zones: Array<{ hub: LayoutHub; members: number[]; y: number; c: number; reach: number }> = [];
    let zoneX = PAD + HEADING_ROOM;
    for (const hub of inter) {
      const members = hub.lineKeys.map((key) => index.get(key)!).sort((a, b) => a - b);
      const y = firstY[median(members)]!;
      const reach = Math.max(...members.map((m) => Math.abs(firstY[m]! - y)));
      zones.push({ hub, members, y, c: zoneX + reach, reach });
      zoneX += 2 * reach + HUB_GAP;
    }
    const firstX = zones.length > 0 ? zoneX : FIRST_X;

    // The terminus: only lines whose last row runs to the right can end on it.
    let exit: { hub: LayoutHub; members: number[]; y: number; reach: number } | null = null;
    if (term) {
      const members = term.lineKeys
        .map((key) => index.get(key)!)
        .filter((m) => rowsOf[m]! % 2 === 1)
        .sort((a, b) => a - b);
      if (members.length < 2) return { demote: term.id };
      const y = lastY[median(members)]!;
      exit = { hub: term, members, y, reach: Math.max(...members.map((m) => Math.abs(lastY[m]! - y))) };
    }

    const rightMost = exit ? width - PAD - LABEL_HALF - TAIL - exit.reach : rightEdge(width);
    if (Math.floor((rightMost - firstX) / STEP) + 1 < 2) {
      // Not even two stops fit beside the shared places: draw the last of them as a plain stop.
      return { demote: exit ? exit.hub.id : inter[inter.length - 1]!.id };
    }
    const next = perRowFor(firstX, rightMost);
    if (round > 0 && next >= perRow) {
      return place({ lanes, rowsOf, firstY, lastY, tops, zones, exit, firstX, rightMost, perRow, width });
    }
    perRow = Math.min(perRow, next);
  }
  throw new Error('transit layout did not settle');
}

function place(input: {
  lanes: Lane[];
  rowsOf: number[];
  firstY: number[];
  lastY: number[];
  tops: number[];
  zones: Array<{ hub: LayoutHub; members: number[]; y: number; c: number; reach: number }>;
  exit: { hub: LayoutHub; members: number[]; y: number; reach: number } | null;
  firstX: number;
  rightMost: number;
  perRow: number;
  width: number;
}): Raw {
  const { lanes, rowsOf, firstY, lastY, tops, zones, exit, firstX, rightMost, perRow } = input;
  const longest = lanes.reduce((most, lane) => Math.max(most, lane.ids.length), 0);
  // When the longest line fits on one row the stops spread to use the width, between STEP and MAX_STEP;
  // otherwise they sit STEP apart and long lines wrap.
  const step =
    longest > 1 && longest <= perRow
      ? Math.min(MAX_STEP, Math.max(STEP, Math.floor((rightMost - firstX) / (longest - 1))))
      : STEP;
  const rightX = firstX + (perRow - 1) * step;
  const leftTurn = firstX - TAIL;
  const rightTurn = rightX + TAIL;

  // Where every lane's last stop ends, to find the terminus.
  const endX = lanes.map((lane, i) => {
    const count = lane.ids.length;
    const inLast = count - (rowsOf[i]! - 1) * perRow;
    return count === 0 ? firstX - HUB_GAP + TAIL : firstX + Math.max(0, inLast - 1) * step + TAIL;
  });
  const exitX = exit ? Math.max(...exit.members.map((m) => endX[m]! + Math.abs(lastY[m]! - exit.y))) : 0;

  let maxX = 0;
  const lines: Raw['lines'] = lanes.map((lane, i) => {
    const count = lane.ids.length;
    const rows = rowsOf[i]!;
    const y0 = firstY[i]!;
    const segments: Segment[] = [
      { c: 'M', x: PAD, y: y0 + RAMP },
      { c: 'L', x: PAD + RAMP, y: y0 }
    ];

    // Out of the lane, through each interchange it serves, and back.
    for (const zone of zones) {
      if (!zone.members.includes(i)) continue;
      const d = Math.abs(y0 - zone.y);
      if (d === 0) continue;
      segments.push({ c: 'H', x: zone.c - d }, { c: 'L', x: zone.c, y: zone.y }, { c: 'L', x: zone.c + d, y: y0 });
    }

    const stations: PlacedStation[] = [];
    for (let row = 0; row < rows; row++) {
      const y = y0 + row * ROW_GAP;
      const forward = row % 2 === 0;
      const inRow = Math.max(0, Math.min(perRow, count - row * perRow));
      for (let k = 0; k < inRow; k++) {
        const at = row * perRow + k;
        stations.push({
          id: lane.ids[at]!,
          x: forward ? firstX + k * step : rightX - k * step,
          y,
          // A lone station takes its label below, clear of the line's heading.
          side: count > 1 && at % 2 === 0 ? 'above' : 'below'
        });
      }
      const dir = forward ? 1 : -1;
      if (row === rows - 1) {
        const span = Math.max(0, inRow - 1) * step;
        const lastX = forward ? firstX + span : rightX - span;
        const toExit = exit !== null && exit.members.includes(i);
        if (toExit) {
          const d = Math.abs(y - exit!.y);
          segments.push({ c: 'H', x: exitX - d });
          if (d > 0) segments.push({ c: 'L', x: exitX, y: exit!.y });
        } else if (lane.terminusId && count > 0) {
          segments.push({ c: 'H', x: lastX });
        } else {
          segments.push({ c: 'H', x: count === 0 ? endX[i]! : lastX + dir * TAIL });
        }
      } else {
        const turnX = forward ? rightTurn : leftTurn;
        segments.push(
          { c: 'H', x: turnX - dir * CHAMFER },
          { c: 'L', x: turnX, y: y + CHAMFER },
          { c: 'V', y: y + ROW_GAP - CHAMFER },
          { c: 'L', x: turnX - dir * CHAMFER, y: y + ROW_GAP }
        );
      }
    }
    for (const s of segments) if (s.c !== 'V') maxX = Math.max(maxX, s.x);
    return { key: lane.key, segments, stations, caps: [], headingX: PAD, top: tops[i]! };
  });

  const hubs: PlacedHub[] = [];
  const sideFor = (members: number[], hubY: number, ys: number[]): 'above' | 'below' =>
    members.every((m) => ys[m]! > hubY) ? 'above' : 'below';
  for (const zone of zones) {
    hubs.push({
      id: zone.hub.id,
      kind: 'interchange',
      x: zone.c,
      y: zone.y,
      side: sideFor(zone.members, zone.y, firstY),
      lineKeys: zone.members.map((m) => lanes[m]!.key)
    });
  }
  if (exit) {
    hubs.push({
      id: exit.hub.id,
      kind: 'terminus',
      x: exitX,
      y: exit.y,
      side: sideFor(exit.members, exit.y, lastY),
      lineKeys: exit.members.map((m) => lanes[m]!.key)
    });
  }

  const bottom = lanes.length === 0 ? PAD : lastY[lanes.length - 1]! + LABEL_BELOW + LANE_GAP;
  return { step, height: Math.ceil(bottom + PAD / 2), maxX, lines, hubs, solo: false };
}

function isDemand(result: Raw | Demand): result is Demand {
  return 'demote' in result;
}

export function layoutTransit(lines: LayoutLine[], width: number, hubs: LayoutHub[] = []): TransitLayout {
  const lanes: Lane[] = lines.map((line) => ({
    key: line.key,
    ids: [...line.stationIds],
    terminusId: line.terminusId
  }));
  const laneOf = new Map(lanes.map((lane) => [lane.key, lane]));

  // A shared place is kept only if it joins two lanes; one terminus per drawing.
  let inter: LayoutHub[] = [];
  let term: LayoutHub | null = null;
  const claimed = new Set<string>();

  /** A place that cannot be drawn as shared becomes a stop on the first lane it serves. */
  const demote = (hub: LayoutHub) => {
    const lane = laneOf.get(hub.lineKeys.find((key) => laneOf.has(key)) ?? '');
    if (!lane) return;
    if (hub.kind === 'interchange') lane.ids.unshift(hub.id);
    else if (lane.terminusId) lane.ids.splice(lane.ids.length - 1, 0, hub.id);
    else {
      lane.ids.push(hub.id);
      lane.terminusId = hub.id;
    }
  };

  for (const hub of hubs) {
    const keys = [...new Set(hub.lineKeys.filter((key) => laneOf.has(key)))];
    const shared = { ...hub, lineKeys: keys };
    if (keys.length < 2) demote(shared);
    else if (hub.kind === 'interchange') inter.push(shared);
    else if (term === null && keys.every((key) => !claimed.has(key))) {
      term = shared;
      keys.forEach((key) => claimed.add(key));
    } else demote(shared);
  }

  let raw: Raw | Demand;
  for (;;) {
    raw = solve(lanes, inter, term, width);
    if (!isDemand(raw)) break;
    const gone = raw.demote;
    if (term?.id === gone) {
      demote(term);
      term = null;
    } else {
      const hub = inter.find((candidate) => candidate.id === gone)!;
      demote(hub);
      inter = inter.filter((candidate) => candidate !== hub);
    }
  }

  // Centre the drawing: the margin left and right is the same.
  const ox = raw.solo ? 0 : Math.max(0, Math.floor((width - (raw.maxX + PAD)) / 2));
  return {
    step: raw.step,
    width,
    height: raw.height,
    hubs: raw.hubs.map((hub) => ({ ...hub, x: hub.x + ox })),
    lines: raw.lines.map((line) => ({
      key: line.key,
      path: writePath(line.segments, ox),
      stations: line.stations.map((station) => ({ ...station, x: station.x + ox })),
      caps: line.caps.map((cap) => ({ x: cap.x + ox, y: cap.y })),
      heading: { x: line.headingX + ox, y: line.top + 16 },
      top: line.top
    }))
  };
}

/** True when every move of a path is horizontal, vertical or at 45 degrees (used by the tests). */
export function isOctilinear(path: string): boolean {
  const tokens = path.trim().split(/\s+/);
  let x = 0;
  let y = 0;
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++]!;
    if (command === 'M') {
      x = Number(tokens[i++]);
      y = Number(tokens[i++]);
    } else if (command === 'L') {
      const nx = Number(tokens[i++]);
      const ny = Number(tokens[i++]);
      const dx = Math.abs(nx - x);
      const dy = Math.abs(ny - y);
      if (!(dx === 0 || dy === 0 || dx === dy)) return false;
      x = nx;
      y = ny;
    } else if (command === 'H') x = Number(tokens[i++]);
    else if (command === 'V') y = Number(tokens[i++]);
    else return false;
  }
  return true;
}
