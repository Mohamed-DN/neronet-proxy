import type { MeshNode } from '../services/types';

/** A device heard from inside this window, and healthy, counts as connected. Four minutes of slack on a phone's 25 s keepalive. */
export const CONNECTED_WITHIN_MS = 180_000;

export type DeviceStatus = 'blocked' | 'profile' | 'connected' | 'lastSeen' | 'never';

/**
 * When the device was last heard from: a phone or computer on the WireGuard app never
 * heartbeats, so for it this is the last handshake its gateway reported.
 */
export function seenAt(node: MeshNode): string | null | undefined {
  return node.device_kind === 'profile' ? node.last_handshake_at : node.last_heartbeat;
}

/**
 * What the person reads about one of their devices. Order matters: an
 * administrator's block outranks everything; a phone or computer that uses the
 * WireGuard app is judged by its gateway-reported handshake, and is "profile"
 * (not measured yet) rather than "never connected" when none was reported.
 */
export function deviceStatus(node: MeshNode, nowMs: number): DeviceStatus {
  if (node.is_quarantined) return 'blocked';
  const profile = node.device_kind === 'profile';
  const seen = seenAt(node);
  const heard = seen ? new Date(seen).getTime() : NaN;
  if (!Number.isFinite(heard)) return profile ? 'profile' : 'never';
  // A profile device's health flag is the value it was created with; only its handshake says anything.
  if ((profile || node.is_healthy) && nowMs - heard < CONNECTED_WITHIN_MS) return 'connected';
  return 'lastSeen';
}
