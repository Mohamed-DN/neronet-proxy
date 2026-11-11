import { useCallback, useEffect, useRef } from 'react';
import type { TopologyLink, TopologyNode } from '../../../services/types';
import type { GroupGeometry, LinkState, NodeKind, NodeState, Point, ViewTransform } from '../topologyGraph';
import { LINK_DASH, LINK_WIDTH, LinkMark, NodeShape } from './glyphs';

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 8;
export const ZOOM_STEP = 1.25;
// Pointer travel, in viewBox units, past which a press is a drag rather than a click.
const MOVE_EPS = 3;

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

export interface DrawnNode {
  node: TopologyNode;
  x: number;
  y: number;
  kind: NodeKind;
  state: NodeState;
  dimmed: boolean;
  match: boolean;
  selected: boolean;
  focused: boolean;
  showLabel: boolean;
  groupColor: number;
}

export interface DrawnLink {
  key: string;
  link: TopologyLink;
  state: LinkState;
  a: Point;
  b: Point;
  /** "A — B", the pair as people read it. */
  label: string;
  strong: boolean;
  faded: boolean;
  selected: boolean;
}

export interface DrawnGroup {
  geometry: GroupGeometry;
  folded: boolean;
  label: string;
  bubbleLabel: string;
  problems: string;
}

interface MeshMapProps {
  frame: Frame;
  view: ViewTransform;
  animate: boolean;
  /** Scene units per screen pixel at the current zoom. */
  unit: number;
  hullPad: number;
  groups: DrawnGroup[];
  links: DrawnLink[];
  nodes: DrawnNode[];
  selectedLabel: { x: number; y: number; name: string; detail: string } | null;
  bindCanvas: (element: SVGSVGElement | null) => void;
  onView: (update: (view: ViewTransform) => ViewTransform, animate: boolean) => void;
  onSelectNode: (id: string) => void;
  onSelectLink: (link: TopologyLink) => void;
  onClear: () => void;
  onMoveNode: (id: string, point: Point) => void;
  onOpenGroup: (key: string) => void;
}

type Interaction =
  | { kind: 'pan'; start: Point; startTx: number; startTy: number; moved: boolean }
  | { kind: 'node'; nodeId: string; grab: Point; moved: boolean }
  | null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Scale the view by `factor` while keeping the scene point under `center` pinned. */
export function zoomAt(view: ViewTransform, center: Point, factor: number): ViewTransform {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const applied = scale / view.scale;
  return { scale, tx: center.x - applied * (center.x - view.tx), ty: center.y - applied * (center.y - view.ty) };
}

/** A gentle curve between two devices, trimmed so it stops at their outlines. */
function curve(a: Point, b: Point, inset: number): { d: string; mid: Point; angle: number } | null {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= inset * 2) return null;
  const t = inset / length;
  const bend = Math.min(18, length * 0.06);
  const qx = (a.x + b.x) / 2 - (dy / length) * bend,
    qy = (a.y + b.y) / 2 + (dx / length) * bend;
  const sx = a.x + dx * t,
    sy = a.y + dy * t,
    ex = b.x - dx * t,
    ey = b.y - dy * t;
  return {
    d: `M ${sx} ${sy} Q ${qx} ${qy} ${ex} ${ey}`,
    // The point at t = 0.5 on the quadratic.
    mid: { x: 0.25 * sx + 0.5 * qx + 0.25 * ex, y: 0.25 * sy + 0.5 * qy + 0.25 * ey },
    angle: (Math.atan2(dy, dx) * 180) / Math.PI
  };
}

function hullPath(points: Point[]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  return `M ${first!.x} ${first!.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(' ')}${points.length > 2 ? ' Z' : ''}`;
}

/**
 * The drawing. It is aria-hidden: the device list beside it carries the same
 * content for keyboards and screen readers, so the picture never holds focus.
 */
