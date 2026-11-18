import { useEffect, useRef, useState } from 'react';

import { cn } from '../ui/cn';
import { STATION_TONE, StationSymbol, type StationKind } from '../ui/StationSymbol';
import { prefersReducedMotion } from '../ui/motion';
import type { FlowParams } from './liveFlow';
import { pulseTone } from './pulseTone';
import { MAX_PLAYING, currentSpan, detectTransitions, snapshotService } from './transitEvents';
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
  /**
   * Motion of the lines that carried measured traffic, by line key (see liveFlow).
   * A line that is absent does not move: unknown and quiet look the same, still.
   */
  flow?: ReadonlyMap<string, FlowParams>;
  /** Names the diagram for a screen reader. */
  label: string;
  className?: string;
}

const FALLBACK_WIDTH = 880;

/** How long a connection event plays: the current, then the lamp. */
const ON_MS = 950;
const OFF_MS = 700;

interface StationFx {
  id: string;
  kind: 'on' | 'off';
  run: number;
}

// Width of the heading's pieces: the colour bar, its gap, and the gap before the detail.
const HEADING_BAR = 24 + 8;
const HEADING_DETAIL_GAP = 8;

const HEADING_FONT = '600 14px Overpass Variable, Overpass, sans-serif';
const DETAIL_FONT = '400 14px Overpass Variable, Overpass, sans-serif';

let measureContext: CanvasRenderingContext2D | null | undefined;

/** The width of a text in px. Measured on a canvas; where there is none (a test renderer) it is estimated. */
function textWidth(text: string, font: string): number {
  if (measureContext === undefined) {
    try {
      // jsdom has no canvas and complains when asked; the estimate below serves there.
      measureContext = /jsdom/i.test(navigator.userAgent) ? null : document.createElement('canvas').getContext('2d');
    } catch {
      measureContext = null;
    }
  }
  if (measureContext) {
    measureContext.font = font;
    const measured = measureContext.measureText(text).width;
    if (measured > 0) return measured;
  }
  return text.length * 7.8;
}

// The lines are drawn once per page load, the first time the map appears.
let drawnOnce = false;

export function TransitMap({ lines, hubs = [], onOpenStation, flow, label, className }: TransitMapProps) {
  const [frame, width] = useMeasuredWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const [animate] = useState(() => {
    const first = !drawnOnce;
    drawnOnce = true;
    return first;
  });
  const [fontsTick, setFontsTick] = useState(0);
  useEffect(() => {
    // The names are measured in the real face, so measure again when it has loaded.
    void document.fonts?.ready.then(() => setFontsTick((n) => n + 1));
  }, []);
  // `fontsTick` only forces this measure to run again once the face has loaded.
  const headingRoom =
    fontsTick >= 0
      ? Math.ceil(
          Math.max(
            0,
            ...lines.map(
              (line) =>
                HEADING_BAR +
                textWidth(line.heading, HEADING_FONT) +
                (line.detail ? HEADING_DETAIL_GAP + textWidth(line.detail, DETAIL_FONT) : 0)
            )
          ) *
            1.05 +
            4
        )
      : 0;

  const layout = layoutTransit(
    lines.map((line) => ({
      key: line.key,
      stationIds: line.stations.map((station) => station.id),
      terminusId: line.endId
    })),
    width,
    hubs.map((hub) => ({ id: hub.id, kind: hub.kind, lineKeys: hub.lineKeys })),
    { headingRoom }
  );
  const byKey = new Map(lines.map((line) => [line.key, line]));
  // Every stop that can be drawn: those of the lines, and the shared places (which become
  // ordinary stops when there is no room to draw them as shared).
  const everyStation = new Map<string, MapStation>();
  for (const line of lines) for (const station of line.stations) everyStation.set(station.id, station);
  for (const hub of hubs) everyStation.set(hub.id, hub);

  const reduced = prefersReducedMotion();
  const hidden = useDocumentHidden(Boolean(flow?.size));
  const fx = useStationEvents([...everyStation.values()], reduced);
  const fxOf = new Map(fx.map((event) => [event.id, event]));

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
        {!reduced &&
          flow &&
          layout.lines.map((placed) => {
            const params = flow.get(placed.key);
            if (!params) return null;
            return Array.from({ length: params.pulses }, (_, i) => (
              <path
                key={`${placed.key}-flow-${i}`}
                d={placed.path}
                pathLength={1}
                data-flow={placed.key}
                fill="none"
                strokeWidth={4}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="map-flow"
                style={{
                  animationDuration: `${params.durationMs}ms`,
                  animationDelay: `${-Math.round((i * params.durationMs) / params.pulses)}ms`,
                  animationPlayState: hidden ? 'paused' : 'running'
                }}
              />
            ));
          })}
        {fx
          .filter((event) => event.kind === 'on')
          .map((event) => {
            const spot = findSpot(layout, event.id);
            if (!spot) return null;
            const { start, end } = currentSpan(spot.path, spot.others, spot);
            return (
              <path
                key={`current-${event.id}-${event.run}`}
                d={spot.path}
                data-current={event.id}
                fill="none"
                strokeWidth={4}
                strokeLinecap="round"
            const tone = pulseTone(byKey.get(placed.key)!.colour);
                strokeLinejoin="round"
                className="map-current"
                style={
                  {
                    '--from': start === 0 ? 9 : -start,
                    '--to': -Math.max(end - 9, start)
                data-pulse={tone}
                  } as React.CSSProperties
                }
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
              className="absolute flex items-center gap-2 text-body font-semibold text-ink"
              style={{ left: placed.heading.x, top: placed.top, maxWidth: placed.headingMax }}
            >
              <span aria-hidden="true" className={cn('h-1.5 w-6 rounded-pill', LINE_FILL[line.colour])} />
              <span className="min-w-0 truncate" title={line.heading}>
                {line.heading}
              </span>
              {line.detail && (
                <span className="shrink-0 whitespace-nowrap font-normal text-ink-muted">{line.detail}</span>
              )}
            </p>

            {placed.stations.map((spot) => (
              <StationButton
                key={spot.id}
                spot={spot}
                station={everyStation.get(spot.id)!}
                onOpen={onOpenStation}
                fx={fxOf.get(spot.id)}
              />
            ))}
          </div>
        );
      })}

      {layout.hubs.map((spot) => (
        <StationButton
          key={spot.id}
          spot={spot}
          station={everyStation.get(spot.id)!}
          onOpen={onOpenStation}
          fx={fxOf.get(spot.id)}
          shared
        />
      ))}
    </div>
  );
}

