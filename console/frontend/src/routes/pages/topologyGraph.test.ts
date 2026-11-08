import { describe, expect, it } from 'vitest';
import type { TopologyNode } from '../../services/types';
import { communityLayout, policyNeighborhood, policyOverview } from './topologyGraph';

const nodes = Array.from({ length: 12 }, (_, index) => ({
  id: `fixture-${index}`,
  name: `Fixture ${index}`,
  role: 'RELAY',
  country: 'IT',
  overlay_ipv4: null,
  is_healthy: true,
  is_quarantined: false,
  latency_ms: null,
  compartment_id: `community-${index % 3}`,
  compartment_name: `Community ${index % 3}`,
  is_ghost_vault: false
})) satisfies TopologyNode[];

describe('Graphify-inspired community model (synthetic fixtures)', () => {
  it('keeps a bounded connected policy overview with deterministic edge selection', () => {
    const chain = Array.from({ length: 99 }, (_, index) => ({ source: `n-${index}`, target: `n-${index + 1}` }));
    const chords = Array.from({ length: 200 }, (_, index) => ({
      source: `n-${index % 100}`,
      target: `n-${(index + 13) % 100}`
    }));
    const links = [...chain, ...chords, { source: 'secret', target: 'n-0', is_visible: false }];
    const overview = [...policyOverview(links)];
    expect(overview).toHaveLength(160);
    const connected = new Set(['n-0']);
    for (let pass = 0; pass < 100; pass++)
      for (const link of overview) {
        if (connected.has(link.source)) connected.add(link.target);
        if (connected.has(link.target)) connected.add(link.source);
      }
    expect(connected.size).toBe(100);
    expect(connected.has('secret')).toBe(false);
    expect([...policyOverview([...links].reverse())]).toEqual(overview);
  });
  it('keeps identities in the same place when refresh order and measurements change', () => {
    const initial = communityLayout(nodes, 'compartment', 'Other', {}, false);
    const refresh = communityLayout(
      [...nodes].reverse().map((n) => ({ ...n, latency_ms: 21 })),
      'compartment',
      'Other',
      {},
      false
    );
    expect(refresh.placed.map(({ node, x, y }) => ({ id: node.id, x, y }))).toEqual(
      initial.placed.map(({ node, x, y }) => ({ id: node.id, x, y }))
    );
    expect(refresh.clusters).toEqual(initial.clusters);
    expect(new Set(initial.clusters.map((group) => group.color)).size).toBe(3);
  });

  it('uses a bounded aggregate overview for 1000 synthetic peers', () => {
    const fleet = Array.from({ length: 1000 }, (_, index) => ({ ...nodes[index % 12]!, id: `scale-${index}` }));
    const layout = communityLayout(fleet, 'compartment', 'Other', {}, false);
    expect(layout.placed).toHaveLength(0);
    expect(layout.clusters.reduce((sum, group) => sum + group.count, 0)).toBe(1000);
    expect(layout.clusters).toHaveLength(3);
  });

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
