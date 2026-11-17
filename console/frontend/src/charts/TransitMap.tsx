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
}

export interface TransitMapProps {
  lines: MapLine[];
  onOpenStation: (id: string) => void;
  /** Names the diagram for a screen reader. */
  label: string;
  className?: string;
}

const FALLBACK_WIDTH = 880;

// The lines are drawn once per page load, the first time the map appears.
let drawnOnce = false;

export function TransitMap({ lines, onOpenStation, label, className }: TransitMapProps) {
  const [frame, width] = useMeasuredWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const [animate] = useState(() => {
    const first = !drawnOnce;
    drawnOnce = true;
    return first;
  });

  const layout = layoutTransit(
    lines.map((line) => ({ key: line.key, stationIds: line.stations.map((station) => station.id) })),
    width
  );
  const byKey = new Map(lines.map((line) => [line.key, line]));

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
      </svg>

      {layout.lines.map((placed) => {
        const line = byKey.get(placed.key)!;
        const stations = new Map(line.stations.map((station) => [station.id, station]));
        return (
          <div key={placed.key}>
            <p
              className="absolute flex items-center gap-2 text-body font-semibold text-ink"
              style={{ left: placed.heading.x, top: placed.top }}
            >
              <span aria-hidden="true" className={cn('h-1.5 w-6 rounded-pill', LINE_FILL[line.colour])} />
              <span>{line.heading}</span>
              {line.detail && <span className="font-normal text-ink-muted">{line.detail}</span>}
            </p>

            {placed.stations.map((spot) => {
              const station = stations.get(spot.id)!;
              return (
                <button
                  key={spot.id}
                  type="button"
                  data-station-id={spot.id}
                  aria-label={station.description}
                  title={station.description}
                  onClick={() => onOpenStation(spot.id)}
                  className="absolute flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-focus"
                  style={{ left: spot.x, top: spot.y }}
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sheet">
                    <StationSymbol kind={station.symbol} size={18} className={station.tone ?? 'text-ink'} />
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute left-1/2 w-[140px] -translate-x-1/2 truncate text-center text-caption text-ink',
                      spot.side === 'above' ? 'bottom-full mb-0.5' : 'top-full mt-0.5'
                    )}
                  >
                    {station.label}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** The symbol colour a status uses on the map: a token for trouble, ink when all is well. */
export function mapTone(kind: StationKind): string | undefined {
  return kind === 'blocked' || kind === 'interrupted' || kind === 'unmeasured' ? STATION_TONE[kind] : undefined;
}
