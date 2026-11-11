import { describe, expect, it } from 'vitest';
import type { TopologyLink, TopologyNode } from '../../services/types';
import {
  centerOn,
  convexHull,
  cullLabels,
  denseByDefault,
  groupFolded,
  layoutMesh,
  linkState,
  nodeKind,
  nodeState,
  policyNeighborhood,
  searchNodes,
  type Point
} from './topologyGraph';

function device(index: number, overrides: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id: `fixture-${index}`,
    name: `Fixture ${index}`,
    role: 'CLIENT_ORIGIN',
    country: 'IT',
    overlay_ipv4: `100.64.0.${index + 1}`,
    is_healthy: true,
    is_quarantined: false,
    latency_ms: null,
    compartment_id: `community-${index % 3}`,
    compartment_name: `Community ${index % 3}`,
    is_ghost_vault: false,
    ...overrides
  };
}

const twelve = Array.from({ length: 12 }, (_, index) => device(index));

function fleet(count: number, groups: number[]): TopologyNode[] {
  const nodes: TopologyNode[] = [];
  let index = 0;
  groups.forEach((size, group) => {
    for (let member = 0; member < size && nodes.length < count; member++) {
      nodes.push(device(index++, { compartment_id: `g-${group}`, compartment_name: `Group ${group}` }));
    }
  });
  return nodes;
}

function chords(nodes: TopologyNode[], count: number): TopologyLink[] {
  const links: TopologyLink[] = [];
  for (let k = 0; k < count; k++) {
    const a = (k * 7919) % nodes.length;
    const b = (k * 104729 + 13) % nodes.length;
    if (a !== b) links.push({ source: nodes[a]!.id, target: nodes[b]!.id });
  }
  return links;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe('layoutMesh: a seeded force layout that stands still', () => {
  it('returns the same coordinates whatever the API order or the measured values', () => {
    const links = chords(twelve, 20);
    const first = layoutMesh(twelve, links, 'compartment', { otherLabel: 'Other' });
    const refresh = layoutMesh(
      [...twelve].reverse().map((node) => ({ ...node, latency_ms: 21, is_healthy: false })),
      [...links].reverse(),
      'compartment',
      { otherLabel: 'Other' }
    );
    for (const node of twelve) expect(refresh.positions.get(node.id)).toEqual(first.positions.get(node.id));
    expect(refresh.groups).toEqual(first.groups.map((group) => ({ ...group, unhealthy: group.count })));
    expect(new Set(first.groups.map((group) => group.color)).size).toBe(3);
  });

  it('keeps every known device in place when a device joins or leaves', () => {
    const first = layoutMesh(twelve, [], 'compartment', { otherLabel: 'Other' });
    const joined = [...twelve, device(12, { compartment_id: 'community-1', compartment_name: 'Community 1' })];
    const after = layoutMesh(joined, [], 'compartment', { otherLabel: 'Other', previous: first.positions });
    for (const node of twelve) expect(after.positions.get(node.id)).toEqual(first.positions.get(node.id));
    const newcomer = after.positions.get('fixture-12')!;
    const home = after.groups.find((group) => group.key === 'community-1')!;
    expect(distance(newcomer, { x: home.cx, y: home.cy })).toBeLessThanOrEqual(home.r);
    for (const node of twelve) expect(distance(newcomer, after.positions.get(node.id)!)).toBeGreaterThan(20);

    const left = layoutMesh(twelve.slice(1), [], 'compartment', { otherLabel: 'Other', previous: first.positions });
    for (const node of twelve.slice(1)) expect(left.positions.get(node.id)).toEqual(first.positions.get(node.id));
  });

  it('places a brand-new group outside the groups already on the map', () => {
    const first = layoutMesh(twelve, [], 'compartment', { otherLabel: 'Other' });
    const arrivals = [0, 1, 2].map((k) => device(20 + k, { compartment_id: 'community-new', compartment_name: 'New' }));
    const after = layoutMesh([...twelve, ...arrivals], [], 'compartment', {
      otherLabel: 'Other',
      previous: first.positions
    });
    const fresh = after.groups.find((group) => group.key === 'community-new')!;
    for (const group of after.groups.filter((other) => other.key !== 'community-new'))
      expect(distance({ x: fresh.cx, y: fresh.cy }, { x: group.cx, y: group.cy })).toBeGreaterThan(fresh.r + group.r);
  });

  it('spreads 300 devices in five groups without overlap, in bounded time', () => {
    const nodes = fleet(300, [120, 80, 14, 46, 40]);
    const links = chords(nodes, 900);
    const started = performance.now();
    const layout = layoutMesh(nodes, links, 'compartment', { otherLabel: 'Other' });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(layout.positions.size).toBe(300);
    const points = [...layout.positions.values()];
    let closest = Infinity;
    for (let a = 0; a < points.length; a++)
      for (let b = a + 1; b < points.length; b++) closest = Math.min(closest, distance(points[a]!, points[b]!));
    expect(closest).toBeGreaterThan(18);
    for (let a = 0; a < layout.groups.length; a++)
      for (let b = a + 1; b < layout.groups.length; b++) {
        const first = layout.groups[a]!,
          second = layout.groups[b]!;
        expect(distance({ x: first.cx, y: first.cy }, { x: second.cx, y: second.cy })).toBeGreaterThan(
          first.r + second.r
        );
      }
    expect(layout.groups.reduce((sum, group) => sum + group.count, 0)).toBe(300);
    for (const group of layout.groups) expect(group.hull.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps one lone device at the origin with a round hull', () => {
    const layout = layoutMesh([device(0)], [], 'compartment', { otherLabel: 'Other' });
    expect(layout.positions.get('fixture-0')).toEqual({ x: 0, y: 0 });
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]!.hull).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('convexHull', () => {
  it('keeps only the outer corners in a stable order', () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 0 }
    ]);
    expect(hull).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]);
  });
  it('returns the points themselves when there are fewer than three', () => {
    expect(convexHull([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }]);
    expect(convexHull([])).toEqual([]);
  });
});

