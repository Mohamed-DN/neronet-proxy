import type { TopologyLink, TopologyNode } from '../../services/types';

/*
 * The network map's model: where each device sits, what state it and each of its
 * links are in, and what the map can afford to draw. Everything here is a pure
 * function of the inventory, so the page can be tested without a browser and the
 * picture is the same on every refresh.
 */

export type GroupBy = 'compartment' | 'country' | 'role' | 'none';

export interface Point {
  x: number;
  y: number;
}

export interface GroupGeometry {
  key: string;
  label: string;
  /** Index into the eight categorical hull tints, by sorted key. */
  color: number;
  count: number;
  cx: number;
  cy: number;
  /** Radius of the circle that holds every member, padding included. */
  r: number;
  /** Convex hull of the members, the outline the soft hull is drawn around. */
  hull: Point[];
  unhealthy: number;
  quarantined: number;
}

export interface MeshLayout {
  positions: Map<string, Point>;
  groups: GroupGeometry[];
}

/** Distance, in scene units, the layout keeps between neighbouring devices. */
export const SPACING = 44;
/** Groups larger than this fold into a bubble when the map is zoomed out. */
export const FOLD_MIN = 24;
/** Zoom at which a large group opens on its own. */
export const UNFOLD_SCALE = 1.6;
/** A device last heard from longer ago than this is shown as switched off. */
export const OFFLINE_AFTER_MS = 3 * 60 * 1000;

const GROUP_GAP = 40;
const HULL_PAD = SPACING * 0.6;
const PHYLLO = SPACING / Math.sqrt(Math.PI);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export function groupValue(node: TopologyNode, groupBy: GroupBy): { key: string; label: string } {
  if (groupBy === 'compartment') return { key: node.compartment_id || '__none__', label: node.compartment_name || '' };
  if (groupBy === 'country')
    return { key: node.country?.toUpperCase() || '__none__', label: node.country?.toUpperCase() || '' };
  if (groupBy === 'role') return { key: node.role || '__none__', label: node.role || '' };
  return { key: '__all__', label: '' };
}

