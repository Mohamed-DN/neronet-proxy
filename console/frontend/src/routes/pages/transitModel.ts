import { isDefaultCompartment } from '../../services/compartmentLabel';
import type { Compartment, TopologyLink, TopologyNode } from '../../services/types';
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
  /** True when the map draws it once as an interchange or terminus shared by several lines. */
  shared: boolean;
}

/** A gateway or exit that serves devices on several lines: drawn once, with each of those lines through it. */
export interface TransitHubModel extends Omit<TransitStationModel, 'role' | 'shared'> {
  role: Exclude<StationRole, 'device'>;
  kind: 'interchange' | 'terminus';
  /** The lines it serves, in the order the lines are drawn. */
  lineKeys: string[];
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
  /** The compartment id, or null for the devices that belong to no sub-network. */
  id: string | null;
  label: string;
  colour: LineColour;
  /** True when the colour was chosen (`line_colour`), false when the index picked it. */
  colourChosen: boolean;
  /** The organisation's default line: it cannot be deleted or merged away. */
  isDefault: boolean;
  stations: TransitStationModel[];
  tally: Tally;
}

export interface TransitModel {
  lines: TransitLineModel[];
  /** Gateways and exits shared by two or more lines. Each is also listed under its own sub-network. */
  hubs: TransitHubModel[];
  tally: Tally;
}

export interface TransitOptions {
  noSubnetLabel: string;
  /** Draw gateways that serve several lines as shared interchanges. Off when the map collapses. */
  shareHubs?: boolean;
  /** The topology's links: a link relayed by a gateway makes it serve both ends. */
  links?: TopologyLink[];
  /**
   * The sub-networks themselves. Their `line_colour` colours the line when set, and their
   * `sort_order` sets the order of the lines when the operator has arranged them.
   */
  compartments?: Pick<Compartment, 'id' | 'name' | 'slug' | 'line_colour' | 'sort_order'>[];
  /** Also draw the lines that have no device yet (the editor shows them as places to move devices to). */
  includeEmpty?: boolean;
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
 * Lines in the operator's order (`sort_order`) when the sub-networks say one, otherwise in
 * order of size (largest first, then by key). Each line has the colour it was given, or else
 * the one taken by its key's place in sorted order, so a line keeps its colour when another
 * one grows past it. Stations are sorted by name then id.
 */
export function buildTransit(nodes: TopologyNode[], now: number, options: TransitOptions): TransitModel {
  const groups = new Map<string, { label: string; nodes: TopologyNode[] }>();
  for (const node of nodes) {
    const { key, label } = groupValue(node, 'compartment');
    const group = groups.get(key) ?? { label: label || options.noSubnetLabel, nodes: [] };
    group.nodes.push(node);
    groups.set(key, group);
  }

  const lineOf = new Map<string, string>();
  for (const [key, group] of groups) for (const node of group.nodes) lineOf.set(node.id, key);

  const known = new Map((options.compartments ?? []).map((compartment) => [compartment.id, compartment]));
  const keys = [...groups.keys()].sort(byCodePoint);
  // The automatic colour is the key's place among the lines that have devices, as it always was;
  // an empty line (shown only while editing) takes the next ones, so nothing else changes colour.
  const colourOf = new Map<string, LineColour>(
    keys.map((key, index) => [key, LINE_COLOURS[index % LINE_COLOURS.length]!])
  );
  if (options.includeEmpty) {
    const empty = [...known.values()].filter((compartment) => !groups.has(compartment.id));
    empty.sort((a, b) => byCodePoint(a.id, b.id));
    empty.forEach((compartment, index) => {
      groups.set(compartment.id, { label: compartment.name || options.noSubnetLabel, nodes: [] });
      colourOf.set(compartment.id, LINE_COLOURS[(keys.length + index) % LINE_COLOURS.length]!);
      keys.push(compartment.id);
    });
  }
  const chosen = new Set<string>();
  for (const key of keys) {
    const colour = known.get(key)?.line_colour;
    if (colour && (LINE_COLOURS as readonly string[]).includes(colour)) {
      colourOf.set(key, colour);
      chosen.add(key);
    }
  }
  const tally = emptyTally();
  const served =
    options.shareHubs === false ? new Map<string, string[]>() : servedLines(nodes, lineOf, options.links ?? []);

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
        return {
          id: node.id,
          name: node.name || node.id,
          status,
          role,
          symbol: symbolOf(status, role),
          shared: served.has(node.id)
        };
      });
    return {
      key,
      id: key === '__none__' ? null : key,
      label: group.label,
      colour: colourOf.get(key)!,
      colourChosen: chosen.has(key),
      isDefault: known.has(key) ? isDefaultCompartment(known.get(key)!) : false,
      stations,
      tally: lineTally
    };
  });

  // The operator's order wins where there is one; lines it does not know come after, by size.
  const position = (line: TransitLineModel) => known.get(line.key)?.sort_order;
  lines.sort((a, b) => {
    const pa = position(a);
    const pb = position(b);
    if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb;
    if ((pa === undefined) !== (pb === undefined)) return pa === undefined ? 1 : -1;
    return b.stations.length - a.stations.length || byCodePoint(a.key, b.key);
  });
  const order = new Map(lines.map((line, index) => [line.key, index]));

  const hubs: TransitHubModel[] = [];
  for (const line of lines) {
    for (const station of line.stations) {
      const keysServed = served.get(station.id);
      if (!keysServed || station.role === 'device') continue;
      hubs.push({
        id: station.id,
        name: station.name,
        status: station.status,
        role: station.role,
        symbol: station.symbol,
        kind: station.role === 'exit' ? 'terminus' : 'interchange',
        lineKeys: [...keysServed].sort((a, b) => order.get(a)! - order.get(b)!)
      });
    }
  }
  hubs.sort((a, b) => byCodePoint(a.name.toLowerCase(), b.name.toLowerCase()) || byCodePoint(a.id, b.id));
  return { lines, hubs, tally };
}