describe('honest state', () => {
  const now = Date.parse('2026-11-11T10:00:00Z');

  it('tells gateways and exits from profile devices and ordinary devices', () => {
    expect(nodeKind(device(0, { role: 'EXIT_BRIDGE' }))).toBe('gateway');
    expect(nodeKind(device(0, { role: 'RELAY' }))).toBe('gateway');
    expect(nodeKind(device(0, { is_profile_gateway: true }))).toBe('gateway');
    expect(nodeKind(device(0, { device_kind: 'profile' }))).toBe('profile');
    expect(nodeKind(device(0, { role: 'HYBRID' }))).toBe('device');
    expect(nodeKind(device(0))).toBe('device');
  });

  it('separates isolated, switched off, struggling, working and unmeasured devices', () => {
    expect(nodeState(device(0, { is_quarantined: true, is_healthy: false }), now)).toBe('quarantined');
    expect(nodeState(device(0, { last_seen_at: '2026-11-11T09:40:00Z' }), now)).toBe('offline');
    expect(nodeState(device(0, { last_seen_at: '2026-11-11T09:59:30Z' }), now)).toBe('online');
    expect(nodeState(device(0, { is_healthy: false }), now)).toBe('degraded');
    // A static profile peer never reports in: that is unknown, not healthy and not off.
    expect(nodeState(device(0, { device_kind: 'profile', last_seen_at: null }), now)).toBe('unmeasured');
    expect(nodeState(device(0), now)).toBe('online');
  });

  it('reads measured transport only, never the configured mode', () => {
    const a = device(0),
      b = device(1);
    const states = [
      linkState({ source: a.id, target: b.id, is_visible: false }, a, b, now),
      linkState({ source: a.id, target: b.id }, { ...a, is_quarantined: true }, b, now),
      linkState({ source: a.id, target: b.id }, a, { ...b, last_seen_at: '2026-11-10T00:00:00Z' }, now),
      linkState({ source: a.id, target: b.id, transport: 'derp' }, a, b, now),
      linkState({ source: a.id, target: b.id, transport: 'relayed' }, a, b, now),
      linkState({ source: a.id, target: b.id, transport: 'direct' }, a, b, now),
      linkState({ source: a.id, target: b.id, mode: 'direct' }, a, b, now),
      linkState({ source: a.id, target: b.id, mode: 'derp' }, a, b, now)
    ];
    expect(states).toEqual([
      'blocked',
      'quarantined',
      'offline',
      'relayed',
      'relayed',
      'direct',
      'unmeasured',
      'unmeasured'
    ]);
  });

  it('starts dense meshes with exceptions only and sparse ones with every line', () => {
    expect(denseByDefault(12, 66)).toBe(true);
    expect(denseByDefault(300, 900)).toBe(false);
    expect(denseByDefault(300, 1200)).toBe(true);
    expect(denseByDefault(4, 3)).toBe(false);
    expect(denseByDefault(2, 1)).toBe(false);
  });
});

