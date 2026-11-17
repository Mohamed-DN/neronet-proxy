import type { TopologyNode } from '../../services/types';
import type { StationKind } from '../../ui/StationSymbol';
import { STATE_STATION, groupValue, nodeKind, nodeState } from './topologyGraph';

/*
 * What the overview draws, worked out from the same inventory the map page uses
 * (`useTopology`) and the same helpers that decide a device's state and kind.
 * A sub-network (compartment) is a line, a device is a station on it, a gateway
 * is an interchange and an exit to the internet is a terminus. No endpoint of
 * its own: nothing here fetches.
 */

/** Above this many devices each line collapses into one station with a count. */
export const COLLAPSE_ABOVE = 60;

/** The six line colours the tokens define, by index. */
export const LINE_COLOURS = ['red', 'green', 'blue', 'orange', 'violet', 'sky'] as const;
export type LineColour = (typeof LINE_COLOURS)[number];

export type StationStatusKind = Extract<StationKind, 'service' | 'interrupted' | 'unmeasured' | 'blocked'>;
export type StationRole = 'device' | 'gateway' | 'exit';

export interface TransitStationModel {
  id: string;
  name: string;
  status: StationStatusKind;
  role: StationRole;
  /** What is drawn: the kind's symbol while in service, the status's symbol otherwise. */
  symbol: StationKind;
}

export interface Tally {
  service: number;
  interrupted: number;
  unmeasured: number;
  blocked: number;
  total: number;
}

export interface TransitLineModel {
  key: string;
  label: string;
  colour: LineColour;
  stations: TransitStationModel[];
  tally: Tally;
}

export interface TransitModel {
  lines: TransitLineModel[];
  tally: Tally;
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const emptyTally = (): Tally => ({ service: 0, interrupted: 0, unmeasured: 0, blocked: 0, total: 0 });

function roleOf(node: TopologyNode): StationRole {
  if (node.role === 'EXIT_BRIDGE') return 'exit';
  return nodeKind(node) === 'gateway' ? 'gateway' : 'device';
}

function symbolOf(status: StationStatusKind, role: StationRole): StationKind {
  if (status !== 'service') return status;
  return role === 'exit' ? 'terminus' : role === 'gateway' ? 'interchange' : 'service';
}

/** The worst status of a set, for a station that stands for a whole line. */
export function worstStatus(tally: Tally): StationStatusKind {
  if (tally.blocked > 0) return 'blocked';
  if (tally.interrupted > 0) return 'interrupted';
  if (tally.service === 0 && tally.unmeasured > 0) return 'unmeasured';
  return 'service';
}

/**
 * Lines in order of size (largest first, then by key), each with its own colour
 * taken by the key's place in sorted order, so a line keeps its colour when
 * another one grows past it. Stations are sorted by name then id.
 */
export function buildTransit(nodes: TopologyNode[], now: number, options: { noSubnetLabel: string }): TransitModel {
  const groups = new Map<string, { label: string; nodes: TopologyNode[] }>();
  for (const node of nodes) {
    const { key, label } = groupValue(node, 'compartment');
    const group = groups.get(key) ?? { label: label || options.noSubnetLabel, nodes: [] };
    group.nodes.push(node);
    groups.set(key, group);
  }

  const keys = [...groups.keys()].sort(byCodePoint);
  const colourOf = new Map(keys.map((key, index) => [key, LINE_COLOURS[index % LINE_COLOURS.length]!]));
  const tally = emptyTally();

  const lines = keys.map((key): TransitLineModel => {
    const group = groups.get(key)!;
    const lineTally = emptyTally();
    const stations = [...group.nodes]
      .sort(
        (a, b) => byCodePoint((a.name || a.id).toLowerCase(), (b.name || b.id).toLowerCase()) || byCodePoint(a.id, b.id)
      )
      .map((node): TransitStationModel => {
        const status = STATE_STATION[nodeState(node, now)];
        const role = roleOf(node);
        lineTally[status] += 1;
        lineTally.total += 1;
        tally[status] += 1;
        tally.total += 1;
        return { id: node.id, name: node.name || node.id, status, role, symbol: symbolOf(status, role) };
      });
    return { key, label: group.label, colour: colourOf.get(key)!, stations, tally: lineTally };
  });

  lines.sort((a, b) => b.stations.length - a.stations.length || byCodePoint(a.key, b.key));
  return { lines, tally };
}
