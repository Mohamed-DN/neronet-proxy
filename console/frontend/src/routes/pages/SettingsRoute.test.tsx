import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AuthContext, { type AuthValue } from '../../context/AuthContext';
import { createQueryClient } from '../../services/queries/client';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { ShellProvider } from '../shell';
import SettingsRoute from './SettingsRoute';
import '../../i18n';

// The page used to keep every setting in local state and pretend to apply it. It now
// reads the organisation from the control plane and saves with PUT.

const user = { id: 'u1', username: 'owner', role: 'user', organization_id: 'org-a' };
const auth: AuthValue = {
  user,
  role: 'user',
  token: null,
  loading: false,
  isAuthenticated: true,
  switchRole: () => {},
  login: async () => user,
  completeMfaSignIn: async () => user,
  logout: async () => {},
  refreshUser: async () => {}
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function render(putStatus = 200) {
  const puts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/organizations/org-a' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return putStatus === 200
          ? json({ organization: { id: 'org-a', name: 'A', slug: 'a', ...body, profile: 'standard' } })
          : json({ error: 'Forbidden' }, putStatus);
      }
      if (url === '/api/organizations/org-a') {
        return json({
          organization: {
            id: 'org-a',
            name: 'A',
            slug: 'a',
            default_policy: 'deny',
            max_netmap_staleness_seconds: 300,
            profile: 'regulated'
          }
        });
      }
      if (url === '/api/organizations/org-a/modules') return json({ modules: [{ module_id: 'nuke', enabled: false }] });
      return json({});
    }) as unknown as typeof fetch
  );
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  const result = renderUI(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <ShellProvider>
          <MemoryRouter initialEntries={['/settings']}>
            <Routes>
              <Route path="/settings" element={<SettingsRoute />} />
            </Routes>
          </MemoryRouter>
        </ShellProvider>
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  return { ...result, puts };
}

describe('SettingsRoute', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows what the control plane holds, and passes axe', async () => {
    const { container } = render();
    expect(await screen.findByDisplayValue('300')).toBeInTheDocument();
    expect(screen.getByText('Regulated')).toBeInTheDocument();
    expect(screen.getByText('nuke')).toBeInTheDocument();
    expect(screen.queryByText(/VLESS Reality|ShadowTLS|QUIC MASQUE/)).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('saves through the API', async () => {
    const u = userEvent.setup();
    const { puts } = render();
    const input = await screen.findByDisplayValue('300');
    await u.clear(input);
    await u.type(input, '600');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ default_policy: 'deny', max_netmap_staleness_seconds: 600 }]));
  });

  it('says so when the caller may not change the settings', async () => {
    const u = userEvent.setup();
    render(403);
    await screen.findByDisplayValue('300');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Only the organisation's owners and admins/)).toBeInTheDocument();
  });
});
