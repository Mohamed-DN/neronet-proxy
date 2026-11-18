import type { TFunction } from 'i18next';

import { effectiveRole, type RoleUser } from '../../../services/roles';
import type { LineColour, ReachPreviewNode } from '../../../services/types';
import type { TransitLineModel } from '../transitModel';

/*
 * What the map editor works from, and who may use it. The rules mirror the API
 * (console/backend/routes/compartments.js): owners, admins and network admins change lines,
 * move devices and cut lines; only owners and admins merge or delete one. The platform
 * super-admin passes every role check on the server and therefore here.
 */

export interface EditorStation {
  id: string;
  name: string;
}

export interface EditorLine {
  /** The map's key for the line: the compartment id, or `__none__`. */
  key: string;
  /** The compartment id; null for the devices that belong to no sub-network (not editable). */
  id: string | null;
  label: string;
  colour: LineColour;
  colourChosen: boolean;
  isDefault: boolean;
  stations: EditorStation[];
}

export function toEditorLines(lines: TransitLineModel[]): EditorLine[] {
  return lines.map((line) => ({
    key: line.key,
    id: line.id,
    label: line.label,
    colour: line.colour,
    colourChosen: line.colourChosen,
    isDefault: line.isDefault,
    stations: line.stations.map((station) => ({ id: station.id, name: station.name }))
  }));
}

/** Who sees "Modifica la mappa": the roles the API lets change lines. */
export function canEditMap(user: RoleUser | null): boolean {
  const role = effectiveRole(user);
  return role === 'super-admin' || role === 'owner' || role === 'admin' || role === 'network_admin';
}

/** Who may merge or delete a line: the API asks for owner or admin. */
export function canMergeOrDelete(user: RoleUser | null): boolean {
  const role = effectiveRole(user);
  return role === 'super-admin' || role === 'owner' || role === 'admin';
}

/** The line a station is on, by station id. */
export function lineOfStations(lines: EditorLine[]): Map<string, EditorLine> {
  const out = new Map<string, EditorLine>();
  for (const line of lines) for (const station of line.stations) out.set(station.id, line);
  return out;
}

/**
 * One device's change in plain words: "telefono-anna raggiungerà 3 dispositivi in più e non
 * raggiungerà più 2." The names behind the counts are listed apart (see `namesLine`).
 */
export function previewSentence(t: TFunction<'mapEditor'>, node: ReachPreviewNode): string {
  const gains = node.gains.count;
  const losses = node.losses.count;
  if (gains === 0 && losses === 0) return t('preview.same', { name: node.name });
  const parts: string[] = [];
  if (gains > 0) parts.push(t('preview.gain', { count: gains }));
  if (losses > 0) parts.push(t('preview.loss', { count: losses }));
  return t('preview.sentence', { name: node.name, what: parts.join(t('preview.join')) });
}

/** "In più: a, b, c e altri 4": the names the API returned (at most 20) and how many more there are. */
export function namesLine(
  t: TFunction<'mapEditor'>,
  kind: 'gainNames' | 'lossNames',
  change: { count: number; names: string[] }
): string | null {
  if (change.count === 0) return null;
  const rest = change.count - change.names.length;
  const names = change.names.join(', ');
  const text = rest > 0 && change.names.length > 0 ? `${names} ${t('preview.andMore', { count: rest })}` : names;
  return text ? t(`preview.${kind}`, { names: text }) : null;
}

/** The peers named in a sentence: "A, B e C". */
export function listPeers(peers: string[]): string {
  return peers.join(', ');
}
