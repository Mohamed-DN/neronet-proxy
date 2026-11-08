import type { TopologyLink, TopologyNode } from '../../services/types';

export type GroupBy = 'compartment' | 'country' | 'role' | 'none';
export interface PlacedNode {
  node: TopologyNode;
  x: number;
  y: number;
}
export interface Community {
  key: string;
  label: string;
  color: number;
  cx: number;
  cy: number;
  r: number;
  count: number;
  expanded: boolean;
  unhealthy: number;
  quarantined: number;
}

export function groupValue(node: TopologyNode, groupBy: GroupBy): { key: string; label: string } {
  if (groupBy === 'compartment') return { key: node.compartment_id || '__none__', label: node.compartment_name || '' };
  if (groupBy === 'country')
    return { key: node.country?.toUpperCase() || '__none__', label: node.country?.toUpperCase() || '' };
  if (groupBy === 'role') return { key: node.role || '__none__', label: node.role || '' };
  return { key: '__all__', label: '' };
}

function seed(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

/** A bounded, deterministic settling pass, never a live physics simulation.
 * Only inventory identity and grouping affect positions, not metrics, API order,
 * search or visibility. Communities describe inventory, never security inference.
 */
export function communityLayout(
  nodes: TopologyNode[],
  groupBy: GroupBy,
  otherLabel: string,
  expansion: Record<string, boolean>,
  revealMatches: boolean
): { placed: PlacedNode[]; clusters: Community[] } {
  const groups = new Map<string, { label: string; members: TopologyNode[] }>();
  for (const node of nodes) {
    const { key, label } = groupValue(node, groupBy);
    const group = groups.get(key) ?? { label: label || otherLabel, members: [] };
    group.members.push(node);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort();
  const clusters: Community[] = [];
  const placed: PlacedNode[] = [];
  keys.forEach((key, index) => {
    const group = groups.get(key)!;
    const members = [...group.members].sort((a, b) => a.id.localeCompare(b.id));
    const single = keys.length === 1;
    const r = single
      ? 285
      : Math.max(30, Math.min(140, Math.sqrt(440000 / keys.length) / 2.8)) * (0.9 + seed(key + ':radius') * 0.2);
    const cx = single ? 600 : 180 + seed(key + ':community-x') * 840;
    const cy = single ? 320 : 130 + seed(key + ':community-y') * 380;
    const expanded = revealMatches || (expansion[key] ?? members.length <= 16);
    clusters.push({
      key,
      label: group.label,
      color: index % 8,
      cx,
      cy,
      r,
      count: members.length,
      expanded,
      unhealthy: members.filter((node) => !node.is_healthy && !node.is_quarantined).length,
      quarantined: members.filter((node) => node.is_quarantined).length
    });
    if (!expanded) return;
    // Beyond this size the overview is folded by default. Explicit expansion is
    // still bounded: spatial cells limit the quadratic settling pass to 80 nodes.
    const points = members.map((node) => ({
      node,
      x: (seed(node.id) - 0.5) * r * 1.4,
      y: (seed(node.id + ':y') - 0.5) * r * 1.4
    }));
    if (points.length <= 80) {
      const spacing = single
        ? Math.min(210, 600 / Math.sqrt(points.length))
        : Math.min(95, (r * 1.6) / Math.sqrt(points.length));
      for (let pass = 0; pass < 72; pass++) {
        for (let a = 0; a < points.length; a++)
          for (let b = a + 1; b < points.length; b++) {
            const first = points[a]!,
              second = points[b]!;
            const dx = second.x - first.x || 0.01,
              dy = second.y - first.y || 0.01;
            const distance = Math.hypot(dx, dy);
            if (distance >= spacing) continue;
            const shift = Math.min(8, (spacing - distance) * 0.3);
            first.x -= (dx / distance) * shift;
            first.y -= (dy / distance) * shift;
            second.x += (dx / distance) * shift;
            second.y += (dy / distance) * shift;
          }
        for (const point of points) {
          const distance = Math.hypot(point.x, point.y);
          if (distance > r * 0.85) {
            point.x *= (r * 0.85) / distance;
            point.y *= (r * 0.85) / distance;
          }
        }
      }
    }
    for (const point of points)
      placed.push({ node: point.node, x: cx + point.x * (single ? 1.6 : 1), y: cy + point.y });
  });
  // Seeded irregular centers settle once into separated communities. They are
  // never pinned to rows, rings, or an invented central transit node.
  if (clusters.length > 1 && clusters.length <= 100) {
    const origins = new Map(clusters.map((group) => [group.key, { x: group.cx, y: group.cy }]));
    for (let pass = 0; pass < 96; pass++) {
      for (let a = 0; a < clusters.length; a++)
        for (let b = a + 1; b < clusters.length; b++) {
          const first = clusters[a]!,
            second = clusters[b]!;
          const dx = second.cx - first.cx || 0.01,
            dy = second.cy - first.cy || 0.01;
          const distance = Math.hypot(dx, dy),
            required = first.r + second.r + 26;
          if (distance >= required) continue;
          const shift = (required - distance) * 0.4;
          first.cx -= (dx / distance) * shift;
          first.cy -= (dy / distance) * shift;
          second.cx += (dx / distance) * shift;
          second.cy += (dy / distance) * shift;
        }
      for (const group of clusters) {
        group.cx = Math.max(group.r + 60, Math.min(1140 - group.r, group.cx + (600 - group.cx) * 0.004));
        group.cy = Math.max(group.r + 40, Math.min(600 - group.r, group.cy + (320 - group.cy) * 0.004));
      }
    }
    const byKey = new Map(clusters.map((group) => [group.key, group]));
    for (const point of placed) {
      const key = groupValue(point.node, groupBy).key,
        original = origins.get(key)!,
        group = byKey.get(key)!;
      point.x += group.cx - original.x;
      point.y += group.cy - original.y;
    }
  }
  return { placed, clusters };
}

/** A deterministic spanning forest first, then context edges up to the budget.
 * This is only a visual subset of allowed policy pairs, never observed traffic.
 */
export function policyOverview(links: TopologyLink[], budget = 160): Set<TopologyLink> {
  const ordered = links
    .filter((link) => link.is_visible !== false)
    .sort(
      (a, b) =>
        seed(a.source + ':' + a.target) - seed(b.source + ':' + b.target) ||
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target)
    );
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    let current = id;
    while (parent.has(current) && parent.get(current) !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const result = new Set<TopologyLink>();
  for (const link of ordered) {
    const first = find(link.source),
      second = find(link.target);
    if (first === second) continue;
    parent.set(first, second);
    result.add(link);
    if (result.size >= budget) return result;
  }
  for (const link of ordered) {
    if (result.size >= budget) break;
    result.add(link);
  }
  return result;
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
