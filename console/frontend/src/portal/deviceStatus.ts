import type { MeshNode } from '../services/types';

/** A device heard from inside this window, and healthy, counts as connected. Four minutes of slack on a phone's 25 s keepalive. */
export const CONNECTED_WITHIN_MS = 180_000;

export type DeviceStatus = 'blocked' | 'profile' | 'connected' | 'lastSeen' | 'never';

/**
 * What the person reads about one of their devices. Order matters: an
 * administrator's block outranks everything; a phone or computer that uses the
 * WireGuard app is "profile" even though it never reports a heartbeat, so it is
 * not shown as "never connected".
 */
export function deviceStatus(node: MeshNode, nowMs: number): DeviceStatus {
  if (node.is_quarantined) return 'blocked';
  if (node.device_kind === 'profile') return 'profile';
  if (!node.last_heartbeat) return 'never';
  const heard = new Date(node.last_heartbeat).getTime();
  if (!Number.isFinite(heard)) return 'never';
  if (node.is_healthy && nowMs - heard < CONNECTED_WITHIN_MS) return 'connected';
  return 'lastSeen';
}
