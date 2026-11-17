/*
 * The geometry of the network as a transit diagram, and nothing else: it takes
 * lines with their stations and returns where everything goes. It is a pure
 * function of its input and the drawn width, so the picture is the same on every
 * refresh and can be tested without a browser.
 *
 * Every segment is horizontal, vertical or at exactly 45 degrees. A line starts
 * with a 45-degree ramp, runs along a row of stations, and wraps at the end of
 * the row with two 45-degree chamfers and a vertical, then runs back on the next
 * row (a boustrophedon), so a long line never needs a diagonal that is not 45.
 * Labels sit above and below the line in turn, and are always horizontal.
 */

export interface LayoutLine {
  key: string;
  stationIds: string[];
}

export interface PlacedStation {
  id: string;
  x: number;
  y: number;
  /** Whether the label sits above or below the line. Alternates, so neighbours get twice the room. */
  side: 'above' | 'below';
}

export interface PlacedLine {
  key: string;
  /** The SVG path of the line: M, L, H and V commands only. */
  path: string;
  stations: PlacedStation[];
  /** Where the lane's heading (the line's name) goes: left edge, text baseline. */
  heading: { x: number; y: number };
  /** Top of the lane. */
  top: number;
}

export interface TransitLayout {
  width: number;
  height: number;
  lines: PlacedLine[];
}

export const PAD = 20;
/** Horizontal run of the starting 45-degree ramp, which is also its rise. */
export const RAMP = 14;
/** Distance between two stations along a row. */
export const STEP = 76;
/** Distance between two rows of one line. */
export const ROW_GAP = 76;
/** Chamfer size at a wrap. */
export const CHAMFER = 12;
/** Line run past the last station of a row before it turns or ends. */
export const TAIL = 28;

const HEADING_HEIGHT = 26;
// Room for a label above the first row of a lane, and below the last.
const LABEL_ABOVE = 26;
const LABEL_BELOW = 30;
const LANE_GAP = 14;

/** The x of the first station of a row, leaving room for the ramp. */
export const FIRST_X = PAD + RAMP + 28;

/** How many stations fit on one row of a drawing `width` pixels wide. */
export function stationsPerRow(width: number): number {
  const room = width - FIRST_X - (TAIL + CHAMFER + PAD);
  return Math.max(2, Math.floor(room / STEP) + 1);
}

export function layoutTransit(lines: LayoutLine[], width: number): TransitLayout {
  const perRow = stationsPerRow(width);
  const rightX = FIRST_X + (perRow - 1) * STEP;
  const leftTurn = FIRST_X - TAIL;
  const rightTurn = rightX + TAIL;

  let top = PAD / 2;
  const placed: PlacedLine[] = [];

  for (const line of lines) {
    const count = line.stationIds.length;
    const rows = Math.max(1, Math.ceil(count / perRow));
    const firstY = top + HEADING_HEIGHT + LABEL_ABOVE;
    const stations: PlacedStation[] = [];

    let path = `M ${PAD} ${firstY + RAMP} L ${PAD + RAMP} ${firstY}`;
    for (let row = 0; row < rows; row++) {
      const y = firstY + row * ROW_GAP;
      const forward = row % 2 === 0;
      const inRow = Math.max(0, Math.min(perRow, count - row * perRow));
      for (let k = 0; k < inRow; k++) {
        const index = row * perRow + k;
        stations.push({
          id: line.stationIds[index]!,
          x: forward ? FIRST_X + k * STEP : rightX - k * STEP,
          y,
          side: index % 2 === 0 ? 'above' : 'below'
        });
      }
      const dir = forward ? 1 : -1;
      if (row === rows - 1) {
        const span = Math.max(0, inRow - 1) * STEP;
        const lastX = forward ? FIRST_X + span : rightX - span;
        path += ` H ${lastX + dir * TAIL}`;
      } else {
        const turnX = forward ? rightTurn : leftTurn;
        path += ` H ${turnX - dir * CHAMFER} L ${turnX} ${y + CHAMFER} V ${y + ROW_GAP - CHAMFER}`;
        path += ` L ${turnX - dir * CHAMFER} ${y + ROW_GAP}`;
      }
    }

    placed.push({ key: line.key, path, stations, heading: { x: PAD, y: top + 16 }, top });
    top = firstY + (rows - 1) * ROW_GAP + LABEL_BELOW + LANE_GAP;
  }

  return { width, height: Math.ceil(top + PAD / 2), lines: placed };
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
