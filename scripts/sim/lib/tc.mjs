// The tc script a sidecar runs to shape one container's egress.
//
// One htb class per peer, each with a netem leaf, and a u32 filter that steers packets
// by destination address into the class. htb rather than prio because prio is limited
// to 16 bands and a fleet of 60 has 66 peers. Traffic to an address that is not a
// peer, and everything on the loopback interface, takes the default class untouched.
//
// Every entity shapes its own egress with the one-way values of the plan, so a round
// trip between two entities is the sum of both directions.

const fixed = (value, places) => Number(value).toFixed(places);

const hex = (n) => n.toString(16);

/** Root qdisc removal, shared by the reset and the setup so both are idempotent. */
const HEADER = [
  'set -eu',
  "IF=$(ip -o -4 route show default | awk '{print $5}' | head -n 1)",
  '[ -n "$IF" ] || { echo "no default route, no interface to shape" >&2; exit 1; }',
  'tc qdisc del dev "$IF" root 2>/dev/null || true'
];

export function resetScript() {
  return [...HEADER, 'echo "reset $IF"', ''].join('\n');
}

/**
 * @param peers  [{id, ip}] every other entity of the fleet
 * @param pairOf function (peerId) => plan pair {one_way_ms, jitter_ms, loss_pct}
 */
export function shapeScript(peers, pairOf) {
  if (peers.length > 4000) throw new Error('too many peers for one htb tree');

  const lines = [...HEADER];
  lines.push('tc qdisc add dev "$IF" root handle 1: htb default 1');
  lines.push('tc class add dev "$IF" parent 1: classid 1:1 htb rate 40gbit quantum 60000');

  peers.forEach((peer, i) => {
    const pair = pairOf(peer.id);
    if (!pair) throw new Error(`the plan has no pair for ${peer.id}`);

    const minor = hex(i + 16);
    const netem = [`delay ${fixed(pair.one_way_ms, 1)}ms`];
    if (pair.jitter_ms > 0) netem.push(`${fixed(pair.jitter_ms, 1)}ms`);
    if (pair.loss_pct > 0) netem.push(`loss ${fixed(pair.loss_pct, 3)}%`);
    netem.push('limit 10000');

    lines.push(`tc class add dev "$IF" parent 1: classid 1:${minor} htb rate 40gbit quantum 60000`);
    lines.push(`tc qdisc add dev "$IF" parent 1:${minor} handle ${minor}: netem ${netem.join(' ')}`);
    lines.push(`tc filter add dev "$IF" parent 1: protocol ip prio 1 u32 match ip dst ${peer.ip}/32 flowid 1:${minor}`);
  });

  lines.push(`echo "shaped $IF: ${peers.length} peers"`, '');
  return lines.join('\n');
}
