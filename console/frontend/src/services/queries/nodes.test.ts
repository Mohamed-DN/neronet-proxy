import { describe, expect, it } from 'vitest';

import type { MeshNode } from '../types';
import { fleetCounts, isReachable, LIVENESS_WINDOW_MS } from './nodes';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');

function node(partial: Partial<MeshNode>): MeshNode {
  return { id: 'n', ...partial };
}

describe('isReachable', () => {
  it('is false for a node the control plane has never heard from', () => {
    expect(isReachable(node({ last_heartbeat: null }), NOW)).toBe(false);
    expect(isReachable(node({}), NOW)).toBe(false);
  });

  it('is true inside the liveness window and false outside it', () => {
    const inside = new Date(NOW - LIVENESS_WINDOW_MS + 1_000).toISOString();
    const outside = new Date(NOW - LIVENESS_WINDOW_MS - 1_000).toISOString();
    expect(isReachable(node({ last_heartbeat: inside }), NOW)).toBe(true);
    expect(isReachable(node({ last_heartbeat: outside }), NOW)).toBe(false);
  });

  it('is false for an unparsable timestamp rather than throwing', () => {
    expect(isReachable(node({ last_heartbeat: 'never' }), NOW)).toBe(false);
  });
});

describe('fleetCounts', () => {
  it('is all zeros for no nodes, and for a fetch that has not answered', () => {
    expect(fleetCounts([], NOW)).toEqual({ total: 0, reachable: 0, quarantined: 0, highRisk: 0 });
    expect(fleetCounts(undefined, NOW)).toEqual({ total: 0, reachable: 0, quarantined: 0, highRisk: 0 });
  });

  it('counts reachability, quarantine and high risk separately', () => {
    const fresh = new Date(NOW - 5_000).toISOString();
    const stale = new Date(NOW - 10 * 60_000).toISOString();
    const counts = fleetCounts(
      [
        node({ id: 'a', last_heartbeat: fresh, risk_score: 90 }),
        node({ id: 'b', last_heartbeat: fresh, is_quarantined: 1, risk_score: 80 }),
        node({ id: 'c', last_heartbeat: stale, risk_score: 10 }),
        node({ id: 'd', last_heartbeat: fresh, risk_score: null })
      ],
      NOW
    );

    expect(counts).toEqual({ total: 4, reachable: 3, quarantined: 1, highRisk: 2 });
  });

  it('does not count a node that was never scored as low risk', () => {
    // `(risk_score || 0) > 75` made an unscored node a scored one at zero. A
    // node nobody has assessed is not a safe node.
    const counts = fleetCounts([node({ id: 'a', risk_score: null }), node({ id: 'b' })], NOW);
    expect(counts.highRisk).toBe(0);
    expect(counts.total).toBe(2);
  });
});
