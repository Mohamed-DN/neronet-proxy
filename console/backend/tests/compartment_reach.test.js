const { describe, it } = require('node:test');
const assert = require('node:assert');
const { previewMove, reachOf, peeringIndex } = require('../services/CompartmentReach');

const fleet = [
  { id: 'a', name: 'Alpha', compartment: 'c1' },
  { id: 'b', name: 'Bravo', compartment: 'c1' },
  { id: 'c', name: 'Charlie', compartment: 'c2' },
  { id: 'd', name: 'Delta', compartment: 'c3' },
  { id: 'q', name: 'Quarantined', compartment: 'c1', quarantined: true }
];

describe('CompartmentReach (pure)', () => {
  it('a device reaches its own compartment and allow-peered ones, never quarantined devices', () => {
    const joined = peeringIndex([{ src: 'c1', dst: 'c2' }]);
    assert.deepStrictEqual([...reachOf('a', fleet, joined)].sort(), ['b', 'c']);
    // The peering is symmetric.
    assert.deepStrictEqual([...reachOf('c', fleet, joined)].sort(), ['a', 'b']);
  });

  it('previews a move without changing its input', () => {
    const copy = JSON.parse(JSON.stringify(fleet));
    const out = previewMove({
      nodes: fleet,
      allowPeerings: [{ src: 'c1', dst: 'c2' }],
      nodeIds: ['a'],
      toCompartment: 'c3'
    });
    assert.deepStrictEqual(fleet, copy);
    const a = out.nodes[0];
    assert.strictEqual(a.node_id, 'a');
    assert.deepStrictEqual(a.losses.names, ['Bravo', 'Charlie']);
    assert.deepStrictEqual(a.gains.names, ['Delta']);
    assert.strictEqual(a.gains.count, 1);
    assert.strictEqual(a.losses.count, 2);
    assert.deepStrictEqual(out.summary, { nodes_moved: 1, gains: 1, losses: 2 });
  });

  it('moving a whole group together keeps the pairs inside the group', () => {
    const out = previewMove({ nodes: fleet, allowPeerings: [], nodeIds: ['a', 'b'], toCompartment: 'c9' });
    assert.strictEqual(out.nodes[0].losses.count, 0);
    assert.strictEqual(out.nodes[0].gains.count, 0);
    assert.strictEqual(out.summary.losses, 0);
  });

  it('caps the names at 20 but keeps the true count', () => {
    const many = [{ id: 'x', name: 'X', compartment: 'c1' }];
    for (let i = 0; i < 30; i++) many.push({ id: `p${i}`, name: `P${String(i).padStart(2, '0')}`, compartment: 'c2' });
    const out = previewMove({ nodes: many, allowPeerings: [], nodeIds: ['x'], toCompartment: 'c2' });
    assert.strictEqual(out.nodes[0].gains.count, 30);
    assert.strictEqual(out.nodes[0].gains.names.length, 20);
  });
});