describe('reading the map at any size', () => {
  it('folds a large group when zoomed out, unless a search or the operator says otherwise', () => {
    expect(groupFolded(120, 1, undefined, false)).toBe(true);
    expect(groupFolded(120, 1.6, undefined, false)).toBe(false);
    expect(groupFolded(14, 0.5, undefined, false)).toBe(false);
    expect(groupFolded(120, 1, false, false)).toBe(false);
    expect(groupFolded(14, 3, true, false)).toBe(true);
    expect(groupFolded(120, 1, undefined, true)).toBe(false);
    expect(groupFolded(14, 3, true, true)).toBe(false);
  });

  it('drops labels that would overlap, keeping the most important first', () => {
    const kept = cullLabels([
      { id: 'b', x: 0, y: 0, width: 80, height: 14, priority: 0 },
      { id: 'selected', x: 10, y: 4, width: 80, height: 14, priority: 3 },
      { id: 'far', x: 300, y: 0, width: 80, height: 14, priority: 0 },
      { id: 'a', x: 0, y: 40, width: 80, height: 14, priority: 0 }
    ]);
    expect([...kept].sort()).toEqual(['a', 'far', 'selected']);
  });

  it('ranks search results by name first, then address, and caps the list', () => {
    const nodes = [
      device(0, { name: 'laptop-roma' }),
      device(1, { name: 'Roma gateway' }),
      device(2, { name: 'nas', overlay_ipv4: '100.64.9.9' }),
      ...Array.from({ length: 12 }, (_, k) => device(10 + k, { name: `roma-${k}` }))
    ];
    // Ties break on the lower-cased name by code point, so the order never depends on the browser locale.
    expect(searchNodes(nodes, 'roma', 3).map((node) => node.name)).toEqual(['Roma gateway', 'roma-0', 'roma-1']);
    expect(searchNodes(nodes, 'roma', 20).at(-1)!.name).toBe('laptop-roma');
    expect(searchNodes(nodes, 'Roma g').map((node) => node.name)).toEqual(['Roma gateway']);
    expect(searchNodes(nodes, '100.64.9').map((node) => node.name)).toEqual(['nas']);
    expect(searchNodes(nodes, '  ')).toEqual([]);
  });

  it('centres a scene point in the frame at the requested scale', () => {
    const view = centerOn({ x: 100, y: 50 }, { cx: 0, cy: 0 }, 2);
    expect(view).toEqual({ scale: 2, tx: -200, ty: -100 });
  });
});

describe('policyNeighborhood', () => {
  it('explores exactly one or two policy hops and never traverses denied pairs', () => {
    const links = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' },
      { source: 'a', target: 'secret', is_visible: false }
    ];
    expect([...policyNeighborhood('a', links, 1)].sort()).toEqual(['a', 'b']);
    expect([...policyNeighborhood('a', links, 2)].sort()).toEqual(['a', 'b', 'c']);
  });
});