function StationButton({
  spot,
  station,
  onOpen,
  fx,
  shared = false
}: {
  spot: { id: string; x: number; y: number; side: 'above' | 'below' };
  station: MapStation;
  onOpen: (id: string) => void;
  /** A connection event playing on this station: its lamp lights, or it dims. */
  fx?: StationFx;
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
      {fx?.kind === 'on' && (
        <>
          <span aria-hidden="true" className="map-glow" key={`glow-${fx.run}`} />
          <span aria-hidden="true" className="map-spark" key={`spark-${fx.run}`} />
        </>
      )}
      <span
        data-fx={fx?.kind}
        className={cn(
          'relative flex h-6 w-6 items-center justify-center rounded-full bg-sheet',
          fx?.kind === 'on' && 'map-lamp-on',
          fx?.kind === 'off' && 'map-lamp-off'
        )}
      >
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

/** Where a station is drawn, with the path of its line and the other stops on it. */
function findSpot(layout: ReturnType<typeof layoutTransit>, id: string) {
  for (const placed of layout.lines) {
    const spot = placed.stations.find((station) => station.id === id);
    if (spot) {
      return { x: spot.x, y: spot.y, path: placed.path, others: placed.stations.filter((o) => o.id !== id) };
    }
  }
  const hub = layout.hubs.find((candidate) => candidate.id === id);
  const placed = hub && layout.lines.find((line) => line.key === hub.lineKeys[0]);
  if (hub && placed) return { x: hub.x, y: hub.y, path: placed.path, others: placed.stations };
  return null;
}

/** True while the page is in a background tab, so motion can stop. Only listens when `watch` is set. */
function useDocumentHidden(watch: boolean): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    if (!watch) return;
    const update = () => setHidden(document.hidden);
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [watch]);
  return hidden;
}

/**
 * Compares each refresh with the one before and plays an event for every station
 * that came into service (a current, then the lamp) or left it (a dim). Nothing
 * plays on the first render or under reduced motion; at most MAX_PLAYING lamps
 * run at once and the rest wait their turn.
 */
function useStationEvents(stations: MapStation[], reduced: boolean): StationFx[] {
  const previous = useRef<Map<string, boolean> | null>(null);
  const queue = useRef<StationFx[]>([]);
  const playing = useRef<StationFx[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Set<number>());
  const [shown, setShown] = useState<StationFx[]>([]);

  const pump = useRef(() => {});
  pump.current = () => {
    let changed = false;
    while (queue.current.length > 0 && playing.current.filter((e) => e.kind === 'on').length < MAX_PLAYING) {
      const next = queue.current.shift()!;
      playing.current = [...playing.current.filter((e) => e.id !== next.id), next];
      changed = true;
      const timer = window.setTimeout(
        () => {
          timers.current.delete(timer);
          playing.current = playing.current.filter((e) => e !== next);
          setShown(playing.current);
          pump.current();
        },
        next.kind === 'on' ? ON_MS : OFF_MS
      );
      timers.current.add(timer);
    }
    if (changed) setShown(playing.current);
  };

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current.clear();
    },
    []
  );

  useEffect(() => {
    const now = snapshotService(stations);
    const changes = detectTransitions(previous.current, now);
    previous.current = now;
    if (reduced || (changes.online.length === 0 && changes.offline.length === 0)) return;
    const make = (id: string, kind: 'on' | 'off'): StationFx => ({ id, kind, run: ++counter.current });
    queue.current.push(...changes.offline.map((id) => make(id, 'off')), ...changes.online.map((id) => make(id, 'on')));
    pump.current();
  });

  return shown;
}
