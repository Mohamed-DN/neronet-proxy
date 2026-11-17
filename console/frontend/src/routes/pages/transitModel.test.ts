import { describe, expect, it } from 'vitest';

import type { TopologyNode } from '../../services/types';
import { buildTransit } from './transitModel';

const NOW = Date.parse('2026-11-17T10:00:00Z');
const RECENT = new Date(NOW - 20_000).toISOString();

function node(id: string, compartment: string, extra: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id,
    name: id,
    role: 'CLIENT_ORIGIN',
    country: 'IT',
    overlay_ipv4: null,
    is_healthy: true,
    is_quarantined: false,
    latency_ms: null,
    compartment_id: `cmp-${compartment}`,
    compartment_name: compartment,
    is_ghost_vault: false,
    last_seen_at: RECENT,
    ...extra
  };
}

const options = { noSubnetLabel: 'No sub-network' };

describe('buildTransit: interchanges and termini', () => {
  it('makes a gateway shared when devices on two lines use it, and lists it once under its own line', () => {
    const nodes = [
      node('gw', 'Lab', { is_profile_gateway: true }),
      node('lab-1', 'Lab', { device_kind: 'profile', gateway_node_id: 'gw' }),
      node('off-1', 'Office', { device_kind: 'profile', gateway_node_id: 'gw' })
    ];
    const model = buildTransit(nodes, NOW, options);
    expect(model.hubs).toHaveLength(1);
    expect(model.hubs[0]).toMatchObject({ id: 'gw', kind: 'interchange', symbol: 'interchange' });
    expect([...model.hubs[0]!.lineKeys].sort()).toEqual(['cmp-Lab', 'cmp-Office']);
    expect(model.lines.flatMap((line) => line.stations.filter((s) => s.shared).map((s) => s.id))).toEqual(['gw']);
    expect(model.tally.total).toBe(3);
  });

  it('keeps a gateway that serves one line as a stop on it, with the interchange symbol', () => {
    const nodes = [
      node('gw', 'Lab', { is_profile_gateway: true }),
      node('lab-1', 'Lab', { device_kind: 'profile', gateway_node_id: 'gw' }),
      node('off-1', 'Office')
    ];
    const model = buildTransit(nodes, NOW, options);
    expect(model.hubs).toHaveLength(0);
    const lab = model.lines.find((line) => line.key === 'cmp-Lab')!;
    expect(lab.stations.find((s) => s.id === 'gw')).toMatchObject({ shared: false, symbol: 'interchange' });
  });

  it('makes an exit a terminus shared by every line whose links it relays', () => {
    const nodes = [node('out', 'Lab', { role: 'EXIT_BRIDGE' }), node('a', 'Lab'), node('b', 'Office')];
    const model = buildTransit(nodes, NOW, {
      ...options,
      links: [{ source: 'a', target: 'b', relay_id: 'out' }]
    });
    expect(model.hubs).toHaveLength(1);
    expect(model.hubs[0]).toMatchObject({ id: 'out', kind: 'terminus', symbol: 'terminus' });
    expect(model.hubs[0]!.lineKeys).toHaveLength(2);
  });

  it('shares nothing when asked not to, and ignores a relay that is not a gateway', () => {
    const nodes = [
      node('gw', 'Lab', { is_profile_gateway: true }),
      node('lab-1', 'Lab', { device_kind: 'profile', gateway_node_id: 'gw' }),
      node('off-1', 'Office', { device_kind: 'profile', gateway_node_id: 'gw' })
    ];
    expect(buildTransit(nodes, NOW, { ...options, shareHubs: false }).hubs).toHaveLength(0);
    const plain = [node('a', 'Lab'), node('b', 'Office'), node('c', 'Office')];
    const links = [{ source: 'a', target: 'b', relay_id: 'c' }];
    expect(buildTransit(plain, NOW, { ...options, links }).hubs).toEqual([]);
  });
});
