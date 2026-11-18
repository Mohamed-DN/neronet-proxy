import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuthContext, { type AuthValue } from '../../../context/AuthContext';
import { clearSession, storeSession } from '../../../services/authToken';
import { createQueryClient } from '../../../services/queries/client';
import type { Compartment, TopologyNode } from '../../../services/types';
import { renderUI } from '../../../test/harness';
import { ShellProvider } from '../../shell';
import { TopologyRoute } from '../TopologyRoute';
import '../../../i18n';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const node = (id: string, compartment: [string, string]): TopologyNode => ({
  id,
  name: id,
  role: 'CLIENT_ORIGIN',
  country: 'IT',
  overlay_ipv4: '100.64.0.2',
  is_healthy: true,
  is_quarantined: false,
  latency_ms: 10,
  compartment_id: compartment[0],
  compartment_name: compartment[1],
  is_ghost_vault: false,
  last_seen_at: new Date(Date.now() - 20_000).toISOString()
});

const COMPARTMENTS: Compartment[] = ['Lab', 'Office'].map((name, i) => ({
  id: `cmp-${name.toLowerCase()}`,
  organization_id: 'org-default',
  name,
  slug: name.toLowerCase(),
  subnet_cidr: '100.64.0.0/24',
  is_hidden: false,
  line_colour: i === 0 ? 'blue' : null,
  sort_order: i
}));

function authAs(orgRole: string): AuthValue {
  const user = { id: `usr-${orgRole}`, username: orgRole, role: 'user', org_role: orgRole } as unknown as NonNullable<
    AuthValue['user']
  >;
  return {
    user,
    role: 'user',
    token: 'test-token',
    loading: false,
    isAuthenticated: true,
    switchRole: () => {},
    login: async () => user,
    completeMfaSignIn: async () => user,
    logout: async () => {},
    refreshUser: async () => {}
  };
}

function renderTopology(role: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/stats/topology') {
        return json({
          nodes: [node('lab-1', ['cmp-lab', 'Lab']), node('office-1', ['cmp-office', 'Office'])],
          links: []
        });
      }
      if (url === '/api/compartments') return json({ compartments: COMPARTMENTS });
      if (url === '/api/compartments/peerings/list') return json({ peerings: [] });
      return json({});
    }) as unknown as typeof fetch
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <AuthContext.Provider value={authAs(role)}>
      <QueryClientProvider client={queryClient}>
        <ShellProvider>
          <MemoryRouter initialEntries={['/topology']}>
            <Routes>
              <Route path="/topology" element={<TopologyRoute />} />
            </Routes>
          </MemoryRouter>
        </ShellProvider>
      </QueryClientProvider>
    </AuthContext.Provider>
  );
}

describe('map editor on the topology page', () => {
  beforeEach(() => {
    localStorage.clear();
    storeSession({ token: 'test-token' });
  });
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('gives a member no way in', async () => {
    renderTopology('member');
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/compartments', expect.anything()));
    expect(screen.queryByRole('button', { name: 'Edit the map' })).not.toBeInTheDocument();
  });

  it('lets a network admin choose devices from the list, with the same banner and the same move', async () => {
    const user = userEvent.setup();
    renderTopology('network_admin');
    await user.click(await screen.findByRole('button', { name: 'Edit the map' }));

    const banner = await screen.findByTestId('map-editor-banner');
    expect(within(banner).getByText('You are editing the network: changes alter who can reach whom.')).toBeVisible();

    const panel = await screen.findByTestId('map-editor-panel');
    await user.click(within(panel).getByRole('checkbox', { name: 'lab-1' }));
    expect(within(banner).getByText('1 device chosen')).toBeVisible();
    await user.click(within(banner).getByRole('button', { name: 'Move to…' }));
    const picker = await screen.findByRole('dialog', { name: 'Move to…' });
    // The line the device is on is no place to move it to; the other one is.
    expect(within(picker).queryByRole('button', { name: /^Lab/ })).not.toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: /Office/ })).toBeVisible();
  });
});
