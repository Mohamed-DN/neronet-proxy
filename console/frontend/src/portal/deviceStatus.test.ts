import { describe, expect, it } from 'vitest';

import type { MeshNode } from '../services/types';
import { CONNECTED_WITHIN_MS, deviceStatus, seenAt } from './deviceStatus';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function device(partial: Partial<MeshNode>): MeshNode {
  return { id: 'd1', ...partial };
}

describe('deviceStatus', () => {
  it('is blocked when an administrator has quarantined the device', () => {
    expect(deviceStatus(device({ is_quarantined: true, is_healthy: true, last_heartbeat: ago(1_000) }), NOW)).toBe(
      'blocked'
    );
  });

  it('is profile (not measured) for a WireGuard-app device its gateway never reported', () => {
    expect(deviceStatus(device({ device_kind: 'profile', last_handshake_at: null }), NOW)).toBe('profile');
  });

  it('a profile device is judged by its handshake, never by a heartbeat time', () => {
    expect(deviceStatus(device({ device_kind: 'profile', last_heartbeat: ago(1_000) }), NOW)).toBe('profile');
  });

  it('a profile device whose gateway saw a handshake inside three minutes is connected', () => {
    expect(deviceStatus(device({ device_kind: 'profile', last_handshake_at: ago(179_000) }), NOW)).toBe('connected');
  });

  it('a profile device whose last handshake is older than three minutes is lastSeen', () => {
    expect(deviceStatus(device({ device_kind: 'profile', last_handshake_at: ago(181_000) }), NOW)).toBe('lastSeen');
  });

  it('seenAt reads the handshake of a profile device and the heartbeat of any other', () => {
    expect(seenAt(device({ device_kind: 'profile', last_handshake_at: ago(5), last_heartbeat: ago(9) }))).toBe(ago(5));
    expect(seenAt(device({ last_heartbeat: ago(9), last_handshake_at: ago(5) }))).toBe(ago(9));
  });

  it('blocked wins over profile', () => {
    expect(deviceStatus(device({ device_kind: 'profile', is_quarantined: 1 }), NOW)).toBe('blocked');
  });

  it('is never when the control plane has never heard from the device', () => {
    expect(deviceStatus(device({ is_healthy: true, last_heartbeat: null }), NOW)).toBe('never');
    expect(deviceStatus(device({ last_heartbeat: 'not a time' }), NOW)).toBe('never');
  });

  it('is connected when healthy and heard inside the window', () => {
    expect(deviceStatus(device({ is_healthy: true, last_heartbeat: ago(CONNECTED_WITHIN_MS - 1_000) }), NOW)).toBe(
      'connected'
    );
  });

  it('heartbeat 181 s ago is lastSeen, not connected', () => {
    expect(CONNECTED_WITHIN_MS).toBe(180_000);
    expect(deviceStatus(device({ is_healthy: true, last_heartbeat: ago(181_000) }), NOW)).toBe('lastSeen');
  });

  it('is lastSeen when heard recently but not healthy', () => {
    expect(deviceStatus(device({ is_healthy: false, last_heartbeat: ago(5_000) }), NOW)).toBe('lastSeen');
    expect(deviceStatus(device({ is_healthy: 0, last_heartbeat: ago(5_000) }), NOW)).toBe('lastSeen');
  });
});
