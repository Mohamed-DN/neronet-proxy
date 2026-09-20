import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';
import { clearSession, storeSession } from './authToken';
import { resetConnectionState } from './connection';

/**
 * The adapter the pages still call, over a stubbed transport.
 *
 * These three moved here from services/features.test.js when api.js started
 * importing the TypeScript request layer: `node --test` loads that file
 * directly and cannot resolve a .ts import. They assert the same behaviour.
 *
 * The rest asserts the two conventions the pages depend on, because the
 * fixtures that used to sit behind them are gone and the pages have not moved
 * to the query hooks yet: a failed read is null or an empty list, and a failed
 * write throws rather than reporting a success nobody can account for.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('api', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConnectionState();
    storeSession({ token: 'tok' });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('asks /api/features and returns what the server said', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        return jsonResponse({ cloud_pc: true });
      }) as unknown as typeof fetch
    );

    expect(await api.features.get()).toEqual({ cloud_pc: true });
    expect(seen).toEqual(['/api/features']);
  });

  it('reads an unreachable server as every feature off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('connection refused');
      })
    );

    expect(await api.features.get()).toEqual({ cloud_pc: false });
  });

  it('reads an error status as every feature off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 500))
    );

    expect(await api.features.get()).toEqual({ cloud_pc: false });
  });

  it('returns an empty list, not fixtures, when a list endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('connection refused');
      })
    );

    // Before WP-402 each of these answered out of the deleted fixture module.
    expect(await api.nodes.list()).toEqual([]);
    expect(await api.users.list()).toEqual([]);
    expect(await api.peering.list()).toEqual([]);
    expect(await api.geofencing.listPolicies()).toEqual([]);
    expect(await api.cloudPc.list()).toEqual([]);
    expect(await api.audit.list()).toEqual([]);
    expect(await api.risk.listEvents()).toEqual([]);
  });

  it('returns null, not a fixture, when a single-object read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('connection refused');
      })
    );

    expect(await api.nodes.get('n1')).toBeNull();
    expect(await api.stats.getOverview()).toBeNull();
    // This one reported an armed dead man's switch and a valid warrant canary
    // on a deployment where neither was configured.
    expect(await api.nuke.getGlobalState()).toBeNull();
    expect(await api.nuke.getWarrantCanary()).toBeNull();
  });

  it('throws when a write fails instead of reporting it done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('connection refused');
      })
    );

    // Each of these used to mutate a JavaScript array and answer success.
    await expect(api.nodes.action('n1', 'quarantine', {})).rejects.toThrow();
    await expect(api.users.delete('u1')).rejects.toThrow();
    await expect(api.peering.accept('p1')).rejects.toThrow();
    await expect(api.acl.create({ action: 'allow' })).rejects.toThrow();
    await expect(api.nuke.userSelfDestruct('DELETE MY ACCOUNT', true)).rejects.toThrow();
    await expect(api.nuke.triggerOwnerWipe({ confirmationPhrase: 'x', password: 'y' })).rejects.toThrow();
  });

  it('refuses to mint a device profile the control plane never issued', async () => {
    // The fallback generated a Curve25519 key in the browser and returned a
    // complete WireGuard profile for a node the control plane had not enrolled.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'not found' }, 404))
    );

    await expect(api.configs.generate({ name: 'laptop' })).rejects.toThrow();
    await expect(api.users.generateQrOnboarding('u1')).rejects.toThrow();
    await expect(api.peering.generateToken({ scope_mode: 'ALL' })).rejects.toThrow();
  });

  it('still refuses a self-destruct without the exact confirmation', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(api.nuke.userSelfDestruct('delete my account', true)).rejects.toThrow();
    await expect(api.nuke.userSelfDestruct('DELETE MY ACCOUNT', false)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
