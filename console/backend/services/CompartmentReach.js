/**
 * Who a device can reach, as far as compartments decide it (ADR 0021).
 *
 * This is the same boundary AclEngine.compileFor applies: a device is offered the other
 * devices of its own organisation that are not quarantined and sit in its compartment or in
 * a compartment joined to it by an "allow" peering (both ways). ACL rules act inside that
 * boundary and are not part of this, so a preview built on it shows what a move changes at
 * the compartment level, which is the only part a move changes.
 *
 * Pure: it takes the fleet and the peerings as input and writes nothing, so a preview can
 * ask "what if" about a membership that does not exist yet.
 */

const MAX_NAMES = 20;

/** @param {Iterable<{src: string, dst: string}>} allowPeerings */
function peeringIndex(allowPeerings) {
  const joined = new Set();
  for (const p of allowPeerings) {
    joined.add(`${p.src}\u0000${p.dst}`);
    joined.add(`${p.dst}\u0000${p.src}`);
  }
  return (a, b) => a === b || joined.has(`${a}\u0000${b}`);
}

/**
 * The ids of the devices `nodeId` can reach.
 * @param {Array<{id: string, compartment: string, quarantined?: boolean}>} nodes
 */
function reachOf(nodeId, nodes, joined) {
  const self = nodes.find((n) => n.id === nodeId);
  if (!self) return new Set();
  const out = new Set();
  for (const n of nodes) {
    if (n.id === nodeId || n.quarantined) continue;
    if (joined(self.compartment, n.compartment)) out.add(n.id);
  }
  return out;
}

/** The fleet with some devices moved to another compartment. */
function withMoves(nodes, nodeIds, toCompartment) {
  const moving = new Set(nodeIds);
  return nodes.map((n) => (moving.has(n.id) ? { ...n, compartment: toCompartment } : n));
}

function namesOf(ids, byId) {
  return [...ids]
    .map((id) => byId.get(id) || id)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_NAMES);
}

/**
 * What moving `nodeIds` into `toCompartment` does to what each of them reaches.
 *
 * @returns {{nodes: Array, summary: object}} per moved device the devices it gains and
 *   loses (a count and up to 20 names each), and the number of distinct device pairs that
 *   start or stop being able to reach each other.
 */
function previewMove({ nodes, allowPeerings, nodeIds, toCompartment }) {
  const joined = peeringIndex(allowPeerings);
  const byId = new Map(nodes.map((n) => [n.id, n.name]));
  const after = withMoves(nodes, nodeIds, toCompartment);

  const gainedPairs = new Set();
  const lostPairs = new Set();
  const result = [];
  for (const id of nodeIds) {
    const before = reachOf(id, nodes, joined);
    const now = reachOf(id, after, joined);
    const gains = [...now].filter((x) => !before.has(x));
    const losses = [...before].filter((x) => !now.has(x));
    for (const g of gains) gainedPairs.add([id, g].sort().join('\u0000'));
    for (const l of losses) lostPairs.add([id, l].sort().join('\u0000'));
    result.push({
      node_id: id,
      name: byId.get(id) || id,
      reach_before: before.size,
      reach_after: now.size,
      gains: { count: gains.length, names: namesOf(gains, byId) },
      losses: { count: losses.length, names: namesOf(losses, byId) }
    });
  }
  return {
    nodes: result,
    summary: { nodes_moved: nodeIds.length, gains: gainedPairs.size, losses: lostPairs.size }
  };
}

module.exports = { previewMove, reachOf, peeringIndex, withMoves, MAX_NAMES };
