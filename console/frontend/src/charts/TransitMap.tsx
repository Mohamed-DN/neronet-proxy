import { useState } from 'react';

import { cn } from '../ui/cn';
import { STATION_TONE, StationSymbol, type StationKind } from '../ui/StationSymbol';
import { useMeasuredWidth } from './useMeasuredWidth';
import { layoutTransit } from './transitLayout';
import './TransitMap.css';

/*
 * The network drawn as a transit diagram: sub-networks as coloured lines,
 * devices as stations on them. The lines are an SVG, because they are lines; the
 * stations are real buttons laid over it, because a station is something you
 * focus and open. Labels are horizontal, in ink. All words come in as props and
 * the geometry comes from `layoutTransit`.
 */

const LINE_STROKE = {
  red: 'stroke-line-red',
  green: 'stroke-line-green',
  blue: 'stroke-line-blue',
  orange: 'stroke-line-orange',
  violet: 'stroke-line-violet',
  sky: 'stroke-line-sky'
} as const;

const LINE_FILL = {
  red: 'bg-line-red',
  green: 'bg-line-green',
  blue: 'bg-line-blue',
  orange: 'bg-line-orange',
  violet: 'bg-line-violet',
  sky: 'bg-line-sky'
} as const;

export type MapLineColour = keyof typeof LINE_STROKE;

export interface MapStation {
  id: string;
  /** The label drawn beside the stop. */
  label: string;
  symbol: StationKind;
  /** Colour class for the symbol: a status token, or ink while in service. */
  tone?: string;
  /** What a screen reader says: the name, the kind of stop and its status in words. */
  description: string;
}

export interface MapLine {
  key: string;
  heading: string;
  /** Muted words after the heading, such as the device count. */
  detail?: string;
  colour: MapLineColour;
  stations: MapStation[];
  /** The id of an exit, last in `stations`, that this line ends on. */
  endId?: string;
}

/** A gateway or exit several lines share: drawn once, with each of those lines through it. */
export interface MapHub extends MapStation {
  kind: 'interchange' | 'terminus';
  /** The lines it serves, by key. */
  lineKeys: string[];
}

export interface TransitMapProps {
  lines: MapLine[];
  hubs?: MapHub[];
  onOpenStation: (id: string) => void;
  /** Names the diagram for a screen reader. */
  label: string;
  className?: string;
}

const FALLBACK_WIDTH = 880;

// The lines are drawn once per page load, the first time the map appears.
let drawnOnce = false;

export function TransitMap({ lines, hubs = [], onOpenStation, label, className }: TransitMapProps) {
  const [frame, width] = useMeasuredWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const [animate] = useState(() => {
    const first = !drawnOnce;
    drawnOnce = true;
    return first;
  });

  const layout = layoutTransit(
    lines.map((line) => ({
      key: line.key,
      stationIds: line.stations.map((station) => station.id),
      terminusId: line.endId
    })),
    width,
    hubs.map((hub) => ({ id: hub.id, kind: hub.kind, lineKeys: hub.lineKeys }))
  );
  const byKey = new Map(lines.map((line) => [line.key, line]));
  // Every stop that can be drawn: those of the lines, and the shared places (which become
  // ordinary stops when there is no room to draw them as shared).
  const everyStation = new Map<string, MapStation>();
  for (const line of lines) for (const station of line.stations) everyStation.set(station.id, station);
  for (const hub of hubs) everyStation.set(hub.id, hub);

  return (
    <div
      ref={frame}
      role="group"
      aria-label={label}
      data-testid="transit-map"
      className={cn('relative w-full', className)}
      style={{ height: layout.height }}
    >
      <svg
        width={width}
        height={layout.height}
        viewBox={`0 0 ${width} ${layout.height}`}
        aria-hidden="true"
        focusable="false"
        className="absolute inset-0"
      >
        {layout.lines.map((placed) => {
          const line = byKey.get(placed.key)!;
          return (
            <path
              key={placed.key}
              d={placed.path}
              pathLength={1}
              data-line={placed.key}
              fill="none"
              strokeWidth={7}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn(LINE_STROKE[line.colour], animate && 'transit-line-draw')}
            />
          );
        })}
        {layout.lines.flatMap((placed) =>
          placed.caps.map((cap, k) => (
            <path
              key={`${placed.key}-cap-${k}`}
              d={`M ${cap.x} ${cap.y - 12} V ${cap.y + 12}`}
              data-cap={placed.key}
              fill="none"
              strokeWidth={5}
              strokeLinecap="butt"
              className={LINE_STROKE[byKey.get(placed.key)!.colour]}
            />
          ))
        )}
      </svg>

      {layout.lines.map((placed) => {
        const line = byKey.get(placed.key)!;
        return (
          <div key={placed.key}>
            <p
              className="absolute flex max-w-[190px] items-center gap-2 text-body font-semibold text-ink"
              style={{ left: placed.heading.x, top: placed.top }}
            >
              <span aria-hidden="true" className={cn('h-1.5 w-6 rounded-pill', LINE_FILL[line.colour])} />
              <span className="min-w-0 truncate">{line.heading}</span>
              {line.detail && (
                <span className="shrink-0 whitespace-nowrap font-normal text-ink-muted">{line.detail}</span>
              )}
            </p>

            {placed.stations.map((spot) => (
              <StationButton key={spot.id} spot={spot} station={everyStation.get(spot.id)!} onOpen={onOpenStation} />
            ))}
          </div>
        );
      })}

      {layout.hubs.map((spot) => (
        <StationButton key={spot.id} spot={spot} station={everyStation.get(spot.id)!} onOpen={onOpenStation} shared />
      ))}
    </div>
  );
}

function StationButton({
  spot,
  station,
  onOpen,
  shared = false
}: {
  spot: { id: string; x: number; y: number; side: 'above' | 'below' };
  station: MapStation;
  onOpen: (id: string) => void;
  /** An interchange or terminus several lines share: its label gets a sheet-coloured plate so the lines behind it do not cut the words. */
  shared?: boolean;
}) {
  return (
    <button
      type="button"
      data-station-id={spot.id}
      data-shared={shared || undefined}
      aria-label={station.description}
      title={station.description}
      onClick={() => onOpen(spot.id)}
      className="absolute flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-focus"
      style={{ left: spot.x, top: spot.y }}
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sheet">
        <StationSymbol kind={station.symbol} size={shared ? 22 : 18} className={station.tone ?? 'text-ink'} />
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-1/2 -translate-x-1/2 text-center text-caption text-ink',
          shared ? 'max-w-[140px] truncate rounded-control bg-sheet px-1.5' : 'w-[140px] truncate',
          spot.side === 'above' ? 'bottom-full mb-0.5' : 'top-full mt-0.5'
        )}
      >
        {station.label}
      </span>
    </button>
  );
}

/** The symbol colour a status uses on the map: a token for trouble, ink when all is well. */
export function mapTone(kind: StationKind): string | undefined {
  return kind === 'blocked' || kind === 'interrupted' || kind === 'unmeasured' ? STATION_TONE[kind] : undefined;
}
