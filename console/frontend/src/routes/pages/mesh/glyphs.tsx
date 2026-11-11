import type { LinkState, NodeKind, NodeState } from '../topologyGraph';

/*
 * The map's two vocabularies: a shape per kind of device and a line per state of a
 * link. Colour repeats what the shape, dash and mark already say, so nothing on the
 * map depends on telling two colours apart.
 */

/** Dash pattern per link state, in screen pixels (strokes are non-scaling). */
export const LINK_DASH: Record<LinkState, string | undefined> = {
  unmeasured: undefined,
  direct: undefined,
  relayed: '7 4',
  offline: '2 6',
  quarantined: '1 2.5',
  blocked: '5 4'
};

export const LINK_WIDTH: Record<LinkState, number> = {
  unmeasured: 1,
  direct: 2.25,
  relayed: 2.25,
  offline: 1.25,
  quarantined: 2,
  blocked: 1.75
};

/** The outline of one device shape centred on (x, y), `r` in scene units. */
export function shapePath(kind: NodeKind, x: number, y: number, r: number): string {
  if (kind === 'gateway') {
    const d = r * 1.3;
    return `M ${x} ${y - d} L ${x + d} ${y} L ${x} ${y + d} L ${x - d} ${y} Z`;
  }
  if (kind === 'profile') {
    const s = r * 0.9;
    return `M ${x - s} ${y - s} H ${x + s} V ${y + s} H ${x - s} Z`;
  }
  return `M ${x - r} ${y} A ${r} ${r} 0 1 0 ${x + r} ${y} A ${r} ${r} 0 1 0 ${x - r} ${y} Z`;
}

interface NodeShapeProps {
  kind: NodeKind;
  state: NodeState;
  x: number;
  y: number;
  r: number;
}

/** One device: its kind's shape, filled and stroked by its state; isolated adds a bar. */
export function NodeShape({ kind, state, x, y, r }: NodeShapeProps) {
  return (
    <>
      <path d={shapePath(kind, x, y, r)} className={`mesh-node-shape mesh-node--${state}`} />
      {state === 'quarantined' && (
        <path
          d={`M ${x - r * 0.75} ${y + r * 0.75} L ${x + r * 0.75} ${y - r * 0.75}`}
          className="mesh-node-bar"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </>
  );
}

/** A small inline sample of a device shape for the legend and lists. */
export function KindSample({ kind, state = 'online' }: { kind: NodeKind; state?: NodeState }) {
  return (
    <svg className="mesh-sample" width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true" focusable="false">
      <NodeShape kind={kind} state={state} x={0} y={0} r={5} />
    </svg>
  );
}

/** A short inline sample of a link line, with its mid mark. */
export function LinkSample({ state }: { state: LinkState }) {
  return (
    <svg className="mesh-sample" width="28" height="12" viewBox="0 0 28 12" aria-hidden="true" focusable="false">
      <path
        d="M 1 6 H 27"
        className={`mesh-link-line mesh-link--${state}`}
        strokeWidth={LINK_WIDTH[state]}
        strokeDasharray={LINK_DASH[state]}
      />
      <LinkMark state={state} x={14} y={6} unit={1} angle={0} />
    </svg>
  );
}

/**
 * The mark at a link's midpoint: a small ring for a relayed path, a double bar for a
 * pair a rule blocks. `unit` converts screen pixels to scene units.
 */
export function LinkMark({
  state,
  x,
  y,
  unit,
  angle
}: {
  state: LinkState;
  x: number;
  y: number;
  unit: number;
  angle: number;
}) {
  if (state === 'relayed')
    return <circle cx={x} cy={y} r={3 * unit} className="mesh-link-mark mesh-link-mark--relayed" />;
  if (state === 'blocked') {
    const s = 4 * unit,
      g = 1.8 * unit;
    return (
      <g transform={`rotate(${angle} ${x} ${y})`} className="mesh-link-mark mesh-link-mark--blocked">
        <path d={`M ${x - g} ${y - s} L ${x - g} ${y + s} M ${x + g} ${y - s} L ${x + g} ${y + s}`} />
      </g>
    );
  }
  return null;
}
