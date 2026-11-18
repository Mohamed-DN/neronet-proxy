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

describe('buildTransit: the operator’s colours and order', () => {
  const nodes = [node('a1', 'Alpha'), node('a2', 'Alpha'), node('b1', 'Beta'), node('c1', 'Gamma')];
  const compartment = (name: string, extra: Record<string, unknown> = {}) => ({
    id: `cmp-${name}`,
    name,
    slug: name.toLowerCase(),
    ...extra
  });

  it('uses line_colour when it is set and the index fallback otherwise', () => {
    const model = buildTransit(nodes, NOW, {
      ...options,
      compartments: [compartment('Alpha'), compartment('Beta', { line_colour: 'violet' }), compartment('Gamma')]
    });
    const byKey = Object.fromEntries(model.lines.map((line) => [line.key, line]));
    // Fallback: the key's place in sorted order (Alpha 0 red, Beta 1 green, Gamma 2 blue).
    expect(byKey['cmp-Alpha']).toMatchObject({ colour: 'red', colourChosen: false });
    expect(byKey['cmp-Beta']).toMatchObject({ colour: 'violet', colourChosen: true });
    expect(byKey['cmp-Gamma']).toMatchObject({ colour: 'blue', colourChosen: false });
  });

  it('ignores a colour that is not one of the six tokens', () => {
    const model = buildTransit(nodes, NOW, {
      ...options,
      compartments: [compartment('Alpha', { line_colour: '#ff00ff' })]
    });
    expect(model.lines.find((line) => line.key === 'cmp-Alpha')).toMatchObject({ colour: 'red', colourChosen: false });
  });

  it('keeps today’s colours and order when no compartment is given', () => {
    const model = buildTransit(nodes, NOW, options);
    expect(model.lines.map((line) => [line.key, line.colour])).toEqual([
      ['cmp-Alpha', 'red'],
      ['cmp-Beta', 'green'],
      ['cmp-Gamma', 'blue']
    ]);
  });

  it('orders the lines by sort_order when the operator arranged them', () => {
    const model = buildTransit(nodes, NOW, {
      ...options,
      compartments: [
        compartment('Alpha', { sort_order: 2 }),
        compartment('Beta', { sort_order: 0 }),
        compartment('Gamma', { sort_order: 1 })
      ]
    });
    expect(model.lines.map((line) => line.key)).toEqual(['cmp-Beta', 'cmp-Gamma', 'cmp-Alpha']);
  });

  it('puts lines without a sort_order after the arranged ones, by size', () => {
    const model = buildTransit(nodes, NOW, {
      ...options,
      compartments: [compartment('Gamma', { sort_order: 0 })]
    });
    expect(model.lines.map((line) => line.key)).toEqual(['cmp-Gamma', 'cmp-Alpha', 'cmp-Beta']);
  });

  it('falls back to size when every sort_order is the same', () => {
    const model = buildTransit(nodes, NOW, {
      ...options,
      compartments: [
        compartment('Alpha', { sort_order: 0 }),
        compartment('Beta', { sort_order: 0 }),
        compartment('Gamma', { sort_order: 0 })
      ]
    });
    expect(model.lines.map((line) => line.key)).toEqual(['cmp-Alpha', 'cmp-Beta', 'cmp-Gamma']);
  });

  it('draws a line with no device only when asked, after the others and without moving their colours', () => {
    const compartments = [compartment('Alpha'), compartment('Beta'), compartment('Gamma'), compartment('Delta')];
    const plain = buildTransit(nodes, NOW, { ...options, compartments });
    expect(plain.lines.map((line) => line.key)).not.toContain('cmp-Delta');
    const withEmpty = buildTransit(nodes, NOW, { ...options, compartments, includeEmpty: true });
    expect(withEmpty.lines.find((line) => line.key === 'cmp-Delta')).toMatchObject({
      stations: [],
      id: 'cmp-Delta',
      label: 'Delta'
    });
    for (const line of plain.lines) {
      expect(withEmpty.lines.find((other) => other.key === line.key)!.colour).toBe(line.colour);
    }
    expect(withEmpty.tally.total).toBe(plain.tally.total);
  });

  it('knows the default line, which cannot be deleted', () => {
    const model = buildTransit([node('a1', 'Alpha')], NOW, {
      ...options,
      compartments: [{ id: 'cmp-Alpha', name: 'Alpha', slug: 'default' }]
    });
    expect(model.lines[0]).toMatchObject({ id: 'cmp-Alpha', isDefault: true });
  });
});