export function MeshMap({
  frame,
  view,
  animate,
  unit,
  hullPad,
  groups,
  links,
  nodes,
  selectedLabel,
  bindCanvas,
  onView,
  onSelectNode,
  onSelectLink,
  onClear,
  onMoveNode,
  onOpenGroup
}: MeshMapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const sceneRef = useRef<SVGGElement | null>(null);
  const interactionRef = useRef<Interaction>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const bind = useCallback(
    (element: SVGSVGElement | null) => {
      svgRef.current = element;
      bindCanvas(element);
    },
    [bindCanvas]
  );

  const toViewBox = useCallback((clientX: number, clientY: number): Point | null => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }, []);

  const toScene = useCallback((clientX: number, clientY: number): Point | null => {
    const ctm = sceneRef.current?.getScreenCTM();
    if (!ctm) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }, []);

  const handleMove = useCallback(
    (event: PointerEvent) => {
      const it = interactionRef.current;
      if (!it) return;
      if (it.kind === 'pan') {
        const point = toViewBox(event.clientX, event.clientY);
        if (!point) return;
        const dx = point.x - it.start.x,
          dy = point.y - it.start.y;
        if (Math.abs(dx) > MOVE_EPS || Math.abs(dy) > MOVE_EPS) it.moved = true;
        if (it.moved) onView((current) => ({ ...current, tx: it.startTx + dx, ty: it.startTy + dy }), false);
      } else {
        const point = toScene(event.clientX, event.clientY);
        if (!point) return;
        it.moved = true;
        onMoveNode(it.nodeId, { x: point.x - it.grab.x, y: point.y - it.grab.y });
      }
    },
    [toViewBox, toScene, onView, onMoveNode]
  );

  const handleUp = useCallback(() => {
    const it = interactionRef.current;
    interactionRef.current = null;
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    if (!it || it.moved) return;
    if (it.kind === 'node') onSelectNode(it.nodeId);
    else onClear();
  }, [handleMove, onSelectNode, onClear]);

  const begin = (interaction: Interaction) => {
    interactionRef.current = interaction;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    },
    [handleMove, handleUp]
  );

  // Native, non-passive wheel listener so zooming does not scroll the page.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = toViewBox(event.clientX, event.clientY);
      if (!point) return;
      onView((current) => zoomAt(current, point, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), false);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [toViewBox, onView]);

  const r = 6.5 * unit;
  const inset = r * 1.5;

  return (
    <svg
      ref={bind}
      data-mesh-canvas
      viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`}
      className="mesh-canvas"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const point = toViewBox(event.clientX, event.clientY);
        if (!point) return;
        begin({ kind: 'pan', start: point, startTx: view.tx, startTy: view.ty, moved: false });
      }}
    >
      <g
        ref={sceneRef}
        transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}
        className={animate ? 'mesh-scene mesh-scene--animate' : 'mesh-scene'}
      >
        {groups.map(({ geometry, folded }) =>
          folded ? null : (
            <g key={`hull-${geometry.key}`} className={`mesh-hull mesh-community-${geometry.color}`}>
              {geometry.hull.length === 1 ? (
                <circle cx={geometry.hull[0]!.x} cy={geometry.hull[0]!.y} r={hullPad} />
              ) : (
                <path d={hullPath(geometry.hull)} strokeWidth={hullPad * 2} />
              )}
            </g>
          )
        )}
        {groups.map(({ geometry, folded, label }) => {
          if (folded) return null;
          const top = Math.min(...geometry.hull.map((point) => point.y)) - hullPad - 8 * unit;
          return (
            <text
              key={`label-${geometry.key}`}
              x={geometry.cx}
              y={top}
              textAnchor="middle"
              className="mesh-group-label"
              style={{ fontSize: 12 * unit }}
            >
              {label}
            </text>
          );
        })}

        {links.map((drawn) => {
          const shape = curve(drawn.a, drawn.b, inset);
          if (!shape) return null;
          return (
            <g
              key={drawn.key}
              data-mesh-link={drawn.state}
              data-label={drawn.label}
              className="mesh-link"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onSelectLink(drawn.link)}
            >
              <path d={shape.d} className="mesh-link-hit" strokeWidth={12 * unit} />
              <path
                d={shape.d}
                className={`mesh-link-line mesh-link--${drawn.state}${drawn.selected ? ' mesh-link--selected' : ''}`}
                strokeWidth={LINK_WIDTH[drawn.state] + (drawn.strong || drawn.selected ? 0.75 : 0)}
                strokeDasharray={LINK_DASH[drawn.state]}
                vectorEffect="non-scaling-stroke"
                opacity={drawn.faded ? 0.15 : 1}
              />
              {!drawn.faded && (
                <LinkMark state={drawn.state} x={shape.mid.x} y={shape.mid.y} unit={unit} angle={shape.angle} />
              )}
            </g>
          );
        })}

        {groups.map(({ geometry, folded, bubbleLabel, problems }) => {
          if (!folded) return null;
          const radius = (16 + 3 * Math.sqrt(geometry.count)) * unit;
          return (
            <g
              key={`bubble-${geometry.key}`}
              data-mesh-bubble={geometry.key}
              className={`mesh-bubble mesh-community-${geometry.color}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onOpenGroup(geometry.key)}
            >
              <circle cx={geometry.cx} cy={geometry.cy} r={radius} />
              <text
                x={geometry.cx}
                y={geometry.cy + 6 * unit}
                textAnchor="middle"
                className="mesh-bubble-count"
                style={{ fontSize: 17 * unit }}
              >
                {geometry.count}
              </text>
              <text
                x={geometry.cx}
                y={geometry.cy + radius + 16 * unit}
                textAnchor="middle"
                className="mesh-group-label"
                style={{ fontSize: 12 * unit }}
              >
                {bubbleLabel}
              </text>
              {problems && (
                <text
                  x={geometry.cx}
                  y={geometry.cy + radius + 31 * unit}
                  textAnchor="middle"
                  className="mesh-bubble-problems"
                  style={{ fontSize: 11 * unit }}
                >
                  {problems}
                </text>
              )}
            </g>
          );
        })}

        {nodes.map((drawn) => (
          <g
            key={drawn.node.id}
            data-node-id={drawn.node.id}
            data-selected={drawn.selected ? 'true' : undefined}
            data-match={drawn.match ? 'true' : undefined}
            className={`mesh-node${drawn.dimmed ? ' mesh-node--dimmed' : ''}`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              const point = toScene(event.clientX, event.clientY);
              begin({
                kind: 'node',
                nodeId: drawn.node.id,
                grab: point ? { x: point.x - drawn.x, y: point.y - drawn.y } : { x: 0, y: 0 },
                moved: false
              });
            }}
          >
            {(drawn.selected || drawn.match) && (
              <circle
                cx={drawn.x}
                cy={drawn.y}
                r={r + 5 * unit}
                className={drawn.selected ? 'mesh-ring mesh-ring--selected' : 'mesh-ring mesh-ring--match'}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {drawn.focused && (
              <circle
                cx={drawn.x}
                cy={drawn.y}
                r={r + 9 * unit}
                className="mesh-ring mesh-ring--focus"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <NodeShape kind={drawn.kind} state={drawn.state} x={drawn.x} y={drawn.y} r={r} />
            <circle cx={drawn.x} cy={drawn.y} r={Math.max(r * 2.2, 12 * unit)} className="mesh-node-hit" />
            {drawn.showLabel && !drawn.selected && (
              <text
                x={drawn.x}
                y={drawn.y + r + 15 * unit}
                textAnchor="middle"
                className="mesh-node-label"
                style={{ fontSize: 12 * unit }}
              >
                {(drawn.node.name || drawn.node.id).slice(0, 28)}
              </text>
            )}
          </g>
        ))}

        {selectedLabel && (
          // Painted last so neighbouring devices never cover it.
          <g data-selected-label className="mesh-node-label-group">
            <text
              x={selectedLabel.x}
              y={selectedLabel.y + r + 15 * unit}
              textAnchor="middle"
              className="mesh-node-label mesh-node-label--strong"
              style={{ fontSize: 13 * unit }}
            >
              {selectedLabel.name}
            </text>
            <text
              x={selectedLabel.x}
              y={selectedLabel.y + r + 30 * unit}
              textAnchor="middle"
              className="mesh-node-label mesh-node-label--detail"
              style={{ fontSize: 11 * unit }}
            >
              {selectedLabel.detail}
            </text>
          </g>
        )}
      </g>
    </svg>
  );
}
