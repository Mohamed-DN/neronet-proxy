import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';
import { clearSession, storeSession } from './authToken';
import { resetConnectionState } from './connection';

/**
 * The adapter the pages still call, over a stubbed transport. Only the account
 * self-destruct is left in it; the rest moved to the query hooks with their pages.
 */

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

  it('throws when a write fails instead of reporting it done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('connection refused');
      })
    );

    await expect(api.nuke.userSelfDestruct('DELETE MY ACCOUNT', true)).rejects.toThrow();
  });

  it('still refuses a self-destruct without the exact confirmation', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(api.nuke.userSelfDestruct('delete my account', true)).rejects.toThrow();
    await expect(api.nuke.userSelfDestruct('DELETE MY ACCOUNT', false)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