/**
 * The lines each gateway or exit serves, kept only where there are two or more: the
 * devices that name it as their gateway (`gateway_node_id`), the two ends of a link it
 * relays, and its own sub-network when other devices live there. A gateway that serves
 * one line stays a stop on it, drawn with the interchange symbol.
 */
function servedLines(nodes: TopologyNode[], lineOf: Map<string, string>, links: TopologyLink[]): Map<string, string[]> {
  const gateways = new Map<string, TopologyNode>();
  for (const node of nodes) if (roleOf(node) !== 'device') gateways.set(node.id, node);

  const reached = new Map<string, Set<string>>();
  const reach = (gateway: string, node: string) => {
    const key = lineOf.get(node);
    if (key === undefined || !gateways.has(gateway)) return;
    const set = reached.get(gateway) ?? new Set<string>();
    set.add(key);
    reached.set(gateway, set);
  };
  for (const node of nodes) {
    if (typeof node.gateway_node_id === 'string' && node.gateway_node_id !== node.id) {
      reach(node.gateway_node_id, node.id);
    }
  }
  for (const link of links) {
    if (typeof link.relay_id !== 'string') continue;
    reach(link.relay_id, link.source);
    reach(link.relay_id, link.target);
  }

  const members = new Map<string, number>();
  for (const node of nodes) {
    const key = lineOf.get(node.id)!;
    members.set(key, (members.get(key) ?? 0) + 1);
  }

  const out = new Map<string, string[]>();
  for (const [id, set] of reached) {
    const own = lineOf.get(id)!;
    // Its own sub-network counts when somebody else lives there too.
    if ((members.get(own) ?? 0) > 1) set.add(own);
    else set.delete(own);
    if (set.size >= 2) out.set(id, [...set]);
  }
  return out;
}