/** A stable number in [0, 1) for a string: the layout's only source of "randomness". */
function seed(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Buckets points in square cells so neighbour queries stay linear at 1000 devices. */
class SpatialGrid {
  private cells = new Map<string, Point[]>();
  constructor(private size: number) {}
  private key(x: number, y: number) {
    return `${Math.floor(x / this.size)}:${Math.floor(y / this.size)}`;
  }
  add(point: Point) {
    const key = this.key(point.x, point.y);
    const cell = this.cells.get(key);
    if (cell) cell.push(point);
    else this.cells.set(key, [point]);
  }
  /** True when no stored point is closer than `min` to (x, y). */
  free(x: number, y: number, min: number): boolean {
    const cx = Math.floor(x / this.size),
      cy = Math.floor(y / this.size);
    const reach = Math.ceil(min / this.size);
    for (let i = cx - reach; i <= cx + reach; i++)
      for (let j = cy - reach; j <= cy + reach; j++)
        for (const point of this.cells.get(`${i}:${j}`) ?? [])
          if (Math.hypot(point.x - x, point.y - y) < min) return false;
    return true;
  }
}

/**
 * One group on its own, centred on the origin: a sunflower disc in a seeded order,
 * then a short force pass. Springs pull linked devices together only when the group
 * is sparse; in a full mesh every pair pulls equally and would carry no information.
 */
function layoutGroup(members: TopologyNode[], links: TopologyLink[]): Map<string, Point> {
  const ordered = [...members].sort((a, b) => seed(a.id) - seed(b.id) || byCodePoint(a.id, b.id));
  const points = ordered.map((node, k) => {
    if (ordered.length === 1) return { id: node.id, x: 0, y: 0 };
    const radius = PHYLLO * Math.sqrt(k + 0.5);
    return { id: node.id, x: Math.cos(k * GOLDEN) * radius, y: Math.sin(k * GOLDEN) * radius };
  });
  const index = new Map(points.map((point, k) => [point.id, k]));
  const springs = links
    .map((link) => [index.get(link.source), index.get(link.target)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined);
  const useSprings = springs.length > 0 && springs.length <= members.length * 3;
  const iterations = members.length > 150 ? 40 : 80;

  for (let pass = 0; pass < iterations && points.length > 1; pass++) {
    const cooling = 1 - pass / iterations;
    if (useSprings)
      for (const [a, b] of springs) {
        const first = points[a]!,
          second = points[b]!;
        const dx = second.x - first.x,
          dy = second.y - first.y;
        const length = Math.hypot(dx, dy) || 1;
        const pull = ((length - SPACING * 1.15) / length) * 0.04 * cooling;
        first.x += dx * pull;
        first.y += dy * pull;
        second.x -= dx * pull;
        second.y -= dy * pull;
      }
    // Collision pass on a grid: only pairs closer than SPACING push each other.
    const cells = new Map<string, number[]>();
    points.forEach((point, k) => {
      const key = `${Math.floor(point.x / SPACING)}:${Math.floor(point.y / SPACING)}`;
      const cell = cells.get(key);
      if (cell) cell.push(k);
      else cells.set(key, [k]);
    });
    points.forEach((point, k) => {
      const cx = Math.floor(point.x / SPACING),
        cy = Math.floor(point.y / SPACING);
      for (let i = cx - 1; i <= cx + 1; i++)
        for (let j = cy - 1; j <= cy + 1; j++)
          for (const other of cells.get(`${i}:${j}`) ?? []) {
            if (other <= k) continue;
            const second = points[other]!;
            let dx = second.x - point.x,
              dy = second.y - point.y;
            let length = Math.hypot(dx, dy);
            if (length >= SPACING) continue;
            if (length < 0.01) {
              dx = seed(point.id + second.id) - 0.5;
              dy = 0.5 - seed(second.id + point.id);
              length = Math.hypot(dx, dy) || 1;
            }
            const push = ((SPACING - length) / length) * 0.5;
            point.x -= dx * push;
            point.y -= dy * push;
            second.x += dx * push;
            second.y += dy * push;
          }
    });
    for (const point of points) {
      point.x *= 0.997;
      point.y *= 0.997;
    }
  }
  const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  return new Map(points.map((point) => [point.id, { x: point.x - cx, y: point.y - cy }]));
}

function radiusOf(points: Point[], cx: number, cy: number): number {
  return points.reduce((max, point) => Math.max(max, Math.hypot(point.x - cx, point.y - cy)), 0) + HULL_PAD;
}

/**
 * The first spot along a widening ellipse around `origin` where a circle of `r`
 * clears every circle already placed. Wider than tall because the map is.
 */
function spiralPlace(
  r: number,
  placed: Array<{ cx: number; cy: number; r: number }>,
  origin: Point,
  start: number
): Point {
  for (let step = 0; step < 20000; step++) {
    const angle = start + step * 0.31;
    const reach = step * 4;
    const x = origin.x + Math.cos(angle) * reach * 1.35;
    const y = origin.y + Math.sin(angle) * reach;
    if (placed.every((other) => Math.hypot(other.cx - x, other.cy - y) >= other.r + r + GROUP_GAP)) return { x, y };
  }
  return { x: origin.x, y: origin.y };
}

/** Monotone chain: the outer corners, counter-clockwise from the lowest x. */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points.map((point) => ({ x: point.x, y: point.y }));
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map((point) => ({ x: point.x, y: point.y }));
}

/**
 * Positions for every device, grouped. With `previous`, devices that already have a
 * place keep it exactly: a newcomer takes the first free slot by its group, a new
 * group is placed clear of the others, and nothing that was on screen moves.
 * Only identity and grouping matter; metrics, health and API order never do.
 */
export function layoutMesh(
  nodes: TopologyNode[],
  links: TopologyLink[],
  groupBy: GroupBy,
  options: { otherLabel: string; previous?: Map<string, Point> }
): MeshLayout {
  // Sorted inputs: float sums and the spring order must not depend on API order.
  const sortedNodes = [...nodes].sort((a, b) => byCodePoint(a.id, b.id));
  const sortedLinks = [...links].sort((a, b) => byCodePoint(a.source, b.source) || byCodePoint(a.target, b.target));
  const groups = new Map<string, { label: string; members: TopologyNode[] }>();
  for (const node of sortedNodes) {
    const { key, label } = groupValue(node, groupBy);
    const group = groups.get(key) ?? { label: label || options.otherLabel, members: [] };
    group.members.push(node);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort(byCodePoint);
  const groupOf = new Map(nodes.map((node) => [node.id, groupValue(node, groupBy).key]));
  const linksByGroup = new Map<string, TopologyLink[]>();
  for (const link of sortedLinks) {
    const key = groupOf.get(link.source);
    if (!key || key !== groupOf.get(link.target)) continue;
    const list = linksByGroup.get(key);
    if (list) list.push(link);
    else linksByGroup.set(key, [link]);
  }

  const positions = new Map<string, Point>();
  const previous = options.previous;
  const known = previous ? sortedNodes.filter((node) => previous.has(node.id)) : [];

  if (known.length === 0) {
    // Fresh: largest group in the middle, the rest packed around it.
    const placed: Array<{ cx: number; cy: number; r: number }> = [];
    const order = [...keys].sort(
      (a, b) => groups.get(b)!.members.length - groups.get(a)!.members.length || byCodePoint(a, b)
    );
    for (const key of order) {
      const local = layoutGroup(groups.get(key)!.members, linksByGroup.get(key) ?? []);
      const r = radiusOf([...local.values()], 0, 0);
      const centre =
        placed.length === 0 ? { x: 0, y: 0 } : spiralPlace(r, placed, { x: 0, y: 0 }, seed(key) * 2 * Math.PI);
      placed.push({ cx: centre.x, cy: centre.y, r });
      for (const [id, point] of local) positions.set(id, { x: point.x + centre.x, y: point.y + centre.y });
    }
  } else {
    for (const node of known) positions.set(node.id, { ...previous!.get(node.id)! });
    const grid = new SpatialGrid(SPACING);
    for (const point of positions.values()) grid.add(point);
    const circles = keys
      .map((key) => {
        const members = groups.get(key)!.members.filter((node) => positions.has(node.id));
        if (members.length === 0) return null;
        const points = members.map((node) => positions.get(node.id)!);
        const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
        const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
        return { key, cx, cy, r: radiusOf(points, cx, cy) };
      })
      .filter((circle): circle is { key: string; cx: number; cy: number; r: number } => circle !== null);
    const all = [...positions.values()];
    const middle = {
      x: all.reduce((sum, point) => sum + point.x, 0) / all.length,
      y: all.reduce((sum, point) => sum + point.y, 0) / all.length
    };
    for (const key of keys) {
      const members = groups.get(key)!.members;
      const fresh = members
        .filter((node) => !positions.has(node.id))
        .sort((a, b) => seed(a.id) - seed(b.id) || byCodePoint(a.id, b.id));
      if (fresh.length === 0) continue;
      const home = circles.find((circle) => circle.key === key);
      if (home) {
        let k = 0;
        for (const node of fresh) {
          for (; ; k++) {
            const radius = PHYLLO * Math.sqrt(k + 0.5);
            const x = home.cx + Math.cos(k * GOLDEN) * radius;
            const y = home.cy + Math.sin(k * GOLDEN) * radius;
            if (grid.free(x, y, SPACING * 0.9)) {
              const point = { x, y };
              positions.set(node.id, point);
              grid.add(point);
              break;
            }
          }
        }
      } else {
        const local = layoutGroup(fresh, linksByGroup.get(key) ?? []);
        const r = radiusOf([...local.values()], 0, 0);
        const centre = spiralPlace(r, circles, middle, seed(key) * 2 * Math.PI);
        circles.push({ key, cx: centre.x, cy: centre.y, r });
        for (const [id, point] of local) {
          const placed = { x: point.x + centre.x, y: point.y + centre.y };
          positions.set(id, placed);
          grid.add(placed);
        }
      }
    }
  }

  const geometry = keys.map((key, index) => {
    const group = groups.get(key)!;
    const points = group.members.map((node) => positions.get(node.id)!);
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    return {
      key,
      label: group.label,
      color: index % 8,
      count: group.members.length,
      cx,
      cy,
      r: radiusOf(points, cx, cy),
      hull: convexHull(points),
      unhealthy: group.members.filter((node) => !node.is_healthy && !node.is_quarantined).length,
      quarantined: group.members.filter((node) => node.is_quarantined).length
    };
  });
  return { positions, groups: geometry };
}

// --- State ------------------------------------------------------------------

export type NodeKind = 'device' | 'profile' | 'gateway';
export type NodeState = 'online' | 'degraded' | 'offline' | 'quarantined' | 'unmeasured';
export type LinkState = 'direct' | 'relayed' | 'unmeasured' | 'offline' | 'quarantined' | 'blocked';

export const NODE_KINDS: NodeKind[] = ['device', 'profile', 'gateway'];
export const LINK_STATES: LinkState[] = ['unmeasured', 'direct', 'relayed', 'offline', 'quarantined', 'blocked'];

/**
 * Gateways, exits and relays carry other devices' traffic; a profile device is a
 * static WireGuard peer (wg-quick) that reaches the mesh through a gateway.
 */
export function nodeKind(node: TopologyNode): NodeKind {
  if (node.is_profile_gateway === true || node.role === 'EXIT_BRIDGE' || node.role === 'RELAY') return 'gateway';
  if (node.device_kind === 'profile') return 'profile';
  return 'device';
}

/** Milliseconds since the device was last heard from, or null when nothing reports it. */
export function lastSeenAge(node: TopologyNode, now: number): number | null {
  if (typeof node.last_seen_at !== 'string') return null;
  const at = Date.parse(node.last_seen_at);
  return Number.isNaN(at) ? null : Math.max(0, now - at);
}

export function nodeState(node: TopologyNode, now: number): NodeState {
  if (node.is_quarantined) return 'quarantined';
  const age = lastSeenAge(node, now);
  if (age !== null && age > OFFLINE_AFTER_MS) return 'offline';
  // A static profile peer never reports in. Its stored health flag is the value it
  // was created with, so without a sighting its state is unknown.
  if (age === null && node.device_kind === 'profile') return 'unmeasured';
  if (!node.is_healthy) return 'degraded';
  return 'online';
}

/**
 * The state of one permitted pair. Only a measured `transport` says direct or
 * relayed; `mode` is a configured preference nothing in the data plane reads.
 */
export function linkState(
  link: TopologyLink,
  a: TopologyNode | undefined,
  b: TopologyNode | undefined,
  now: number
): LinkState {
  if (link.is_visible === false) return 'blocked';
  if (a?.is_quarantined || b?.is_quarantined) return 'quarantined';
  if ((a && nodeState(a, now) === 'offline') || (b && nodeState(b, now) === 'offline')) return 'offline';
  const transport = typeof link.transport === 'string' ? link.transport.toLowerCase() : '';
  if (transport === 'relayed' || transport === 'derp' || transport === 'relay') return 'relayed';
  if (transport === 'direct') return 'direct';
  return 'unmeasured';
}

/**
 * True when the permitted-but-unmeasured lines would only draw a full mesh: more
 * than three per device or more than half of every possible pair. Those meshes
 * open with the exceptions only.
 */
export function denseByDefault(nodeCount: number, permitted: number): boolean {
  if (nodeCount <= 6) return false;
  const pairs = (nodeCount * (nodeCount - 1)) / 2;
  return permitted > nodeCount * 3 || permitted > pairs * 0.5;
}

/**
 * Whether a group draws as a bubble. A search match or a selection inside it always
 * opens it; otherwise the operator's choice wins over size and zoom.
 */
export function groupFolded(count: number, scale: number, override: boolean | undefined, revealed: boolean): boolean {
  if (revealed) return false;
  if (override !== undefined) return override;
  return count > FOLD_MIN && scale < UNFOLD_SCALE;
}

export interface LabelBox {
  id: string;
  /** Centre x and top y, in screen units. */
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
}

/** Greedy placement: most important first, any label that would overlap is dropped. */
export function cullLabels(labels: LabelBox[]): Set<string> {
  const order = [...labels].sort((a, b) => b.priority - a.priority || byCodePoint(a.id, b.id));
  const kept: LabelBox[] = [];
  for (const label of order) {
    const clear = kept.every(
      (other) =>
        Math.abs(other.x - label.x) * 2 >= other.width + label.width ||
        label.y >= other.y + other.height ||
        other.y >= label.y + label.height
    );
    if (clear) kept.push(label);
  }
  return new Set(kept.map((label) => label.id));
}

/** Name before address before id; exact and prefix matches first. */
export function searchNodes(nodes: TopologyNode[], query: string, limit = 8): TopologyNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rank = (node: TopologyNode): number => {
    const name = (node.name || '').toLowerCase();
    const ip = (node.overlay_ipv4 || '').toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.split(/[\s\-_.]+/).some((word) => word.startsWith(q))) return 2;
    if (name.includes(q)) return 3;
    if (ip.startsWith(q)) return 4;
    if (ip.includes(q) || node.id.toLowerCase().includes(q)) return 5;
    return -1;
  };
  return nodes
    .map((node) => ({ node, score: rank(node) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (a, b) =>
        a.score - b.score ||
        byCodePoint((a.node.name || '').toLowerCase(), (b.node.name || '').toLowerCase()) ||
        byCodePoint(a.node.id, b.node.id)
    )
    .slice(0, limit)
    .map((entry) => entry.node);
}

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** The camera that shows scene point `point` at the frame centre at `scale`. */
export function centerOn(point: Point, frame: { cx: number; cy: number }, scale: number): ViewTransform {
  return { scale, tx: frame.cx - scale * point.x, ty: frame.cy - scale * point.y };
}

/** Reachability in the supplied policy graph, not an installed or observed route. */
export function policyNeighborhood(id: string, links: TopologyLink[], hops: 1 | 2): Set<string> {
  const result = new Set([id]);
  let frontier = new Set([id]);
  for (let step = 0; step < hops; step++) {
    const next = new Set<string>();
    for (const link of links) {
      if (link.is_visible === false) continue;
      if (frontier.has(link.source) && !result.has(link.target)) next.add(link.target);
      if (frontier.has(link.target) && !result.has(link.source)) next.add(link.source);
    }
    for (const peer of next) result.add(peer);
    frontier = next;
  }
  return result;
}
